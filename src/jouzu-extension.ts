import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	fetchPage,
	redactStaticWebFetchUrl,
	type StaticWebFetchOptions,
	type StaticWebFetchResult,
} from "./webfetch-api.ts";

interface FetchToolParams extends StaticWebFetchOptions {
	url: string;
	verbose?: boolean;
}

interface BatchFetchToolParams {
	requests: FetchToolParams[];
	verbose?: boolean;
}

interface FetchToolDetails {
	ok: boolean;
	url: string;
	finalUrl?: string;
	status?: number;
	format?: string;
	charCount?: number;
	truncated?: boolean;
	errorCode?: string;
	toolOutputTruncated?: boolean;
}

interface BatchFetchToolDetails {
	total: number;
	completed: number;
	succeeded: number;
	failed: number;
	items: FetchToolDetails[];
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

function detailsFrom(result: StaticWebFetchResult): FetchToolDetails {
	if (!result.ok) {
		return {
			ok: false,
			url: result.url,
			finalUrl: result.finalUrl,
			status: result.error.statusCode,
			errorCode: result.error.code,
		};
	}
	return {
		ok: true,
		url: result.url,
		finalUrl: result.finalUrl,
		status: result.statusCode,
		format: result.format,
		charCount: result.outputChars,
		truncated: result.truncated,
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
				details: { ok: false, url: displayUrl },
			});
			const result = await fetchPage(params.url, optionsFrom(params, signal));
			const output = truncateToolOutput(responseText(result));
			return {
				content: [{ type: "text", text: output.text }],
				details: { ...detailsFrom(result), toolOutputTruncated: output.truncated },
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
			const succeeded = results.filter((result) => result.ok).length;
			const output = truncateToolOutput(batchResponseText(params.requests, results));
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					total: results.length,
					completed: results.length,
					succeeded,
					failed: results.length - succeeded,
					items: results.map(detailsFrom),
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
	createBatchWebFetchTool,
	createWebFetchTool,
	detailsFrom,
	responseText,
	runBatch,
	truncateToolOutput,
};
