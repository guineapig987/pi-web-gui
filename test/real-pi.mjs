// Smoke test against the REAL pi (not test/fake-pi.mjs).
//   node test/real-pi.mjs            free checks: pi found, version, login state, session start, models, upload
//   node test/real-pi.mjs --prompt   also sends two tiny prompts to the model (uses a few tokens of your login)
//
// Uses your real pi login (~/.pi/agent) but keeps test sessions in a temporary folder, so your own
// session history stays untouched. Nothing here touches your project folders.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePi } from "../lib/pi-launcher.mjs";
import { attachmentNote } from "../public/js/util.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const withPrompt = process.argv.includes("--prompt");

const launcher = resolvePi();
if (launcher.error) {
	console.error(`✗ 진짜 pi를 찾지 못했습니다: ${launcher.error}`);
	process.exit(2);
}

const tmp = mkdtempSync(path.join(tmpdir(), "piweb-real-"));
const work = path.join(tmp, "work");
mkdirSync(work);
writeFileSync(path.join(work, "hello.txt"), "안녕하세요\n");
const secretFile = path.join(tmp, "secret.txt");
writeFileSync(secretFile, "비밀 토큰: KIWI-7421\n");

const port = 9700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PI_CODING_AGENT_SESSION_DIR: path.join(tmp, "sessions"), PI_WEB_DEFAULT_DIR: work, PI_WEB_NO_UPDATE_CHECK: "" };
delete env.PI_CLI; // always the real pi
const server = spawn(process.execPath, [path.join(ROOT, "server.mjs"), "--port", String(port), "--cwd", work], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body) {
	const r = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
	return { status: r.status, body: await r.json().catch(() => null) };
}
async function until(label, fn, timeoutMs, stepMs = 400) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`시간 초과: ${label}`);
		await sleep(stepMs);
	}
}
let passed = 0;
let skipped = 0;
let modelBlocked = false;
// Account problems (billing, quota, login) are not bugs in pi-web: reported as "skipped", not as a failure.
const ACCOUNT_PROBLEM = /extra usage|credit|quota|billing|usage limit|rate.?limit|unauthori[sz]ed|invalid.*api.?key|not logged|login|subscription|overloaded/i;
async function step(name, fn, { needsModel = false } = {}) {
	const t = Date.now();
	if (needsModel && modelBlocked) {
		skipped++;
		console.log(`- ${name} — 건너뜀 (위와 같은 계정 문제)`);
		return;
	}
	try {
		const note = await fn();
		passed++;
		console.log(`✓ ${name}${note ? ` — ${note}` : ""} (${((Date.now() - t) / 1000).toFixed(1)}초)`);
	} catch (err) {
		if (err.account) {
			skipped++;
			modelBlocked = true;
			console.warn(`⚠ ${name} — 건너뜀: 모델 계정 문제로 호출할 수 없습니다\n  ${String(err.message).slice(0, 300)}`);
			return;
		}
		console.error(`✗ ${name}\n  ${err.message}`);
		throw err;
	}
}

