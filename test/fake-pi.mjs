#!/usr/bin/env node
// A fake `pi --mode rpc` used only for tests. It follows the documented RPC protocol closely enough
// to exercise the web UI: streaming text/thinking, tool calls, extension dialogs, queueing, abort,
// compaction, bash, sessions on disk (same JSONL layout as pi), forking and stats.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const args = process.argv.slice(2);
// `pi --version` / `pi update` (used by the update dialog). The "installed" version lives in FAKE_PI_VERSION_FILE.
if (args[0] === "--version" || args[0] === "update") {
	const vf = process.env.FAKE_PI_VERSION_FILE;
	if (args[0] === "--version") {
		console.log(vf && existsSync(vf) ? readFileSync(vf, "utf8").trim() : "1.0.0");
	} else if (process.env.FAKE_PI_UPDATE_FAIL) {
		console.error("npm error EBUSY: resource busy or locked");
		process.exitCode = 1;
	} else {
		console.log("Updating pi...\nUpdated to 1.1.0");
		if (vf) writeFileSync(vf, "1.1.0\n");
	}
	process.exit(process.exitCode ?? 0);
}
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
const sessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, "sessions");
const sessionDir = path.join(sessionsRoot, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
const SPEED = Number(process.env.FAKE_PI_SPEED || 1);

const MODELS = [
	{ id: "fake-sonnet", name: "Fake Sonnet", api: "fake", provider: "fake", baseUrl: "http://fake", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
	{ id: "fake-mini", name: "Fake Mini", api: "fake", provider: "fake", baseUrl: "http://fake", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 } },
	{ id: "other-pro", name: "Other Pro", api: "fake", provider: "other", baseUrl: "http://fake", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 32000, cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } },
];
const COMMANDS = [
	{ name: "review", description: "변경 사항 코드 리뷰 (프롬프트 템플릿)", source: "prompt", sourceInfo: { path: "/fake/prompts/review.md", source: "local", scope: "user", origin: "top-level" } },
	{ name: "hello", description: "확장 예제 명령", source: "extension", sourceInfo: { path: "/fake/ext/hello.ts", source: "local", scope: "user", origin: "top-level" } },
	{ name: "skill:tests", description: "테스트 작성 스킬", source: "skill", sourceInfo: { path: "/fake/skills/tests", source: "local", scope: "user", origin: "top-level" } },
];

let model = MODELS[0];
let thinkingLevel = "medium";
let session = null; // {id, file, header, entries, flushed}
let streaming = false;
let abortFlag = false;
let steering = [];
let followUp = [];
let autoCompaction = true;
const pendingUi = new Map();
let bashChild = null;

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const respond = (id, command, data, extra = {}) => out({ id, type: "response", command, success: true, ...(data !== undefined ? { data } : {}), ...extra });
const fail = (id, command, error) => out({ id, type: "response", command, success: false, error });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
const hex = () => randomBytes(4).toString("hex");

function newSession(parentSession) {
	const id = randomUUID();
	const ts = new Date().toISOString();
	session = {
		id,
		file: path.join(sessionDir, `${ts.replace(/[:.]/g, "-")}_${id}.jsonl`),
		header: { type: "session", version: 3, id, timestamp: ts, cwd, ...(parentSession ? { parentSession } : {}) },
		entries: [],
		flushed: false,
		name: undefined,
	};
}

function loadSession(file) {
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const header = lines.find((l) => l.type === "session");
	session = { id: header.id, file, header, entries: lines.filter((l) => l.type !== "session"), flushed: true, name: undefined };
	for (const e of session.entries) if (e.type === "session_info") session.name = e.name;
	const mc = [...session.entries].reverse().find((e) => e.type === "model_change");
	if (mc) model = MODELS.find((m) => m.id === mc.modelId) || model;
}

function hasConversation() {
	return session.entries.some((e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));
}

