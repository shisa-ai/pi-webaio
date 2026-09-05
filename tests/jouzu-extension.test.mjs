import assert from "node:assert/strict";
import { test } from "node:test";
import registerJouzuWebfetch, { __test__ } from "../src/jouzu-extension.ts";

function registerTools() {
	const tools = [];
	registerJouzuWebfetch({ registerTool(tool) { tools.push(tool); } });
	return tools;
}

test("the Jouzu entrypoint registers only the static single and batch tools", () => {
	const tools = registerTools();
	assert.deepEqual(tools.map((tool) => tool.name), ["web_fetch", "batch_web_fetch"]);
	assert.deepEqual(tools.map((tool) => tool.executionMode), ["parallel", "parallel"]);
});

test("web_fetch forwards validation failures as structured tool output", async () => {
	const [tool] = registerTools();
	const result = await tool.execute("call-1", { url: "file:///etc/passwd" }, undefined);
	assert.match(result.content[0].text, /Fetch failed \[unsupported_protocol\]/);
	const { elapsedMs, ...details } = result.details;
	assert.ok(elapsedMs >= 0);
	assert.deepEqual(details, {
		ok: false,
		url: "file:///etc/passwd",
		finalUrl: undefined,
		redirects: [],
		httpStatus: undefined,
		errorCode: "unsupported_protocol",
		errorPhase: "validation",
		retryable: false,
		verbose: false,
		maxChars: 50_000,
		fetchResult: undefined,
		started: true,
		status: "error",
		progress: 1,
		phase: "validation",
		error: true,
		errorText: "Fetch failed [unsupported_protocol]: URL must use http or https, got file:",
		userErrorSummary: "URL must use http or https, got file:",
		toolOutputTruncated: false,
	});
});