try {
	await until("서버 시작", () => log.includes("실행 중"), 10_000, 100);

	let liveId;
	let models = [];
	await step("pi 실행 파일과 버전", async () => {
		const info = (await api("GET", "/api/info")).body;
		assert.ok(info.pi, info.piError);
		const st = (await api("GET", "/api/pi/update?refresh=1")).body;
		assert.match(String(st.current), /^\d+\.\d+\.\d+/, "pi --version 결과를 읽지 못했습니다");
		return `pi ${st.current}${st.updateAvailable ? ` (최신 ${st.latest} 업데이트 가능)` : ""}`;
	});

	await step("로그인 상태", async () => {
		const st = (await api("GET", "/api/auth/status")).body;
		assert.ok(Array.isArray(st.providers), st.error || "공급자 목록 없음");
		const ok = st.providers.filter((p) => p.configured).map((p) => p.name);
		return `${st.mode} 모드, 로그인된 공급자: ${ok.join(", ") || "없음"}`;
	});

	await step("세션 시작 (pi --mode rpc)", async () => {
		const open = await api("POST", "/api/live", { cwd: work });
		assert.equal(open.status, 200, JSON.stringify(open.body));
		liveId = open.body.live.id;
		const live = await until("세션 준비", async () => (await api("GET", "/api/live")).body.live.find((l) => l.id === liveId && l.status === "idle"), 60_000);
		return `세션 ${live.id}`;
	});

	const command = async (cmd) => {
		const r = await api("POST", `/api/live/${liveId}/command`, cmd);
		assert.equal(r.status, 200, JSON.stringify(r.body));
		return r.body;
	};

	await step("상태와 모델 목록", async () => {
		const state = (await command({ type: "get_state" })).data;
		assert.ok(state.sessionId, "sessionId 없음");
		models = (await command({ type: "get_available_models" })).data.models || [];
		return `모델 ${models.length}개, 현재: ${state.model?.name || state.model?.id || "선택 안 됨"}`;
	});

	await step("파일 업로드", async () => {
		const r = await fetch(`${base}/api/upload`, { method: "POST", headers: { "X-File-Name": encodeURIComponent("메모.txt") }, body: "업로드 테스트" });
		assert.equal(r.status, 200);
		const meta = await r.json();
		assert.equal(meta.name, "메모.txt");
		// uploads go to the real agent dir (your login lives there); remove the test copy again
		rmSync(path.dirname(meta.path), { recursive: true, force: true });
		return "저장 후 삭제함";
	});

	if (!withPrompt) {
		console.log("\n모델 호출 테스트는 건너뜀 (실행하려면: node test/real-pi.mjs --prompt)");
	} else {
		const state = (await command({ type: "get_state" })).data;
		if (!state.model) {
			console.log("\n선택된 모델이 없어 모델 호출 테스트를 건너뜀 — pi에서 /login 후 다시 실행하세요");
		} else {
			const ask = async (message) => {
				await command({ type: "prompt", message });
				return until(
					"응답 완료",
					async () => {
						const live = (await api("GET", "/api/live")).body.live.find((l) => l.id === liveId);
						if (live.status !== "idle") return null;
						const msgs = (await command({ type: "get_messages" })).data.messages;
						const lastUser = msgs.map((m) => m.role).lastIndexOf("user");
						const reply = msgs.slice(lastUser + 1).filter((m) => m.role === "assistant").pop();
						if (!reply || !reply.stopReason || reply.stopReason === "pending") return null;
						if (reply.stopReason === "error") throw Object.assign(new Error(reply.errorMessage || "모델 오류"), { account: ACCOUNT_PROBLEM.test(reply.errorMessage || "") });
						return (reply.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
					},
					180_000,
					800,
				);
			};
			await step("프롬프트 한 번 (PONG)", async () => {
				const text = await ask("Reply with exactly the single word PONG and nothing else.");
				assert.match(text, /PONG/i, `응답: ${text.slice(0, 200)}`);
				return `응답: ${text.trim().slice(0, 40)}`;
			}, { needsModel: true });
			await step("첨부 파일 경로로 읽기", async () => {
				const text = await ask(`첨부한 파일 안의 토큰 값만 답해줘.${attachmentNote([{ path: secretFile, size: 30 }])}`);
				assert.match(text, /KIWI-7421/, `응답: ${text.slice(0, 200)}`);
				return "모델이 파일을 열어 토큰을 읽음";
			}, { needsModel: true });
		}
	}
	console.log(`\nreal-pi: ${passed}개 통과${skipped ? `, ${skipped}개 건너뜀(모델 계정 문제)` : ""}`);
} catch (err) {
	console.error(`\n서버 로그:\n${log.slice(-1500)}`);
	process.exitCode = 1;
} finally {
	server.kill();
	await sleep(300);
	rmSync(tmp, { recursive: true, force: true });
}