function persist(entry) {
	session.entries.push(entry);
	if (!session.flushed) {
		if (!hasConversation()) return;
		mkdirSync(path.dirname(session.file), { recursive: true });
		writeFileSync(session.file, [session.header, ...session.entries].map((e) => `${JSON.stringify(e)}\n`).join(""));
		session.flushed = true;
	} else appendFileSync(session.file, `${JSON.stringify(entry)}\n`);
}

function addEntry(fields) {
	const last = session.entries[session.entries.length - 1];
	const entry = { id: hex(), parentId: last ? last.id : null, timestamp: new Date().toISOString(), ...fields };
	persist(entry);
	return entry;
}

function messages() {
	let start = 0;
	const out = [];
	for (let i = 0; i < session.entries.length; i++) {
		const e = session.entries[i];
		if (e.type === "compaction") {
			out.length = 0;
			out.push({ role: "compactionSummary", summary: e.summary, tokensBefore: e.tokensBefore, timestamp: Date.parse(e.timestamp) });
			const keepIdx = session.entries.findIndex((x) => x.id === e.firstKeptEntryId);
			for (let j = keepIdx; j >= 0 && j < i; j++) if (session.entries[j].type === "message") out.push(session.entries[j].message);
			start = i;
		} else if (e.type === "message") out.push(e.message);
	}
	void start;
	return out;
}

function usageFor(text) {
	const input = 1200 + messages().length * 350;
	const output = Math.max(1, Math.round(text.length / 3));
	const c = model.cost;
	const cost = { input: (input * c.input) / 1e6, output: (output * c.output) / 1e6, cacheRead: 0, cacheWrite: 0 };
	cost.total = cost.input + cost.output;
	return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost };
}

function assistantBase() {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: usageFor(""), stopReason: "pending", timestamp: Date.now() };
}

async function streamAssistant(blocks, stopReason = "stop") {
	const msg = assistantBase();
	out({ type: "message_start", message: { ...msg, content: [] } });
	let full = "";
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		if (b.type === "thinking") {
			out({ type: "message_update", usage: msg.usage, assistantMessageEvent: { type: "thinking_start", contentIndex: i } });
			for (const chunk of b.thinking.match(/.{1,8}/gsu) || []) {
				if (abortFlag) break;
				out({ type: "message_update", usage: msg.usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: i, delta: chunk } });
				await sleep(b.delay ?? 12);
			}
			out({ type: "message_update", usage: msg.usage, assistantMessageEvent: { type: "thinking_end", contentIndex: i, content: b.thinking } });
			msg.content.push({ type: "thinking", thinking: b.thinking });
		} else if (b.type === "text") {
			out({ type: "message_update", usage: msg.usage, assistantMessageEvent: { type: "text_start", contentIndex: i } });
			let sent = "";
			for (const chunk of b.text.match(/.{1,6}/gsu) || []) {
				if (abortFlag) break;
				sent += chunk;
				out({ type: "message_update", usage: msg.usage, assistantMessageEvent: { type: "text_delta", contentIndex: i, delta: chunk } });
				await sleep(b.delay ?? 10);
			}
			out({ type: "message_update", usage: msg.usage, assistantMessageEvent: { type: "text_end", contentIndex: i, content: sent } });
			msg.content.push({ type: "text", text: sent });
			full += sent;
		} else if (b.type === "toolCall") {
			const id = `call_${hex()}`;
			out({ type: "message_update", usage: msg.usage, assistantMessageEvent: { type: "toolcall_start", contentIndex: i, id, toolName: b.name } });
			const json = JSON.stringify(b.arguments);
			for (const chunk of json.match(/.{1,10}/gsu) || []) {
				out({ type: "message_update", usage: msg.usage, assistantMessageEvent: { type: "toolcall_delta", contentIndex: i, delta: chunk } });
				await sleep(8);
			}
			const toolCall = { type: "toolCall", id, name: b.name, arguments: b.arguments };
			out({ type: "message_update", usage: msg.usage, assistantMessageEvent: { type: "toolcall_end", contentIndex: i, toolCall } });
			msg.content.push(toolCall);
		}
		if (abortFlag) break;
	}
	msg.usage = usageFor(full);
	msg.stopReason = abortFlag ? "aborted" : stopReason;
	if (abortFlag) msg.errorMessage = "Request was aborted";
	out({ type: "message_end", message: msg });
	addEntry({ type: "message", message: msg });
	return msg;
}

