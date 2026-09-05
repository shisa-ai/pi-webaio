import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	DEFAULT_MAX_OUTPUT_CHARS,
	DEFAULT_WEBFETCH_BROWSER,
	DEFAULT_WEBFETCH_OS,
	DEFAULT_WEBFETCH_TIMEOUT_MS,
	fetchPage,
	redactErrorText,
	redactStaticWebFetchUrl,
	type StaticWebFetchOptions,
	type StaticWebFetchResult,
} from "./webfetch-api.ts";
import { redactSecrets } from "./redact.ts";

interface FetchToolParams extends StaticWebFetchOptions {
	url: string;
	verbose?: boolean;
}

interface BatchFetchToolParams {
	requests: FetchToolParams[];
	verbose?: boolean;
}

interface FetchResultDetails {
	ok: boolean;
	kind?: "content";
	url: string;
	finalUrl?: string;
	redirects: string[];
	httpStatus?: number;
	statusText?: string;
	contentType?: string;
	format?: string;
	charCount?: number;
	truncated?: boolean;
	title?: string;
	author?: string;
	published?: string;
	site?: string;
	language?: string;
	wordCount?: number;
	browser?: string;
	os?: string;
	downloadedBytes?: number;
	elapsedMs: number;
	browserEscalated?: false;
	remoteFallbackUsed?: false;
	persisted?: false;
	proxyUsed?: boolean;
	targetPinning?: "local" | "proxy-dependent";
	errorCode?: string;
	errorPhase?: string;
	retryable?: boolean;
	contentOmitted?: true;
}

interface FetchToolDetails extends FetchResultDetails {
	verbose?: boolean;
	maxChars?: number;
	fetchResult?: FetchResultDetails;
	started?: true;
	status?: "connecting" | "done" | "error";
	progress?: number;
	phase?: string;
	error?: true;
	errorText?: string;
	userErrorSummary?: string;
	toolOutputTruncated?: boolean;
}

interface SafeBatchRequestDetails {
	url: string;
	browser: string;
	os: string;
	maxChars: number;
	timeoutMs: number;
	format: string;
	removeImages: boolean;
	includeReplies: boolean | "extractors";
	proxy?: string;
}

interface BatchFetchResultDetails {
	total: number;
	succeeded: number;
	failed: number;
	batchConcurrency: number;
	items: Array<{
		index: number;
		request: SafeBatchRequestDetails;
		status: "done" | "error";
		progress: 1;
		result?: FetchResultDetails;
		error?: string;
	}>;
}

interface BatchProgressDetails {
	items: Array<{
		index: number;
		url: string;
		status: "done" | "error";
		progress: 1;
		error?: string;
	}>;
	total: number;
	completed: number;
	succeeded: number;
	failed: number;
	batchConcurrency: number;
}

interface BatchFetchToolDetails {
	total: number;
	completed: number;
	succeeded: number;
	failed: number;
	items: FetchResultDetails[];
	verbose?: boolean;
	started?: true;
	batchProgress?: BatchProgressDetails;
	batchResult?: BatchFetchResultDetails;
	spinnerTick?: number;
	toolOutputTruncated?: boolean;
}

const MAX_TOOL_OUTPUT_BYTES = 50_000;
const MAX_TOOL_OUTPUT_LINES = 2_000;
const OUTPUT_TRUNCATION_NOTICE = "[Tool output truncated to the Jouzu response limit.]";

