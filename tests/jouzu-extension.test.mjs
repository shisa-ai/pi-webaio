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
	assert.deepEqual(result.details, {
		ok: false,
		url: "file:///etc/passwd",
		finalUrl: undefined,
		status: undefined,
		errorCode: "unsupported_protocol",
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
	assert.match(result.content[0].text, /## 1\. file:\/\/\/first/);
	assert.match(result.content[0].text, /## 2\. ftp:\/\/example\.test\/second/);
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
