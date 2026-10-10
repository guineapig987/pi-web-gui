// Unit tests for the shared reducer and markdown renderer (node test/unit.mjs).
import assert from "node:assert/strict";
import { compareVersions, parseChangelog } from "../lib/pi-update.mjs";
import { renderMarkdown } from "../public/js/markdown.js";
import { attachmentNote, splitAttachments } from "../public/js/util.js";
import { applyEvent, createView, parsePartialJson } from "../public/js/reducer.js";

let passed = 0;
function test(name, fn) {
	try {
		fn();
		passed++;
	} catch (err) {
		console.error(`✗ ${name}`);
		throw err;
	}
}

test("markdown escapes html", () => {
	const html = renderMarkdown("<script>alert(1)</script> **b**");
	assert.ok(!html.includes("<script>"));
	assert.ok(html.includes("&lt;script&gt;"));
	assert.ok(html.includes("<strong>b</strong>"));
});

test("markdown code fence with language + escaping", () => {
	const html = renderMarkdown("```js\nconst a = '<b>';\n```");
	assert.ok(html.includes('class="code-block"'));
	assert.ok(html.includes("tok-k"));
	assert.ok(html.includes("&lt;b&gt;"));
});

test("markdown unclosed fence while streaming", () => {
	const html = renderMarkdown("text\n```py\nprint('x')");
	assert.ok(html.includes("<pre><code>"));
});

test("markdown lists nested + ordered + task", () => {
	const html = renderMarkdown("- a\n  - b\n- [x] c\n\n1. one\n2. two");
	assert.ok(html.includes("<ul><li>a<ul><li>b</li></ul></li>"), html);
	assert.ok(html.includes('type="checkbox"'));
	assert.ok(html.includes("<ol><li>one</li><li>two</li></ol>"), html);
});

test("markdown table", () => {
	const html = renderMarkdown("| a | b |\n| --- | ---: |\n| 1 | 2 |");
	assert.ok(html.includes("<table>"));
	assert.ok(html.includes('style="text-align:right"'));
});

test("markdown links are safe", () => {
	const ok = renderMarkdown("[x](https://pi.dev?a=1&b=2)");
	assert.ok(ok.includes('href="https://pi.dev?a=1&amp;b=2"'), ok);
	const bad = renderMarkdown("[x](javascript:alert(1))");
	assert.ok(!bad.includes("href"), bad);
	assert.ok(renderMarkdown("see https://example.com/a.").includes('href="https://example.com/a"'));
});

test("markdown inline code keeps underscores and stars", () => {
	const html = renderMarkdown("call `a_b*c*` and snake_case_name");
	assert.ok(html.includes("<code>a_b*c*</code>"));
	assert.ok(!html.includes("<em>"), html);
});

test("partial json", () => {
	assert.deepEqual(parsePartialJson('{"path":"src/a'), { path: "src/a" });
	assert.deepEqual(parsePartialJson('{"edits":[{"oldText":"x"'), { edits: [{ oldText: "x" }] });
	assert.deepEqual(parsePartialJson('{"a":1,'), { a: 1 });
});

test("reducer streams assistant text and tool calls", () => {
	const v = createView();
	applyEvent(v, { type: "gw_state", state: { sessionId: "s" } });
	assert.equal(v.status, "idle");
	applyEvent(v, { type: "agent_start" });
	assert.equal(v.status, "running");
	applyEvent(v, { type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } });
	applyEvent(v, { type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } });
	applyEvent(v, { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
	applyEvent(v, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
	applyEvent(v, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
	applyEvent(v, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } });
	assert.equal(v.messages[1].content[0].text, "Hello");
	applyEvent(v, { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "bash" } });
	applyEvent(v, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"command":"l' } });
	assert.equal(v.messages[1].content[1].arguments.command, "l");
	const final = { role: "assistant", content: [{ type: "text", text: "Hello" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" };
	applyEvent(v, { type: "message_end", message: final });
	assert.equal(v.messages.length, 2);
	assert.equal(v.messages[1].stopReason, "toolUse");
	const v1 = v.messages[1]._v;
	applyEvent(v, { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
	assert.ok(v.messages[1]._v > v1, "owner bumped");
	applyEvent(v, { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [] }, isError: false, durationMs: 5 });
	assert.equal(v.tools.c1.status, "done");
	applyEvent(v, { type: "extension_ui_request", id: "u1", method: "confirm", title: "t", message: "m" });
	assert.equal(v.status, "waiting");
	applyEvent(v, { type: "gw_ui_resolved", id: "u1" });
	applyEvent(v, { type: "agent_settled", aborted: false });
	assert.equal(v.status, "idle");
});

test("compareVersions orders releases", () => {
	assert.ok(compareVersions("1.1.0", "1.0.4") > 0);
	assert.ok(compareVersions("1.0.4", "1.1.0") < 0);
	assert.equal(compareVersions("v2.0.0", "2.0.0"), 0);
	assert.ok(compareVersions("1.0.0", "1.0.0-beta.1") > 0);
	assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
	assert.equal(compareVersions("abc", "1.0.0"), null);
});

test("parseChangelog splits version sections", () => {
	const e = parseChangelog(["# Changelog", "", "## [Unreleased]", "", "- a", "", "## [1.2.0] - 2026-01-02", "", "### Fixed", "", "- b", "", "## [1.1.0]", "", "- c", ""].join("\n"));
	assert.deepEqual(e.map((x) => x.version), ["1.2.0", "1.1.0"]);
	assert.equal(e[0].date, "2026-01-02");
	assert.match(e[0].markdown, /### Fixed/);
	assert.equal(e[1].date, null);
});

test("attachment note round-trips and ignores look-alikes", () => {
	const files = [{ path: "C:\\Users\\a b\\보고서 (최종).pdf", size: 2048 }, { path: "/tmp/x.txt", size: 12 }];
	const text = `읽어줘${attachmentNote(files)}`;
	const r = splitAttachments(text);
	assert.equal(r.body, "읽어줘");
	assert.deepEqual(r.files.map((f) => f.path), files.map((f) => f.path));
	assert.equal(r.files[0].size, "2KB");
	const plain = "그냥 글\n\n[첨부 파일]\n아무거나";
	assert.deepEqual(splitAttachments(plain), { body: plain, files: [] });
});

console.log(`unit: ${passed} passed`);