const fetchProperties = {
	url: { type: "string", description: "URL to fetch (http/https only)" },
	browser: {
		type: "string",
		description:
			"Browser profile for TLS fingerprinting. Default: chrome_145. Examples: chrome_145, firefox_147, safari_26, edge_145, opera_127",
	},
	os: {
		type: "string",
		description: "OS profile for fingerprinting. Default: windows. Options: windows, macos, linux, android, ios",
	},
	headers: {
		type: "object",
		additionalProperties: { type: "string" },
		description: "Custom HTTP headers. Accept and Accept-Language are set automatically when omitted.",
	},
	maxChars: {
		type: "number",
		minimum: 1,
		maximum: 10_000_000,
		description: "Maximum extracted characters before the tool-wide response limit is applied. Default: 50000",
	},
	timeoutMs: {
		type: "number",
		minimum: 1,
		description: "Whole-call timeout in milliseconds. Default: 15000",
	},
	format: {
		type: "string",
		enum: ["markdown", "html", "text", "json", "raw"],
		description:
			"Output format. markdown is the default; html is cleaned HTML; text is plain text; json is pretty-printed JSON; raw is decoded textual input.",
	},
	removeImages: {
		type: "boolean",
		description: "Strip image references from extracted output. Default: false",
	},
	includeReplies: {
		anyOf: [{ type: "boolean" }, { const: "extractors" }],
		description: "Include replies/comments: extractors (default), true, or false",
	},
	proxy: {
		type: "string",
		description: "Proxy URL. Proxy-side destination enforcement depends on the selected proxy mode.",
	},
};

const fetchParameters = {
	type: "object",
	properties: {
		...fetchProperties,
		verbose: {
			type: "boolean",
			description: "Compatibility flag. Full content is always returned to the model and the terminal preview remains compact.",
		},
	},
	required: ["url"],
	additionalProperties: false,
} as unknown as ToolDefinition["parameters"];

const batchFetchParameters = {
	type: "object",
	properties: {
		requests: {
			type: "array",
			minItems: 1,
			maxItems: 20,
			items: {
				type: "object",
				properties: fetchProperties,
				required: ["url"],
				additionalProperties: false,
			},
			description: "Independent requests. Each item accepts the same options as web_fetch.",
		},
		verbose: {
			type: "boolean",
			description: "Compatibility flag. Full content is always returned to the model and the terminal preview remains compact.",
		},
	},
	required: ["requests"],
	additionalProperties: false,
} as unknown as ToolDefinition["parameters"];

function optionsFrom(params: FetchToolParams, signal: AbortSignal | undefined): StaticWebFetchOptions {
	return {
		browser: params.browser,
		os: params.os,
		headers: params.headers,
		proxy: params.proxy,
		timeoutMs: params.timeoutMs,
		maxChars: params.maxChars,
		format: params.format,
		removeImages: params.removeImages,
		includeReplies: params.includeReplies,
		signal,
	};
}

function detailsFrom(result: StaticWebFetchResult): FetchResultDetails {
	if (!result.ok) {
		return {
			ok: false,
			url: redactStaticWebFetchUrl(result.url),
			finalUrl: result.finalUrl ? redactStaticWebFetchUrl(result.finalUrl) : undefined,
			redirects: result.redirects.map(redactStaticWebFetchUrl),
			httpStatus: result.error.statusCode,
			elapsedMs: result.elapsedMs,
			errorCode: result.error.code,
			errorPhase: result.error.phase,
			retryable: result.error.retryable,
		};
	}
	return {
		ok: true,
		kind: "content",
		url: redactStaticWebFetchUrl(result.url),
		finalUrl: redactStaticWebFetchUrl(result.finalUrl),
		redirects: result.redirects.map(redactStaticWebFetchUrl),
		httpStatus: result.statusCode,
		statusText: redactSecrets(result.statusText),
		contentType: redactSecrets(result.contentType ?? ""),
		format: result.format,
		charCount: result.outputChars,
		truncated: result.truncated,
		title: redactSecrets(result.title),
		author: redactSecrets(result.author),
		published: redactSecrets(result.published),
		site: redactSecrets(result.site),
		language: redactSecrets(result.language),
		wordCount: result.wordCount,
		browser: result.browser,
		os: result.os,
		downloadedBytes: result.downloadedBytes,
		elapsedMs: result.elapsedMs,
		browserEscalated: result.browserEscalated,
		remoteFallbackUsed: result.remoteFallbackUsed,
		persisted: result.persisted,
		proxyUsed: result.proxyUsed,
		targetPinning: result.targetPinning,
		contentOmitted: true,
	};
}

