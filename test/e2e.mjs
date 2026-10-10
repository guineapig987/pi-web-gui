// End-to-end test: real server + fake pi + headless Chromium (Playwright).
// Usage: node test/e2e.mjs [--shots <dir>]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync as fsExists, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try {
	({ chromium } = require("playwright"));
} catch {
	// not installed locally: try the global npm folder (npm i -g playwright)
	const { execSync } = require("node:child_process");
	try {
		const root = execSync("npm root -g", { encoding: "utf8", shell: true }).trim().split(/\r?\n/).pop();
		({ chromium } = require(path.join(root, "playwright")));
	} catch {
		console.error("playwright를 찾을 수 없습니다. 'npm i -g playwright' 후 'npx playwright install chromium' 을 실행하세요.");
		process.exit(2);
	}
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const tmp = mkdtempSync(path.join(tmpdir(), "piweb-e2e-"));
const agentDir = path.join(tmp, "agent");
const proj = path.join(tmp, "my-project");
const defaultDir = path.join(tmp, "Documents", "pi");
mkdirSync(path.join(proj, "src", "components"), { recursive: true });
writeFileSync(path.join(proj, "package.json"), "{}");
writeFileSync(path.join(proj, "src", "greet.js"), "export const x = 1;\n");
writeFileSync(path.join(proj, "src", "components", "Button.tsx"), "export {}\n");
writeFileSync(path.join(proj, "README.md"), "# demo\n");
const PORT = 8800 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [path.join(ROOT, "server.mjs"), "--port", String(PORT), "--cwd", proj], {
	env: { ...process.env, PI_CLI: path.join(ROOT, "test", "fake-pi.mjs"), PI_CODING_AGENT_DIR: agentDir, PI_WEB_DEFAULT_DIR: defaultDir, PI_WEB_PI_PACKAGE: path.join(ROOT, "test", "fake-pi-pkg"), FAKE_PI_SPEED: "3" },
	stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error(`server did not start\n${serverLog}`)), 8000);
	server.stdout.on("data", () => {
		if (serverLog.includes("실행 중")) {
			clearTimeout(t);
			resolve();
		}
	});
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && !/status of 400/.test(m.text()) && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

let step = 0;
async function shot(name) {
	if (!SHOTS) return;
	step++;
	await page.screenshot({ path: path.join(SHOTS, `${String(step).padStart(2, "0")}-${name}.png` ) });
}
const input = () => page.locator(".composer-input");
async function send(text) {
	await input().click();
	await input().fill(text);
	await page.keyboard.press("Enter");
}
async function waitIdle() {
	await page.waitForSelector(".status-pill.idle", { timeout: 15000 });
}

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`✓ ${name}`);
	} catch (err) {
		console.error(`✗ ${name}`);
		await page.screenshot({ path: path.join(SHOTS || tmp, `FAIL-${name.replace(/\W+/g, "_")}.png`) }).catch(() => {});
		throw err;
	}
}