async function runTool(call) {
	out({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
	const started = Date.now();
	let result;
	let isError = false;
	if (call.name === "bash") {
		const lines = ["total 24", "drwxr-xr-x  5 user user 4096 .", "drwxr-xr-x 12 user user 4096 ..", "-rw-r--r--  1 user user  812 package.json", "drwxr-xr-x  2 user user 4096 src", "-rw-r--r--  1 user user 1534 README.md"];
		let acc = "";
		for (const l of lines) {
			acc += `${l}\n`;
			out({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name, args: call.arguments, partialResult: { content: [{ type: "text", text: acc }], details: {} } });
			await sleep(60);
		}
		result = { content: [{ type: "text", text: acc }], details: {} };
	} else if (call.name === "ls" || call.name === "grep") {
		await sleep(60);
		result = { content: [{ type: "text", text: call.name === "ls" ? "greet.js\ncomponents/" : "src/greet.js:1:export function greet(name) {" }], details: {} };
	} else if (call.name === "read") {
		await sleep(80);
		result = { content: [{ type: "text", text: 'export function greet(name) {\n\treturn "Hello " + name;\n}\n' }], details: {} };
	} else if (call.name === "edit") {
		await sleep(120);
		result = {
			content: [{ type: "text", text: `Successfully replaced 1 block(s) in ${call.arguments.path}.` }],
			details: { diff: '  1 export function greet(name) {\n- 2 \treturn "Hello " + name;\n+ 2 \treturn `Hello, ${name}!`;\n  3 }', patch: "", firstChangedLine: 2 },
		};
	} else if (call.name === "write") {
		await sleep(80);
		result = { content: [{ type: "text", text: `Successfully wrote ${call.arguments.content.length} bytes to ${call.arguments.path}` }], details: undefined };
	} else {
		await sleep(50);
		isError = true;
		result = { content: [{ type: "text", text: `Tool ${call.name} not found` }], details: {} };
	}
	const durationMs = Date.now() - started;
	out({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError, durationMs });
	const tr = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, details: result.details, isError, timestamp: Date.now() };
	out({ type: "message_start", message: tr });
	out({ type: "message_end", message: tr });
	addEntry({ type: "message", message: tr });
	return tr;
}

function askUi(request) {
	const id = randomUUID();
	out({ type: "extension_ui_request", id, ...request });
	return new Promise((resolve) => pendingUi.set(id, resolve));
}

const DEMO_MD = `좋습니다. 요청하신 내용을 정리했습니다.

## 요약
- **첫째**: 구조를 단순하게 유지합니다
- *둘째*: \`RpcClient\` 대신 직접 JSONL을 처리합니다
  - 중첩 항목도 지원합니다
1. 번호 목록 하나
2. 번호 목록 둘

\`\`\`js
function add(a, b) {
  return a + b; // <script>alert(1)</script>
}
\`\`\`

| 항목 | 값 |
| --- | ---: |
| 파일 | 3 |
| 줄 | 120 |

> 인용문도 표시됩니다. [pi 문서](https://pi.dev)를 참고하세요.`;

async function scenario(text, images) {
	const t = text.toLowerCase();
	if (t.includes("크래시")) {
		process.stderr.write("Error: simulated crash in fake pi\n    at scenario (fake-pi.mjs)\n");
		process.exit(5);
	}
	if (t.includes("오류") || t.includes("error")) {
		out({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 200, errorMessage: "529 overloaded" });
		await sleep(200);
		out({ type: "auto_retry_end", success: false, attempt: 2, finalError: "529 overloaded" });
		const msg = { ...assistantBase(), stopReason: "error", errorMessage: "529 overloaded: 서버가 혼잡합니다" };
		out({ type: "message_start", message: { ...msg } });
		out({ type: "message_end", message: msg });
		addEntry({ type: "message", message: msg });
		return;
	}
	if (t.includes("확인") || t.includes("confirm")) {
		await streamAssistant([{ type: "text", text: "`rm -rf build` 를 실행하려고 합니다. 승인이 필요합니다." }], "stop");
		const r = await askUi({ method: "confirm", title: "위험한 명령", message: "rm -rf build 를 실행할까요?" });
		await streamAssistant([{ type: "text", text: r.confirmed ? "승인되어 실행했습니다." : r.cancelled ? "취소되었습니다." : "거부되어 실행하지 않았습니다." }]);
		return;
	}
	if (t.includes("선택") || t.includes("select")) {
		const r = await askUi({ method: "select", title: "어느 브랜치로 진행할까요?", options: ["main", "develop", "feature/web-ui"] });
		const v = await askUi({ method: "input", title: "커밋 메시지", placeholder: "메시지를 입력하세요" });
		await streamAssistant([{ type: "text", text: `선택: ${r.value ?? "(취소)"}, 입력: ${v.value ?? "(취소)"}` }]);
		return;
	}
	if (t.includes("긴") || t.includes("slow") || t.includes("long")) {
		const long = Array.from({ length: 40 }, (_, i) => `${i + 1}번째 문장을 천천히 출력합니다. `).join("");
		await streamAssistant([{ type: "text", text: long, delay: 40 }]);
		return;
	}
	if (t.includes("탐색") || t.includes("explore")) {
		const a = await streamAssistant(
			[
				{ type: "thinking", thinking: "구조부터 파악하자." },
				{ type: "toolCall", name: "ls", arguments: { path: "src" } },
				{ type: "toolCall", name: "grep", arguments: { pattern: "greet", path: "src" } },
			],
			"toolUse",
		);
		if (abortFlag) return;
		await runTool(a.content[1]);
		await runTool(a.content[2]);
		const b = await streamAssistant(
			[
				{ type: "toolCall", name: "read", arguments: { path: "src/greet.js" } },
				{ type: "toolCall", name: "read", arguments: { path: "package.json" } },
			],
			"toolUse",
		);
		if (abortFlag) return;
		await runTool(b.content[0]);
		await runTool(b.content[1]);
		await streamAssistant([{ type: "text", text: "`greet` 함수는 `src/greet.js`에 있습니다." }]);
		return;
	}
	if (t.includes("수정") || t.includes("edit")) {
		const a = await streamAssistant(
			[
				{ type: "text", text: "파일을 먼저 읽겠습니다." },
				{ type: "toolCall", name: "read", arguments: { path: "src/greet.js" } },
			],
			"toolUse",
		);
		if (abortFlag) return;
		await runTool(a.content[1]);
		const b = await streamAssistant(
			[{ type: "toolCall", name: "edit", arguments: { path: "src/greet.js", edits: [{ oldText: 'return "Hello " + name;', newText: "return `Hello, ${name}!`;" }] } }, { type: "toolCall", name: "write", arguments: { path: "NOTES.md", content: "# 메모\n\n- greet 함수를 템플릿 문자열로 바꿈\n" } }],
			"toolUse",
		);
		if (abortFlag) return;
		await runTool(b.content[0]);
		await runTool(b.content[1]);
		await streamAssistant([{ type: "text", text: "`src/greet.js`를 수정하고 `NOTES.md`를 만들었습니다." }]);
		return;
	}
	if (t.includes("도구") || t.includes("tool")) {
		const a = await streamAssistant(
			[
				{ type: "thinking", thinking: "사용자가 파일 목록을 원한다. bash로 ls를 실행하자." },
				{ type: "text", text: "현재 폴더를 확인하겠습니다." },
				{ type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
			],
			"toolUse",
		);
		if (abortFlag) return;
		await runTool(a.content[2]);
		if (abortFlag) return;
		await streamAssistant([{ type: "text", text: "폴더에 `package.json`, `src/`, `README.md`가 있습니다." }]);
		return;
	}
	const blocks = [];
	if (t.includes("생각") || t.includes("think")) blocks.push({ type: "thinking", thinking: "질문을 분석하고 있습니다. 먼저 요구사항을 정리하고, 그다음 예시를 만듭니다." });
	if (images?.length) blocks.push({ type: "text", text: `이미지 ${images.length}장을 받았습니다 (${images.map((i) => i.mimeType).join(", ")}).\n\n` });
	blocks.push({ type: "text", text: DEMO_MD });
	await streamAssistant(blocks);
}

async function runAgent(text, images) {
	streaming = true;
	abortFlag = false;
	out({ type: "agent_start" });
	let pendingText = text;
	let pendingImages = images;
	while (pendingText !== null) {
		out({ type: "turn_start" });
		const content = pendingImages?.length ? [{ type: "text", text: pendingText }, ...pendingImages] : pendingText;
		const user = { role: "user", content, timestamp: Date.now() };
		out({ type: "message_start", message: user });
		out({ type: "message_end", message: user });
		addEntry({ type: "message", message: user });
		await scenario(pendingText, pendingImages);
		out({ type: "turn_end", message: null, toolResults: [] });
		pendingText = null;
		pendingImages = null;
		if (abortFlag) break;
		if (steering.length) {
			pendingText = steering.shift();
			out({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
			continue;
		}
		out({ type: "agent_end", messages: [], willRetry: false });
		if (followUp.length) {
			pendingText = followUp.shift();
			out({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
			out({ type: "agent_start" });
		}
	}
	if (abortFlag) out({ type: "agent_end", messages: [], willRetry: false });
	streaming = false;
	out({ type: "agent_settled", aborted: abortFlag });
	abortFlag = false;
}

function stats() {
	const msgs = messages();
	let input = 0;
	let output = 0;
	let cost = 0;
	let lastInput = 0;
	for (const m of msgs) {
		if (m.role === "assistant" && m.usage) {
			input += m.usage.input;
			output += m.usage.output;
			cost += m.usage.cost.total;
			lastInput = m.usage.totalTokens;
		}
	}
	return {
		sessionFile: session.file,
		sessionId: session.id,
		userMessages: msgs.filter((m) => m.role === "user").length,
		assistantMessages: msgs.filter((m) => m.role === "assistant").length,
		toolCalls: 0,
		toolResults: msgs.filter((m) => m.role === "toolResult").length,
		totalMessages: msgs.length,
		tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
		cost,
		contextUsage: { tokens: lastInput, contextWindow: model.contextWindow, percent: Math.round((lastInput / model.contextWindow) * 1000) / 10 },
	};
}

function state() {
	return {
		model,
		thinkingLevel: model.reasoning ? thinkingLevel : "off",
		isStreaming: streaming,
		isCompacting: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		sessionFile: session.file,
		sessionId: session.id,
		...(session.name ? { sessionName: session.name } : {}),
		autoCompactionEnabled: autoCompaction,
		messageCount: messages().length,
		pendingMessageCount: steering.length + followUp.length,
	};
}

function textOf(c) {
	return typeof c === "string" ? c : c.filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function handle(cmd) {
	const { id, type } = cmd;
	switch (type) {
		case "get_state":
			return respond(id, type, state());
		case "get_messages":
			return respond(id, type, { messages: messages() });
		case "get_available_models":
			return respond(id, type, { models: MODELS });
		case "set_model": {
			const m = MODELS.find((x) => x.provider === cmd.provider && x.id === cmd.modelId);
			if (!m) return fail(id, type, `Model not found: ${cmd.provider}/${cmd.modelId}`);
			model = m;
			addEntry({ type: "model_change", provider: m.provider, modelId: m.id });
			return respond(id, type, m);
		}
		case "get_available_thinking_levels":
			return respond(id, type, { levels: model.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"] });
		case "set_thinking_level":
			thinkingLevel = cmd.level;
			out({ type: "thinking_level_changed", level: cmd.level });
			return respond(id, type);
		case "get_commands":
			return respond(id, type, { commands: COMMANDS });
		case "get_session_stats":
			return respond(id, type, stats());
		case "set_session_name":
			session.name = cmd.name;
			addEntry({ type: "session_info", name: cmd.name });
			out({ type: "session_info_changed", name: cmd.name });
			return respond(id, type);
		case "prompt": {
			const msg = cmd.message ?? "";
			if (msg.startsWith("/hello")) {
				out({ type: "extension_ui_request", id: randomUUID(), method: "notify", message: "안녕하세요! 확장 명령이 실행되었습니다.", notifyType: "info" });
				out({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: "hello", statusText: "hello 확장: 활성" });
				return respond(id, type, { disposition: "handled" });
			}
			if (streaming) {
				if (!cmd.streamingBehavior) return fail(id, type, "Agent is streaming; specify streamingBehavior");
				(cmd.streamingBehavior === "steer" ? steering : followUp).push(msg);
				out({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
				return respond(id, type, { disposition: "queued" });
			}
			respond(id, type, { disposition: "started" });
			runAgent(msg.startsWith("/review") ? "다음 변경 사항을 리뷰해 주세요." : msg, cmd.images);
			return;
		}
		case "steer":
		case "follow_up":
			(type === "steer" ? steering : followUp).push(cmd.message);
			out({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
			return respond(id, type, { disposition: "queued" });
		case "clear_queue": {
			const data = { steering: [...steering], followUp: [...followUp] };
			steering = [];
			followUp = [];
			out({ type: "queue_update", steering: [], followUp: [] });
			return respond(id, type, data);
		}
		case "abort": {
			if (streaming) {
				abortFlag = true;
				for (const [uid, resolve] of pendingUi) {
					pendingUi.delete(uid);
					resolve({ cancelled: true });
				}
				while (streaming) await sleep(20);
			}
			return respond(id, type);
		}
		case "compact": {
			out({ type: "compaction_start", reason: "manual" });
			await sleep(300);
			const before = stats().contextUsage.tokens || 5000;
			const msgEntries = session.entries.filter((e) => e.type === "message");
			const keep = msgEntries[msgEntries.length - 2];
			const entry = addEntry({ type: "compaction", summary: "이전 대화 요약: 사용자는 웹 UI 기능을 요청했고 여러 도구를 실행했다.", firstKeptEntryId: keep ? keep.id : "", tokensBefore: before });
			if (!keep) entry.firstKeptEntryId = entry.id;
			const result = { summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: before, estimatedTokensAfter: 900, details: {} };
			out({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
			return respond(id, type, result);
		}
		case "bash": {
			const child = spawn(cmd.command, { shell: true, cwd });
			bashChild = child;
			let output = "";
			const dec = new StringDecoder("utf8");
			const onData = (d) => {
				const s = dec.write(d);
				output += s;
				out({ type: "bash_execution_update", id, delta: s });
			};
			child.stdout.on("data", onData);
			child.stderr.on("data", onData);
			child.on("close", (code, signal) => {
				bashChild = null;
				const cancelled = signal !== null;
				const msg = { role: "bashExecution", command: cmd.command, output, exitCode: cancelled ? undefined : code, cancelled, truncated: false, ...(cmd.excludeFromContext ? { excludeFromContext: true } : {}), timestamp: Date.now() };
				addEntry({ type: "message", message: msg });
				respond(id, type, { output, exitCode: msg.exitCode, cancelled, truncated: false });
			});
			return;
		}
		case "abort_bash":
			bashChild?.kill();
			return respond(id, type);
		case "new_session":
			newSession(cmd.parentSession);
			return respond(id, type, { cancelled: false });
		case "switch_session":
			if (!existsSync(cmd.sessionPath)) return fail(id, type, `Session not found: ${cmd.sessionPath}`);
			loadSession(cmd.sessionPath);
			return respond(id, type, { cancelled: false });
		case "get_fork_messages":
			return respond(id, type, { messages: session.entries.filter((e) => e.type === "message" && e.message.role === "user").map((e) => ({ entryId: e.id, text: textOf(e.message.content) })) });
		case "fork":
		case "clone": {
			const parent = session.file;
			let entries = session.entries;
			let text = "";
			if (type === "fork") {
				const idx = entries.findIndex((e) => e.id === cmd.entryId);
				if (idx < 0) return fail(id, type, "Entry not found");
				text = textOf(entries[idx].message.content);
				entries = entries.slice(0, idx);
			}
			const oldEntries = entries;
			newSession(parent);
			for (const e of oldEntries) session.entries.push(e);
			if (hasConversation()) {
				mkdirSync(path.dirname(session.file), { recursive: true });
				writeFileSync(session.file, [session.header, ...session.entries].map((e) => `${JSON.stringify(e)}\n`).join(""));
				session.flushed = true;
			}
			return respond(id, type, type === "fork" ? { text, cancelled: false } : { cancelled: false });
		}
		case "export_html": {
			const p = cmd.outputPath || path.join(cwd, `pi-session-${session.id.slice(0, 8)}.html`);
			writeFileSync(p, `<!doctype html><meta charset="utf-8"><title>pi session</title><pre>${messages().map((m) => `${m.role}: ${JSON.stringify(m.content ?? m.summary ?? "")}`).join("\n").replace(/</g, "&lt;")}</pre>`);
			return respond(id, type, { path: p });
		}
		case "get_last_assistant_text": {
			const last = [...messages()].reverse().find((m) => m.role === "assistant");
			return respond(id, type, { text: last ? textOf(last.content) : null });
		}
		case "set_auto_compaction":
			autoCompaction = !!cmd.enabled;
			return respond(id, type);
		case "set_auto_retry":
		case "abort_retry":
		case "set_steering_mode":
		case "set_follow_up_mode":
			return respond(id, type);
		case "get_entries":
			return respond(id, type, { entries: session.entries, leafId: session.entries.at(-1)?.id ?? null });
		case "extension_ui_response": {
			const resolve = pendingUi.get(cmd.id);
			if (resolve) {
				pendingUi.delete(cmd.id);
				resolve(cmd);
			}
			return;
		}
		default:
			return fail(id, type, `Unknown command: ${type}`);
	}
}

// ---- startup ----
const sIdx = args.indexOf("--session");
if (sIdx >= 0 && args[sIdx + 1] && existsSync(args[sIdx + 1])) loadSession(args[sIdx + 1]);
else newSession();
if (process.env.FAKE_PI_CRASH) {
	process.stderr.write("fatal: fake crash for testing\n");
	process.exit(3);
}

const decoder = new StringDecoder("utf8");
let buf = "";
process.stdin.on("data", (d) => {
	buf += decoder.write(d);
	let nl = buf.indexOf("\n");
	while (nl !== -1) {
		const line = buf.slice(0, nl).replace(/\r$/, "");
		buf = buf.slice(nl + 1);
		if (line.trim()) {
			let cmd;
			try {
				cmd = JSON.parse(line);
			} catch (e) {
				out({ type: "response", command: "parse", success: false, error: `Failed to parse command: ${e.message}` });
				cmd = null;
			}
			if (cmd) handle(cmd).catch((e) => fail(cmd.id, cmd.type, e.message));
		}
		nl = buf.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