function safeProxyDetails(proxy: string): string {
	try {
		const parsed = new URL(proxy);
		if (!["http:", "https:", "socks5:"].includes(parsed.protocol)) return "[REDACTED:proxy]";
		return redactStaticWebFetchUrl(parsed.href);
	} catch {
		return "[REDACTED:proxy]";
	}
}

function safeBatchRequestDetails(request: FetchToolParams): SafeBatchRequestDetails {
	return {
		url: redactStaticWebFetchUrl(request.url),
		browser: String(request.browser ?? DEFAULT_WEBFETCH_BROWSER),
		os: String(request.os ?? DEFAULT_WEBFETCH_OS),
		maxChars: request.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS,
		timeoutMs: request.timeoutMs ?? DEFAULT_WEBFETCH_TIMEOUT_MS,
		format: request.format ?? "markdown",
		removeImages: request.removeImages ?? false,
		includeReplies: request.includeReplies ?? "extractors",
		...(request.proxy ? { proxy: safeProxyDetails(request.proxy) } : {}),
	};
}

function singleToolDetails(
	params: FetchToolParams,
	result: StaticWebFetchResult,
	toolOutputTruncated: boolean,
): FetchToolDetails {
	const fetchResult = detailsFrom(result);
	const errorText = result.ok ? undefined : redactErrorText(responseText(result));
	return {
		...fetchResult,
		url: result.ok ? (fetchResult.finalUrl ?? fetchResult.url) : fetchResult.url,
		verbose: params.verbose ?? false,
		maxChars: params.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS,
		fetchResult: result.ok ? fetchResult : undefined,
		started: true,
		status: result.ok ? "done" : "error",
		progress: 1,
		phase: result.ok ? "done" : result.error.phase,
		error: result.ok ? undefined : true,
		errorText,
		userErrorSummary: result.ok ? undefined : redactErrorText(result.error.message),
		toolOutputTruncated,
	};
}

function truncateToolOutput(text: string): { text: string; truncated: boolean } {
	let bounded = text;
	let truncated = false;
	const lines = bounded.split("\n");
	if (lines.length > MAX_TOOL_OUTPUT_LINES) {
		bounded = lines.slice(0, MAX_TOOL_OUTPUT_LINES - 2).join("\n");
		truncated = true;
	}
	const encoder = new TextEncoder();
	const notice = `\n\n${OUTPUT_TRUNCATION_NOTICE}`;
	const byteLimit = MAX_TOOL_OUTPUT_BYTES - encoder.encode(notice).byteLength;
	if (encoder.encode(bounded).byteLength > byteLimit) {
		let low = 0;
		let high = bounded.length;
		while (low < high) {
			const midpoint = Math.ceil((low + high) / 2);
			if (encoder.encode(bounded.slice(0, midpoint)).byteLength <= byteLimit) low = midpoint;
			else high = midpoint - 1;
		}
		bounded = bounded.slice(0, low);
		if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
		truncated = true;
	}
	return truncated ? { text: `${bounded}${notice}`, truncated: true } : { text: bounded, truncated: false };
}

function responseText(result: StaticWebFetchResult): string {
	if (!result.ok) {
		const status = result.error.statusCode === undefined ? "" : ` (HTTP ${result.error.statusCode})`;
		return `Fetch failed [${result.error.code}]${status}: ${result.error.message}`;
	}
	const metadata = [
		`URL: ${result.url}`,
		`Final URL: ${result.finalUrl}`,
		`Status: ${result.statusCode}`,
		`Content-Type: ${result.contentType}`,
		`Format: ${result.format}`,
		`Characters: ${result.outputChars}${result.truncated ? " (truncated)" : ""}`,
	];
	if (result.title) metadata.push(`Title: ${result.title}`);
	if (result.author) metadata.push(`Author: ${result.author}`);
	return `${metadata.join("\n")}\n\n${result.content}`;
}