try {
	await page.goto(BASE);
	await test("home screen", async () => {
		await page.waitForSelector(".home-head h1");
		assert.match(await page.locator(".home-head h1").innerText(), /my-project/);
		await shot("home");
	});

	await test("new session screen, first prompt streams markdown + thinking", async () => {
		await page.locator(".new-btn").click();
		await page.waitForSelector(".new-session:not(.hidden) h2");
		await page.waitForSelector(".sb-item.active");
		await shot("new-session");
		await send("생각해서 정리해줘");
		await page.waitForSelector(".msg-user .user-text");
		await waitIdle();
		assert.ok(await page.locator(".md table").count());
		assert.ok(await page.locator(".code-block .tok-k").count());
		assert.ok(await page.locator(".thinking").count());
		assert.equal(await page.locator(".md script").count(), 0);
		await page.locator(".thinking-head").first().click();
		await page.waitForSelector(".thinking-body");
		await shot("markdown");
	});

	await test("tab title follows the first message; home lists the session", async () => {
		await page.waitForFunction(() => document.querySelector(".sb-item.active .sb-title")?.textContent.includes("생각해서"));
		await page.locator(".tb-home").click();
		await page.waitForSelector(".session-row");
		await page.locator(".sb-item").first().click();
		await page.waitForSelector(".msg-user");
	});

	await test("tool call row (bash) with output", async () => {
		await send("도구 써줘");
		await page.waitForSelector(".tool-card.tool-bash.st-done", { timeout: 15000 });
		await waitIdle();
		assert.match(await page.locator(".tool-bash .tool-pre").first().innerText(), /package\.json/);
		await shot("tool-bash");
	});

	await test("exploration steps collapse into one summary row", async () => {
		await send("코드 탐색해줘");
		await page.waitForFunction(() => document.body.innerText.includes("함수는 src/greet.js에 있습니다"));
		await waitIdle();
		await page.waitForSelector(".ctx-group");
		const sum = await page.locator(".ctx-group .group-sum").last().innerText();
		assert.match(sum, /파일 2개 읽음/);
		assert.match(sum, /검색 1회/);
		assert.match(sum, /목록 1회/);
		await page.locator(".ctx-group .group-head").last().click();
		await page.waitForSelector(".ctx-group.open .group-items .tool-card.tool-read");
		await shot("explore-group");
	});

	await test("edit diff, write, changed files and review panel", async () => {
		await send("수정해줘");
		await page.waitForSelector(".tool-card.tool-edit.st-done", { timeout: 15000 });
		await waitIdle();
		assert.ok(await page.locator(".tool-edit .dl.add").count());
		assert.ok(await page.locator(".tool-edit .dl.del").count());
		assert.ok(await page.locator(".tool-card.tool-write").count());
		await page.waitForSelector(".turn-changes .change-row");
		assert.equal(await page.locator(".turn-changes").last().locator(".change-row").count(), 2);
		await page.locator(".turn-changes .change-row").first().click();
		await page.waitForSelector("#review:not(.hidden) .review-file");
		assert.equal(await page.locator("#review .review-file").count(), 2);
		await page.waitForTimeout(400);
		await shot("review-panel");
		await page.keyboard.press("Control+Shift+E");
		await page.waitForSelector("#review.hidden", { state: "attached" });
	});

	await test("extension confirm is docked above the composer", async () => {
		await send("확인 필요한 작업");
		await page.waitForSelector(".dock .ext-dialog", { timeout: 15000 });
		assert.match(await page.locator(".ext-dialog .dialog-message").innerText(), /rm -rf build/);
		await page.waitForSelector(".status-pill.waiting");
		await shot("confirm-dock");
		await page.locator(".ext-dialog .btn.primary").click();
		await waitIdle();
		await page.waitForFunction(() => document.body.innerText.includes("승인되어 실행했습니다"));
		assert.equal(await page.locator(".ext-dialog").count(), 0);
	});

	await test("select (number key) + input dialogs", async () => {
		await send("선택해줘");
		await page.waitForSelector(".ext-dialog .list-item");
		await page.keyboard.press("2");
		await page.waitForSelector(".ext-dialog input.input");
		await page.locator(".ext-dialog input.input").fill("fix: 웹 UI");
		await page.keyboard.press("Enter");
		await waitIdle();
		await page.waitForFunction(() => document.body.innerText.includes("선택: develop, 입력: fix: 웹 UI"));
	});

	await test("steer while running, queue panel, Esc abort restores queue", async () => {
		await send("긴 글 써줘");
		await page.waitForSelector(".status-pill.running");
		await page.waitForSelector(".md.streaming");
		await page.waitForSelector(".working-label");
		await input().fill("방향을 바꿔줘");
		await page.keyboard.press("Enter");
		await page.waitForSelector(".queue-item.steer");
		await input().fill("끝나면 요약");
		await page.keyboard.press("Control+Enter");
		await page.waitForSelector(".queue-item.follow");
		await shot("queue");
		await page.keyboard.press("Escape");
		await waitIdle();
		await page.waitForSelector(".msg-aborted");
		const restored = await input().inputValue();
		assert.match(restored, /방향을 바꿔줘/);
		assert.match(restored, /끝나면 요약/);
		await input().fill("");
	});

	await test("steering is delivered after the current turn", async () => {
		await send("긴 글 써줘");
		await page.waitForSelector(".md.streaming");
		await input().fill("조향 메시지입니다");
		await page.keyboard.press("Enter");
		await page.waitForSelector(".queue-item.steer");
		await waitIdle();
		await page.waitForFunction(() => [...document.querySelectorAll(".msg-user .user-text")].some((e) => e.textContent === "조향 메시지입니다"));
		assert.equal(await page.locator(".queue-bar.hidden").count(), 1);
	});

	await test("slash popup + /stats builtin", async () => {
		await input().fill("/st");
		await page.waitForSelector(".popup:not(.hidden) .popup-item");
		await shot("slash-popup");
		await input().fill("/stats");
		await page.keyboard.press("Enter");
		await page.waitForSelector("table.stats");
		await page.keyboard.press("Escape");
	});

	await test("@ file autocomplete", async () => {
		await input().fill("이 파일 봐줘 @butt");
		await page.waitForSelector(".popup:not(.hidden) .popup-item");
		assert.match(await page.locator(".popup .popup-item.sel").innerText(), /Button\.tsx/);
		await page.keyboard.press("Enter");
		assert.equal(await input().inputValue(), "이 파일 봐줘 @src/components/Button.tsx ");
		await input().fill("");
	});

	await test("! bash command runs and lands in transcript", async () => {
		await send("!echo hello-from-bash && echo line2");
		await page.waitForFunction(() => [...document.querySelectorAll(".msg.bash .tool-pre")].some((e) => e.textContent.includes("hello-from-bash")));
		await waitIdle();
		assert.ok(await page.locator(".msg.bash .badge.ok").count());
	});

	await test("model picker from the composer bar; thinking control follows model", async () => {
		await page.locator(".model-btn").click();
		await page.waitForSelector(".modal .list-item");
		await shot("model-picker");
		await page.locator(".modal input").fill("mini");
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => document.querySelector(".model-btn")?.textContent.includes("Fake Mini"));
		await page.waitForSelector(".thinking-select.hidden", { state: "attached" });
		await page.locator(".model-btn").click();
		await page.locator(".modal input").fill("fake-sonnet");
		await page.keyboard.press("Enter");
		await page.waitForSelector(".thinking-select:not(.hidden)");
		await page.locator(".thinking-select").click();
		await page.locator(".menu-item", { hasText: "높음" }).click();
		await page.waitForFunction(() => document.querySelector(".thinking-select")?.textContent.includes("높음"));
	});

	await test("image attachment via file input", async () => {
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
		await page.locator(".composer input[type=file]").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
		await page.waitForSelector(".attach img");
		await send("이 이미지 설명해줘");
		await page.waitForSelector(".msg-user .user-imgs img");
		await waitIdle();
		await page.waitForFunction(() => document.body.innerText.includes("이미지 1장을 받았습니다"));
	});

	await test("compact via slash command", async () => {
		await send("/compact");
		await page.waitForSelector(".msg.summary", { timeout: 15000 });
		await waitIdle();
		await page.waitForFunction(() => document.body.innerText.includes("컨텍스트 압축 완료"));
	});

	await test("rename session updates header and tab", async () => {
		await send("/name 웹 UI 작업");
		await page.waitForFunction(() => document.querySelector(".session-title")?.textContent === "웹 UI 작업");
		await page.waitForFunction(() => document.querySelector(".sb-item.active .sb-title")?.textContent === "웹 UI 작업");
	});

	await test("session menu toggles auto-compaction", async () => {
		await page.locator('.icon-btn[title="메뉴"]').click();
		await page.locator(".menu-item", { hasText: "자동 압축 끄기" }).click();
		await page.waitForSelector(".toast", { hasText: "껐습니다" });
		await page.locator('.icon-btn[title="메뉴"]').click();
		await page.waitForSelector(".menu-item:has-text('자동 압축 켜기')");
		await page.locator(".menu-item", { hasText: "자동 압축 켜기" }).click();
		await page.waitForSelector(".toast", { hasText: "켰습니다" });
	});

	await test("error message + retry notices", async () => {
		await send("오류 내줘");
		await page.waitForSelector(".msg-error");
		await waitIdle();
		assert.ok(await page.locator(".notice.error").count());
	});

	await test("reload restores the live session from snapshot", async () => {
		const before = await page.locator(".msg-user").count();
		await page.reload();
		await page.waitForSelector(".msg-user");
		await page.waitForFunction((n) => document.querySelectorAll(".msg-user").length === n, before);
		await page.waitForSelector(".status-pill.idle");
	});

	await test("fork from an earlier message", async () => {
		await send("/fork");
		await page.waitForSelector(".modal .list-item");
		await page.locator(".modal .list-item").last().click();
		await page.waitForFunction(() => document.querySelector(".composer-input").value.includes("생각해서 정리해줘"));
		await page.waitForFunction(() => document.querySelectorAll(".msg-user").length === 0);
		await page.waitForSelector(".new-session:not(.hidden)");
	});

	await test("open saved session from home, then a new tab", async () => {
		await page.locator(".tb-home").click();
		await page.waitForFunction(() => [...document.querySelectorAll(".session-row")].some((e) => e.textContent.includes("웹 UI 작업")));
		await page.locator(".session-row", { hasText: "웹 UI 작업" }).click();
		await page.waitForFunction(() => document.querySelector(".session-title")?.textContent === "웹 UI 작업");
		await page.waitForSelector(".msg.summary");
		await shot("reopened");
		const tabs = await page.locator(".sb-item").count();
		await page.locator(".sb-new").click();
		await page.waitForFunction((n) => document.querySelectorAll(".sb-item").length === n + 1, tabs);
		await page.waitForSelector(".new-session:not(.hidden)");
	});

	await test("command palette opens a session", async () => {
		await page.keyboard.press("Control+k");
		await page.waitForSelector(".modal.palette .list-item");
		await shot("palette");
		await page.locator(".modal.palette input").fill("웹 UI");
		await page.waitForSelector(".modal.palette .list-item.sel");
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => document.querySelector(".session-title")?.textContent === "웹 UI 작업");
	});

	await test("folder picker lists directories", async () => {
		await page.locator(".tb-home").click();
		await page.locator(".project-btn").click();
		await page.waitForSelector(".modal .dir-list .list-item");
		assert.ok(await page.locator(".modal .dir-list .list-item", { hasText: "src" }).count());
		await page.keyboard.press("Escape");
		await page.locator(".sb-item", { hasText: "웹 UI 작업" }).click();
		await page.waitForSelector(".msg.summary");
	});

	await test("new session screen: create a project folder and start there", async () => {
		await page.locator(".tb-home").click();
		await page.locator(".new-btn").click();
		await page.waitForSelector(".new-session:not(.hidden) .ns-create");
		await page.locator(".ns-create").click();
		await page.waitForSelector(".modal .mkdir-row:not(.hidden)");
		// the picker starts in the default work folder (created by the server)
		assert.equal(await page.locator(".modal input.mono").inputValue(), defaultDir);
		assert.ok(fsExists(defaultDir));
		// invalid name is rejected by the server and shown inline
		await page.locator(".modal .mkdir-row input").fill("a/b");
		await page.locator(".modal .mkdir-row .btn.primary").click();
		await page.waitForFunction(() => document.querySelector(".modal .mkdir-row .form-error")?.textContent.length > 0);
		await shot("mkdir-error");
		await page.locator(".modal .mkdir-row input").fill("brand-new-app");
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => document.querySelector(".modal .dir-list")?.parentElement && document.querySelector(".modal input.mono")?.value.endsWith("brand-new-app"));
		// duplicate name fails
		await page.locator(".modal .dir-list .list-item", { hasText: "상위 폴더" }).click();
		await page.waitForFunction(() => !document.querySelector(".modal input.mono")?.value.endsWith("brand-new-app"));
		await page.locator(".modal-actions .left").click();
		await page.locator(".modal .mkdir-row input").fill("brand-new-app");
		await page.locator(".modal .mkdir-row .btn.primary").click();
		await page.waitForSelector(".modal .mkdir-row .form-error:not(:empty)");
		await shot("mkdir");
		await page.locator(".modal .dir-list .list-item", { hasText: "brand-new-app" }).click();
		await page.waitForFunction(() => document.querySelector(".modal input.mono")?.value.endsWith("brand-new-app"));
		await page.locator(".modal-actions .btn.primary", { hasText: "이 폴더로 시작" }).click();
		await page.waitForFunction(() => document.querySelector(".new-session .ns-row b")?.textContent === "brand-new-app");
		await page.waitForSelector(".sb-item.active");
		assert.ok(fsExists(path.join(defaultDir, "brand-new-app")));
		// point at an existing folder via the same button, typing its path
		await page.locator(".ns-create").click();
		await page.waitForSelector(".modal .dir-list");
		await page.locator(".modal input.mono").fill(proj);
		await page.keyboard.press("Enter");
		await page.waitForFunction((p) => document.querySelector(".modal input.mono")?.value === p, proj);
		await page.locator(".modal-actions .btn.primary", { hasText: "이 폴더로 시작" }).click();
		await page.waitForFunction(() => document.querySelector(".new-session .ns-row b")?.textContent === "my-project");
		// "기본 폴더로" jumps back to the default folder
		await page.locator(".ns-default").click();
		await page.waitForFunction(() => document.querySelector(".new-session .ns-row b")?.textContent === "pi");
		await page.locator(".sb-item", { hasText: "웹 UI 작업" }).click();
		await page.waitForSelector(".msg.summary");
	});

	await test("crashed pi shows stderr and restart button", async () => {
		await send("크래시 테스트");
		await page.waitForSelector(".exited-box");
		assert.match(await page.locator(".exited-box pre").innerText(), /simulated crash/);
		await page.waitForSelector(".status-pill.exited");
		await shot("crashed");
		await page.locator(".exited-box .btn").click();
		await page.waitForSelector(".status-pill.idle");
		assert.equal(await page.locator(".exited-box").count(), 0);
		await page.waitForSelector(".msg.summary");
	});

	await test("dark theme renders", async () => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.evaluate(() => localStorage.removeItem("piweb.theme"));
		await page.waitForTimeout(300);
		await shot("dark");
		await page.locator(".tb-home").click();
		await shot("dark-home");
		await page.locator(".sb-item", { hasText: "웹 UI 작업" }).click();
	});

	await test("narrow window", async () => {
		await page.setViewportSize({ width: 760, height: 900 });
		await page.waitForTimeout(300);
		await shot("narrow");
	});

	await test("account dialog: api key login, subscription login, logout", async () => {
		await page.locator('.icon-btn[title="계정 · 로그인"]').click();
		await page.waitForSelector(".modal .provider-row");
		assert.equal(await page.locator(".modal .provider-row").count(), 3);
		await shot("account");
		// API key for OpenAI
		const openai = page.locator(".provider-row", { hasText: "OpenAI" });
		await openai.locator(".btn", { hasText: "API 키" }).click();
		await page.waitForSelector('.auth-prompt input[type="password"]');
		await page.locator('.auth-prompt input[type="password"]').fill("sk-test-key");
		await page.keyboard.press("Enter");
		await page.waitForSelector(".auth-done");
		await page.waitForFunction(() => !document.querySelector(".auth-flow"), null, { timeout: 8000 });
		await page.waitForFunction(() => /API 키 저장됨/.test(document.querySelector(".provider-row:nth-child(1)")?.textContent || "") || [...document.querySelectorAll(".provider-row")].some((r) => /OpenAI/.test(r.textContent) && /API 키 저장됨/.test(r.textContent)));
		// subscription login for Anthropic: auth link + pasted code
		await page.locator(".provider-row", { hasText: "Anthropic" }).locator(".btn", { hasText: "구독 로그인" }).click();
		await page.waitForSelector("a.auth-link");
		assert.equal(await page.locator("a.auth-link").getAttribute("href"), "https://example.com/oauth?state=1");
		assert.equal(await page.locator("a.auth-link").getAttribute("rel"), "noopener noreferrer");
		await shot("login-flow");
		await page.locator('.auth-prompt input[type="text"]').fill("pasted-code");
		await page.keyboard.press("Enter");
		await page.waitForSelector(".auth-done");
		await page.waitForFunction(() => !document.querySelector(".auth-flow"), null, { timeout: 8000 });
		await page.waitForFunction(() => [...document.querySelectorAll(".provider-row")].some((r) => /Anthropic/.test(r.textContent) && /구독 계정으로 로그인됨/.test(r.textContent)));
		// logout
		await page.locator(".provider-row", { hasText: "Anthropic" }).locator(".btn", { hasText: "로그아웃" }).click();
		await page.waitForFunction(() => [...document.querySelectorAll(".provider-row")].some((r) => /Anthropic/.test(r.textContent) && /연결 안 됨/.test(r.textContent)));
		// cancelling a flow leaves nothing behind
		await page.locator(".provider-row", { hasText: "Anthropic" }).locator(".btn", { hasText: "구독 로그인" }).click();
		await page.waitForSelector(".auth-prompt");
		await page.locator(".modal-actions .btn", { hasText: "취소" }).last().click();
		await page.waitForFunction(() => !document.querySelector(".auth-flow"));
		assert.ok(await page.locator(".provider-row", { hasText: "Anthropic" }).locator("text=연결 안 됨").count());
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !document.querySelector(".modal"));
	});

	await test("settings dialog: save, live apply, reset", async () => {
		await page.locator('.icon-btn[title="설정"]').click();
		await page.waitForSelector(".modal .set-row");
		await shot("settings");
		// enum: steering mode (applied live to the active session)
		const row = page.locator(".set-row", { hasText: "끼어들기 전달 방식" });
		await row.locator("select").selectOption("all");
		await page.waitForSelector(".toast", { hasText: "현재 세션에 적용" });
		await page.waitForFunction(() => [...document.querySelectorAll(".set-row")].some((r) => /끼어들기 전달 방식/.test(r.textContent) && r.querySelector(".link-btn")));
		// number
		const num = page.locator(".set-row", { hasText: "최대 재시도 횟수" }).locator("input");
		await num.fill("5");
		await num.press("Enter");
		await page.waitForFunction(() => [...document.querySelectorAll(".set-row")].some((r) => /최대 재시도 횟수/.test(r.textContent) && r.querySelector(".link-btn")));
		// toggle: auto compaction, then restart hint appears for non-live settings
		await page.locator(".set-row", { hasText: "이미지 자동 축소" }).locator(".switch").click();
		await page.waitForSelector(".settings-foot .btn", { hasText: "다시 시작" });
		// persisted on disk through the API
		const saved = await page.evaluate(() => fetch("/api/settings").then((r) => r.json()));
		assert.equal(saved.values.steeringMode, "all");
		assert.equal(saved.values["retry.maxRetries"], 5);
		assert.equal(saved.values["images.autoResize"], false);
		// reset to default
		await row.locator(".link-btn").click();
		await page.waitForFunction(() => ![...document.querySelectorAll(".set-row")].some((r) => /끼어들기 전달 방식/.test(r.textContent) && r.querySelector(".link-btn")));
		await page.keyboard.press("Escape");
	});

	await test("native folder dialog (simulated): 프로젝트 생성 picks via the OS dialog", async () => {
		const picked = path.join(tmp, "picked-by-dialog");
		mkdirSync(picked, { recursive: true });
		const port2 = PORT + 100;
		const run = (pick) =>
			spawn(process.execPath, [path.join(ROOT, "server.mjs"), "--port", String(port2), "--cwd", proj], {
				env: { ...process.env, PI_CLI: path.join(ROOT, "test", "fake-pi.mjs"), PI_CODING_AGENT_DIR: agentDir, PI_WEB_DEFAULT_DIR: defaultDir, PI_WEB_TEST_PICK: pick },
				stdio: ["ignore", "pipe", "pipe"],
			});
		const waitUp = () => new Promise((r) => setTimeout(r, 900));
		let s2 = run(picked);
		try {
			await waitUp();
			const p2 = await context.newPage();
			await p2.goto(`http://127.0.0.1:${port2}`);
			await p2.locator(".new-btn").click();
			await p2.waitForSelector(".new-session:not(.hidden) .ns-create");
			await p2.locator(".ns-create").click();
			// no in-page modal: the OS dialog answered directly
			await p2.waitForFunction(() => document.querySelector(".new-session .ns-row b")?.textContent === "picked-by-dialog");
			assert.equal(await p2.locator(".modal").count(), 0);
			await p2.close();
			// cancelling the dialog changes nothing
			s2.kill("SIGINT");
			await new Promise((r) => setTimeout(r, 300));
			s2 = run("cancel");
			await waitUp();
			const p3 = await context.newPage();
			await p3.goto(`http://127.0.0.1:${port2}`);
			await p3.locator(".new-btn").click();
			await p3.waitForSelector(".new-session:not(.hidden) .ns-create");
			await p3.locator(".ns-create").click();
			await p3.waitForTimeout(400);
			assert.equal(await p3.locator(".new-session .ns-row b").first().innerText(), "my-project");
			await p3.close();
		} finally {
			s2.kill("SIGINT");
		}
	});

	assert.deepEqual(consoleErrors, [], `console errors:\n${consoleErrors.join("\n")}`);
	console.log(`e2e: ${passed} passed`);
} catch (err) {
	console.error(err);
	console.error("--- server log ---\n", serverLog.slice(-4000));
	if (consoleErrors.length) console.error("--- console errors ---\n", consoleErrors.join("\n"));
	process.exitCode = 1;
} finally {
	await browser.close();
	server.kill("SIGINT");
	await new Promise((r) => setTimeout(r, 300));
	rmSync(tmp, { recursive: true, force: true });
}
