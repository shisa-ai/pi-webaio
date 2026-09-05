import assert from "node:assert/strict";
import { test } from "node:test";
import registerJouzuWebfetch from "../src/jouzu-extension.ts";

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

test("batch_web_fetch schema bounds model-issued batches", () => {
	const [, tool] = registerTools();
	assert.equal(tool.parameters.properties.requests.minItems, 1);
	assert.equal(tool.parameters.properties.requests.maxItems, 20);
});