function progressText(url: string): string {
	return `Fetching ${redactStaticWebFetchUrl(url)} with the static fingerprinted transport...`;
}

type StaticFetcher = typeof fetchPage;

async function runBatch(
	requests: FetchToolParams[],
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<BatchFetchToolDetails> | undefined,
	fetcher: StaticFetcher = fetchPage,
): Promise<StaticWebFetchResult[]> {
	const results = new Array<StaticWebFetchResult>(requests.length);
	let nextIndex = 0;
	let completed = 0;
	const concurrency = Math.min(4, requests.length);
	const update = (): void => {
		const available = results.filter((result) => result !== undefined);
		const succeeded = available.filter((result) => result.ok).length;
		onUpdate?.({
			content: [{ type: "text", text: `Fetched ${completed}/${requests.length} URLs.` }],
			details: {
				total: requests.length,
				completed,
				succeeded,
				failed: completed - succeeded,
				items: available.map(detailsFrom),
			},
		});
	};
	update();
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (true) {
				if (signal?.aborted) return;
				const index = nextIndex;
				nextIndex += 1;
				if (index >= requests.length) return;
				const request = requests[index]!;
				results[index] = await fetcher(request.url, optionsFrom(request, signal));
				completed += 1;
				update();
			}
		}),
	);
	return results;
}

function batchResponseText(requests: FetchToolParams[], results: StaticWebFetchResult[]): string {
	return results
		.map((result, index) => `## ${index + 1}. ${redactStaticWebFetchUrl(requests[index]!.url)}\n\n${responseText(result)}`)
		.join("\n\n---\n\n");
}

function batchErrorText(result: Extract<StaticWebFetchResult, { ok: false }>): string {
	const status = result.error.statusCode === undefined ? "" : ` (HTTP ${result.error.statusCode})`;
	const message = redactErrorText(result.error.message);
	return `Fetch failed [${result.error.code}]${status}: ${message} (phase: ${result.error.phase}; retryable: ${result.error.retryable ? "yes" : "no"})`;
}

function batchResultDetails(
	requests: FetchToolParams[],
	results: StaticWebFetchResult[],
): BatchFetchResultDetails {
	const succeeded = results.filter((result) => result.ok).length;
	return {
		total: results.length,
		succeeded,
		failed: results.length - succeeded,
		batchConcurrency: Math.min(4, requests.length),
		items: results.map((result, index) => ({
			index,
			request: safeBatchRequestDetails(requests[index]!),
			status: result.ok ? "done" : "error",
			progress: 1,
			...(result.ok ? { result: detailsFrom(result) } : { error: batchErrorText(result) }),
		})),
	};
}

function createWebFetchTool(): ToolDefinition {
	return {
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch one HTTP(S) URL with a browser-like TLS fingerprint and local readable-content extraction. This tool does not execute JavaScript; use tff-fetch_url for rendered pages or bot walls.",
		promptSnippet:
			"web_fetch(url, browser?, os?, headers?, maxChars?, timeoutMs?, format?, removeImages?, includeReplies?, proxy?, verbose?): fetch browser-fingerprinted readable content without executing JavaScript",
		parameters: fetchParameters,
		executionMode: "parallel",
		async execute(_toolCallId, rawParams, signal, onUpdate) {
			const params = rawParams as unknown as FetchToolParams;
			const displayUrl = redactStaticWebFetchUrl(params.url);
			onUpdate?.({
				content: [{ type: "text", text: progressText(displayUrl) }],
				details: {
					ok: false,
					url: displayUrl,
					redirects: [],
					elapsedMs: 0,
					started: true,
					status: "connecting",
					progress: 0,
					phase: "connecting",
				},
			});
			const result = await fetchPage(params.url, optionsFrom(params, signal));
			const output = truncateToolOutput(responseText(result));
			return {
				content: [{ type: "text", text: output.text }],
				details: singleToolDetails(params, result, output.truncated),
			};
		},
		renderCall(args, theme) {
			const params = args as unknown as FetchToolParams;
			return new Text(
				`${theme.fg("toolTitle", "web_fetch")} ${theme.fg("accent", redactStaticWebFetchUrl(params.url))}`,
				0,
				0,
			);
		},
		renderResult(result, { isPartial }, theme) {
			const details = result.details as FetchToolDetails | undefined;
			if (isPartial) return new Text(theme.fg("muted", progressText(details?.url ?? "URL")), 0, 0);
			if (!details?.ok) {
				return new Text(theme.fg("error", `Fetch failed${details?.errorCode ? `: ${details.errorCode}` : ""}`), 0, 0);
			}
			const destination = details.finalUrl ?? details.url;
			const suffix = details.truncated ? ", truncated" : "";
			return new Text(theme.fg("success", `Fetched ${destination} (${details.charCount ?? 0} chars${suffix})`), 0, 0);
		},
	};
}