test("batch_web_fetch preserves request order and isolates failures", async () => {
	const [, tool] = registerTools();
	const result = await tool.execute(
		"call-2",
		{
			requests: [
				{ url: "file:///first" },
				{ url: "ftp://example.test/second" },
			],
		},
		undefined,
	);
	assert.equal(result.details.total, 2);
	assert.equal(result.details.completed, 2);
	assert.equal(result.details.succeeded, 0);
	assert.equal(result.details.failed, 2);
	assert.deepEqual(
		{
			total: result.details.batchResult.total,
			succeeded: result.details.batchResult.succeeded,
			failed: result.details.batchResult.failed,
			batchConcurrency: result.details.batchResult.batchConcurrency,
		},
		{ total: 2, succeeded: 0, failed: 2, batchConcurrency: 2 },
	);
	assert.deepEqual(
		result.details.batchResult.items.map(({ index, request, status, progress }) => ({
			index,
			request,
			status,
			progress,
		})),
		[
			{
				index: 0,
				request: {
					url: "file:///first",
					browser: "chrome_145",
					os: "windows",
					maxChars: 50_000,
					timeoutMs: 15_000,
					format: "markdown",
					removeImages: false,
					includeReplies: "extractors",
				},
				status: "error",
				progress: 1,
			},
			{
				index: 1,
				request: {
					url: "ftp://example.test/second",
					browser: "chrome_145",
					os: "windows",
					maxChars: 50_000,
					timeoutMs: 15_000,
					format: "markdown",
					removeImages: false,
					includeReplies: "extractors",
				},
				status: "error",
				progress: 1,
			},
		],
	);
	assert.match(result.content[0].text, /## 1\. file:\/\/\/first/);
	assert.match(result.content[0].text, /## 2\. ftp:\/\/example\.test\/second/);
});

test("batch compatibility details retain safe metadata without bodies or credentials", () => {
	const secretUrl = "https://user:password@example.test/article?access_token=abc";
	const request = {
		url: secretUrl,
		browser: "firefox_147",
		os: "linux",
		maxChars: 1_234,
		timeoutMs: 9_876,
		format: "text",
		removeImages: true,
		includeReplies: false,
		headers: { Authorization: "Bearer secret-header" },
		proxy: "http://proxy-user:proxy-password@proxy.example:8080",
	};
	const success = {
		ok: true,
		kind: "content",
		url: secretUrl,
		finalUrl: secretUrl,
		redirects: [secretUrl],
		statusCode: 200,
		statusText: "OK",
		contentType: "text/html",
		format: "text",
		content: "SENTINEL_RESPONSE_BODY",
		truncated: false,
		title: "Fixture title",
		author: "Fixture author",
		published: "2026-09-05",
		site: "Fixture site",
		language: "en",
		description: "Fixture description",
		wordCount: 3,
		fullContentChars: 22,
		outputChars: 22,
		browser: "firefox_147",
		os: "linux",
		downloadedBytes: 123,
		contentLength: 123,
		elapsedMs: 12,
		browserEscalated: false,
		remoteFallbackUsed: false,
		persisted: false,
		proxyUsed: true,
		targetPinning: "proxy-dependent",
	};
	const failureRequest = {
		url: "https://user:password@example.test/denied?access_token=abc",
		proxy: "proxy-user:proxy-password@proxy.example:8080",
	};
	const failure = {
		ok: false,
		url: failureRequest.url,
		finalUrl: failureRequest.url,
		redirects: [],
		elapsedMs: 8,
		error: {
			code: "http_error",
			message: "upstream refused",
			phase: "waiting",
			retryable: false,
			statusCode: 403,
		},
	};
	const details = __test__.batchResultDetails([request, failureRequest], [success, failure]);
	assert.equal(details.total, 2);
	assert.equal(details.succeeded, 1);
	assert.equal(details.failed, 1);
	assert.equal(details.items[0].status, "done");
	assert.deepEqual(details.items[0].request, {
		url: "https://example.test/article?access_token=[REDACTED]",
		browser: "firefox_147",
		os: "linux",
		maxChars: 1_234,
		timeoutMs: 9_876,
		format: "text",
		removeImages: true,
		includeReplies: false,
		proxy: "http://proxy.example:8080/",
	});
	assert.deepEqual(
		{
			kind: details.items[0].result.kind,
			httpStatus: details.items[0].result.httpStatus,
			title: details.items[0].result.title,
			author: details.items[0].result.author,
			published: details.items[0].result.published,
			site: details.items[0].result.site,
			language: details.items[0].result.language,
			wordCount: details.items[0].result.wordCount,
			browser: details.items[0].result.browser,
			os: details.items[0].result.os,
			contentOmitted: details.items[0].result.contentOmitted,
		},
		{
			kind: "content",
			httpStatus: 200,
			title: "Fixture title",
			author: "Fixture author",
			published: "2026-09-05",
			site: "Fixture site",
			language: "en",
			wordCount: 3,
			browser: "firefox_147",
			os: "linux",
			contentOmitted: true,
		},
	);
	assert.equal(details.items[1].status, "error");
	assert.equal(
		details.items[1].error,
		"Fetch failed [http_error] (HTTP 403): upstream refused (phase: waiting; retryable: no)",
	);
	assert.equal(details.items[1].request.url, "https://example.test/denied?access_token=[REDACTED]");
	assert.equal(details.items[1].request.proxy, "[REDACTED:proxy]");
	const persisted = JSON.stringify(details);
	assert.doesNotMatch(persisted, /SENTINEL_RESPONSE_BODY|secret-header|proxy-password|password|access_token=abc/);

	const proxyCases = [
		"proxy-user:proxy-password@proxy.example:8080",
		"ftp://proxy-user:proxy-password@proxy.example/file",
		"http://proxy.example/?access_token=proxy-query-secret#token=proxy-fragment-secret",
	];
	const proxyDetails = __test__.batchResultDetails(
		proxyCases.map((proxy, index) => ({ url: `https://example.test/${index}`, proxy })),
		proxyCases.map((_, index) => ({ ...failure, url: `https://example.test/${index}` })),
	);
	assert.deepEqual(
		proxyDetails.items.slice(0, 2).map((item) => item.request.proxy),
		["[REDACTED:proxy]", "[REDACTED:proxy]"],
	);
	const serializedProxyDetails = JSON.stringify(proxyDetails);
	assert.doesNotMatch(
		serializedProxyDetails,
		/proxy-password|proxy-query-secret|proxy-fragment-secret|ftp:\/\/proxy-user/u,
	);
});

test("single fetch compatibility uses the final URL without persisting the body", () => {
	const originalUrl = "https://example.test/redirect";
	const finalUrl = "https://example.test/final";
	const success = {
		ok: true,
		kind: "content",
		url: originalUrl,
		finalUrl,
		redirects: [finalUrl],
		statusCode: 200,
		statusText: "OK",
		contentType: "text/plain",
		format: "text",
		content: "SENTINEL_RESPONSE_BODY",
		truncated: false,
		title: "Fixture",
		author: "",
		published: "",
		site: "example.test",
		language: "en",
		description: "",
		wordCount: 2,
		fullContentChars: 22,
		outputChars: 22,
		browser: "chrome_145",
		os: "windows",
		downloadedBytes: 22,
		contentLength: 22,
		elapsedMs: 4,
		browserEscalated: false,
		remoteFallbackUsed: false,
		persisted: false,
		proxyUsed: false,
		targetPinning: "local",
	};
	const details = __test__.singleToolDetails({ url: originalUrl }, success, false);
	assert.equal(details.url, finalUrl);
	assert.equal(details.fetchResult.url, originalUrl);
	assert.equal(details.fetchResult.finalUrl, finalUrl);
	assert.equal(details.fetchResult.contentOmitted, true);
	assert.doesNotMatch(JSON.stringify(details), /SENTINEL_RESPONSE_BODY/);

	const failure = {
		ok: false,
		url: originalUrl,
		redirects: [],
		elapsedMs: 2,
		error: {
			code: "network_error",
			message: "proxy http://proxy-user:proxy-password@proxy.example:8080 failed",
			phase: "connecting",
			retryable: true,
		},
	};
	const failedDetails = __test__.singleToolDetails({ url: originalUrl }, failure, false);
	assert.match(failedDetails.errorText, /http:\/\/proxy\.example:8080/u);
	assert.doesNotMatch(JSON.stringify(failedDetails), /proxy-user|proxy-password/);
});

test("tool output is bounded by bytes and lines without splitting Unicode", () => {
	for (const input of ["🙂".repeat(20_000), Array.from({ length: 3_000 }, () => "line").join("\n")]) {
		const result = __test__.truncateToolOutput(input);
		assert.equal(result.truncated, true);
		assert.ok(Buffer.byteLength(result.text, "utf8") <= 50_000);
		assert.ok(result.text.split("\n").length <= 2_000);
		assert.match(result.text, /Tool output truncated/);
		assert.doesNotMatch(result.text, /�/);
	}
});

test("request credentials are absent from updates, results, and rendering", async () => {
	const [tool] = registerTools();
	const updates = [];
	const secretUrl = "https://user:password@example.test/?access_token=abc";
	const result = await tool.execute("call-secret", { url: secretUrl }, undefined, (update) => updates.push(update));
	const rendered = tool.renderCall(
		{ url: secretUrl },
		{ fg(_color, text) { return text; } },
	).render(200).join("\n");
	for (const value of [JSON.stringify(updates), JSON.stringify(result), rendered]) {
		assert.doesNotMatch(value, /password|access_token=abc/);
	}
});

test("batch cancellation stops workers before queued requests start", async () => {
	const controller = new AbortController();
	const requests = Array.from({ length: 20 }, (_, index) => ({ url: `https://example.test/${index}` }));
	let started = 0;
	const fakeResult = (url) => ({
		ok: false,
		url,
		redirects: [],
		elapsedMs: 1,
		error: { code: "network_error", message: "fixture", phase: "waiting", retryable: true },
	});
	const results = await __test__.runBatch(requests, controller.signal, undefined, async (url) => {
		started += 1;
		if (started === 1) setTimeout(() => controller.abort(), 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		return fakeResult(url);
	});
	assert.equal(started, 4);
	assert.equal(results.filter(Boolean).length, 4);
});

test("batch_web_fetch schema bounds model-issued batches", () => {
	const [, tool] = registerTools();
	assert.equal(tool.parameters.properties.requests.minItems, 1);
	assert.equal(tool.parameters.properties.requests.maxItems, 20);
});