function createBatchWebFetchTool(): ToolDefinition {
	return {
		name: "batch_web_fetch",
		label: "batch_web_fetch",
		description:
			"Fetch two or more independent HTTP(S) URLs with bounded concurrency. Each request uses the same static transport and local extraction as web_fetch.",
		promptSnippet:
			"batch_web_fetch(requests, verbose?): fetch independent URLs concurrently without executing JavaScript",
		parameters: batchFetchParameters,
		executionMode: "parallel",
		async execute(_toolCallId, rawParams, signal, onUpdate) {
			const params = rawParams as unknown as BatchFetchToolParams;
			const updates = onUpdate as AgentToolUpdateCallback<BatchFetchToolDetails> | undefined;
			const results = await runBatch(params.requests, signal, updates);
			if (signal?.aborted) throw new DOMException("The batch fetch was aborted", "AbortError");
			const batchResult = batchResultDetails(params.requests, results);
			const batchProgress: BatchProgressDetails = {
				items: batchResult.items.map(({ index, request, status, progress, error }) => ({
					index,
					url: request.url,
					status,
					progress,
					...(error ? { error } : {}),
				})),
				total: batchResult.total,
				completed: batchResult.total,
				succeeded: batchResult.succeeded,
				failed: batchResult.failed,
				batchConcurrency: batchResult.batchConcurrency,
			};
			const output = truncateToolOutput(batchResponseText(params.requests, results));
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					total: batchResult.total,
					completed: batchResult.total,
					succeeded: batchResult.succeeded,
					failed: batchResult.failed,
					items: results.map(detailsFrom),
					verbose: params.verbose ?? false,
					started: true,
					batchProgress,
					batchResult,
					spinnerTick: 0,
					toolOutputTruncated: output.truncated,
				},
			};
		},
		renderCall(args, theme) {
			const params = args as unknown as BatchFetchToolParams;
			return new Text(
				`${theme.fg("toolTitle", "batch_web_fetch")} ${theme.fg("accent", `${params.requests.length} URLs`)}`,
				0,
				0,
			);
		},
		renderResult(result, { isPartial }, theme) {
			const details = result.details as BatchFetchToolDetails | undefined;
			if (isPartial) {
				return new Text(
					theme.fg("muted", `Fetched ${details?.completed ?? 0}/${details?.total ?? 0} URLs`),
					0,
					0,
				);
			}
			return new Text(
				theme.fg(
					details?.failed ? "warning" : "success",
					`Fetched ${details?.succeeded ?? 0}/${details?.total ?? 0} URLs${details?.failed ? `; ${details.failed} failed` : ""}`,
				),
				0,
				0,
			);
		},
	};
}

/** Register only Jouzu's static single and batch fetch tools. */
export default function registerJouzuWebfetch(pi: ExtensionAPI): void {
	pi.registerTool(createWebFetchTool());
	pi.registerTool(createBatchWebFetchTool());
}

export const __test__ = {
	batchResponseText,
	batchResultDetails,
	createBatchWebFetchTool,
	createWebFetchTool,
	detailsFrom,
	responseText,
	singleToolDetails,
	runBatch,
	truncateToolOutput,
};
