// Integration test for the login + settings endpoints against the fake pi package.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(tmpdir(), "piweb-auth-"));
const agentDir = path.join(tmp, "agent");
mkdirSync(agentDir, { recursive: true });
const cwd = path.join(tmp, "proj");
mkdirSync(cwd);

async function run(label, env, fn) {
	const port = 9100 + Math.floor(Math.random() * 400);
	const server = spawn(process.execPath, [path.join(ROOT, "server.mjs"), "--port", String(port), "--cwd", cwd], {
		env: { ...process.env, PI_CLI: path.join(ROOT, "test", "fake-pi.mjs"), PI_CODING_AGENT_DIR: agentDir, PI_WEB_DEFAULT_DIR: path.join(tmp, "def"), ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	server.stdout.on("data", (d) => (log += d));
	server.stderr.on("data", (d) => (log += d));
	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`no start\n${log}`)), 8000);
		server.stdout.on("data", () => log.includes("실행 중") && (clearTimeout(t), resolve()));
	});
	const base = `http://127.0.0.1:${port}`;
	const call = async (method, url, body) => {
		const r = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
		return { status: r.status, body: await r.json().catch(() => null) };
	};
	try {
		await fn(call, base);
		console.log(`✓ ${label}`);
	} catch (err) {
		console.error(`✗ ${label}\n${log.slice(-2000)}`);
		throw err;
	} finally {
		server.kill("SIGINT");
		await new Promise((r) => setTimeout(r, 200));
	}
}

async function poll(call, flowId, until, since = 0) {
	for (let i = 0; i < 60; i++) {
		const r = await call("GET", `/api/auth/flows/${flowId}?since=${since}`);
		assert.equal(r.status, 200);
		if (until(r.body.flow)) return r.body;
		await new Promise((r2) => setTimeout(r2, 100));
	}
	throw new Error("flow did not reach expected state");
}

try {
	await run("sdk mode: providers, api-key login, oauth login, logout", { PI_WEB_PI_PACKAGE: path.join(ROOT, "test", "fake-pi-pkg") }, async (call) => {
		let st = (await call("GET", "/api/auth/status")).body;
		assert.equal(st.mode, "sdk");
		assert.deepEqual(st.providers.map((p) => p.id).sort(), ["anthropic", "device-co", "openai"]);
		assert.ok(st.providers.every((p) => !p.configured));
		assert.ok(st.providers.find((p) => p.id === "anthropic").subscription);

		// API key login: secret prompt → answer → stored (key never shown in events/status)
		let r = await call("POST", "/api/auth/login", { provider: "openai", type: "api_key" });
		assert.equal(r.status, 200);
		let body = await poll(call, r.body.flow.id, (f) => f.events.some((e) => e.kind === "prompt"));
		const prompt = body.flow.events.find((e) => e.kind === "prompt");
		assert.equal(prompt.ptype, "secret");
		assert.equal((await call("POST", `/api/auth/flows/${r.body.flow.id}/answer`, { promptId: prompt.promptId, value: "sk-secret-123" })).status, 200);
		body = await poll(call, r.body.flow.id, (f) => f.status === "done");
		assert.ok(!JSON.stringify(body).includes("sk-secret-123"));
		assert.equal(JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8")).openai.key, "sk-secret-123");
		st = (await call("GET", "/api/auth/status")).body;
		assert.equal(st.providers.find((p) => p.id === "openai").configured, true);
		assert.ok(!JSON.stringify(st).includes("sk-secret-123"));

		// answering twice / unknown prompt is rejected
		assert.equal((await call("POST", `/api/auth/flows/${r.body.flow.id}/answer`, { promptId: prompt.promptId, value: "x" })).status, 409);

		// OAuth login with info + auth_url + manual code
		r = await call("POST", "/api/auth/login", { provider: "anthropic", type: "oauth" });
		body = await poll(call, r.body.flow.id, (f) => f.events.some((e) => e.kind === "prompt"));
		const kinds = body.flow.events.map((e) => e.kind);
		assert.ok(kinds.includes("info") && kinds.includes("auth_url"));
		assert.equal(body.flow.events.find((e) => e.kind === "auth_url").url, "https://example.com/oauth?state=1");
		const p2 = body.flow.events.find((e) => e.kind === "prompt");
		assert.equal(p2.ptype, "manual_code");
		await call("POST", `/api/auth/flows/${r.body.flow.id}/answer`, { promptId: p2.promptId, value: "the-code" });
		body = await poll(call, r.body.flow.id, (f) => f.status === "done");
		assert.ok(body.authChange);
		st = (await call("GET", "/api/auth/status")).body;
		const an = st.providers.find((p) => p.id === "anthropic");
		assert.equal(an.configured, true);
		assert.equal(an.usingOAuth, true);

		// a failed flow reports the error
		r = await call("POST", "/api/auth/login", { provider: "device-co", type: "oauth" });
		body = await poll(call, r.body.flow.id, (f) => f.events.some((e) => e.kind === "device_code"));
		assert.equal(body.flow.events.find((e) => e.kind === "device_code").userCode, "ABCD-1234");
		await poll(call, r.body.flow.id, (f) => f.status === "done");

		// cancel a pending prompt
		await call("POST", "/api/auth/logout", { provider: "anthropic" });
		r = await call("POST", "/api/auth/login", { provider: "anthropic", type: "oauth" });
		await poll(call, r.body.flow.id, (f) => f.events.some((e) => e.kind === "prompt"));
		assert.equal((await call("POST", "/api/auth/login", { provider: "anthropic", type: "oauth" })).status, 409);
		await call("DELETE", `/api/auth/flows/${r.body.flow.id}`);
		body = await poll(call, r.body.flow.id, (f) => f.status === "cancelled");

		// bad code → error status
		r = await call("POST", "/api/auth/login", { provider: "anthropic", type: "oauth" });
		body = await poll(call, r.body.flow.id, (f) => f.events.some((e) => e.kind === "prompt"));
		await call("POST", `/api/auth/flows/${r.body.flow.id}/answer`, { promptId: body.flow.events.find((e) => e.kind === "prompt").promptId, value: "bad" });
		body = await poll(call, r.body.flow.id, (f) => f.status === "error");
		assert.match(body.flow.events.at(-1).message, /invalid code/);

		// logout
		assert.equal((await call("POST", "/api/auth/logout", { provider: "openai" })).status, 200);
		assert.equal(JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8")).openai, undefined);
		// validation
		assert.equal((await call("POST", "/api/auth/login", { provider: "../x y", type: "api_key" })).status, 400);
		assert.equal((await call("POST", "/api/auth/login", { provider: "openai", type: "nope" })).status, 400);
	});

	rmSync(path.join(agentDir, "auth.json"), { force: true });
	await run("file mode (no pi library): api key saved to auth.json, oauth refused", { PI_WEB_PI_PACKAGE: path.join(tmp, "missing"), PI_WEB_NO_GLOBAL_PI: "1", PI_CLI: path.join(ROOT, "test", "fake-pi.mjs") }, async (call) => {
		const st = (await call("GET", "/api/auth/status")).body;
		assert.equal(st.mode, "file");
		assert.match(st.sdkError, /찾지 못했/);
		assert.ok(st.sdkTried.some((d) => d.includes("missing")));
		// terminal login is only available on Windows/macOS; here it must fail cleanly and polling stays idle
		if (process.platform !== "win32" && process.platform !== "darwin") assert.equal((await call("POST", "/api/auth/terminal")).status, 501);
		assert.equal((await call("GET", "/api/auth/terminal")).body.changed, false);
		// recheck re-runs the lookup
		assert.equal((await call("POST", "/api/auth/recheck")).body.mode, "file");
		assert.ok(st.providers.some((p) => p.id === "anthropic"));
		let r = await call("POST", "/api/auth/login", { provider: "anthropic", type: "oauth" });
		assert.equal(r.body.flow.status, "error");
		r = await call("POST", "/api/auth/login", { provider: "groq", type: "api_key" });
		const body = await poll(call, r.body.flow.id, (f) => f.events.some((e) => e.kind === "prompt"));
		await call("POST", `/api/auth/flows/${r.body.flow.id}/answer`, { promptId: body.flow.events.find((e) => e.kind === "prompt").promptId, value: " gsk-1 " });
		await poll(call, r.body.flow.id, (f) => f.status === "done");
		assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8")).groq, { type: "api_key", key: "gsk-1" });
		assert.equal((await call("POST", "/api/auth/logout", { provider: "groq" })).status, 200);
		assert.equal((await call("POST", "/api/auth/logout", { provider: "groq" })).status, 404);
	});

	await run("settings: read, validated write, unknown keys kept, reset", {}, async (call) => {
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", compaction: { enabled: true, extra: 1 }, packages: ["x"] }, null, 2));
		let s = (await call("GET", "/api/settings")).body;
		assert.equal(s.values["compaction.enabled"], true);
		assert.ok(s.fields.length > 10);
		s = (await call("POST", "/api/settings", { changes: { steeringMode: "all", "compaction.keepRecentTokens": 12345, "retry.enabled": false, defaultTools: ["read", "grep"], httpProxy: " http://127.0.0.1:1 " } })).body;
		const file = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		assert.equal(file.theme, "dark");
		assert.deepEqual(file.packages, ["x"]);
		assert.equal(file.compaction.extra, 1);
		assert.equal(file.compaction.keepRecentTokens, 12345);
		assert.equal(file.steeringMode, "all");
		assert.equal(file.retry.enabled, false);
		assert.deepEqual(file.defaultTools, ["read", "grep"]);
		assert.equal(file.httpProxy, "http://127.0.0.1:1");
		// reset → key removed, emptied containers pruned, others untouched
		await call("POST", "/api/settings", { changes: { "retry.enabled": null, steeringMode: null } });
		const file2 = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		assert.equal(file2.retry, undefined);
		assert.equal(file2.steeringMode, undefined);
		assert.equal(file2.theme, "dark");
		// rejected writes
		assert.equal((await call("POST", "/api/settings", { changes: { steeringMode: "bogus" } })).status, 400);
		assert.equal((await call("POST", "/api/settings", { changes: { "compaction.reserveTokens": -1 } })).status, 400);
		assert.equal((await call("POST", "/api/settings", { changes: { "compaction.reserveTokens": 1.5 } })).status, 400);
		assert.equal((await call("POST", "/api/settings", { changes: { theme: "light" } })).status, 400);
		assert.equal((await call("POST", "/api/settings", { changes: { defaultTools: ["rm"] } })).status, 400);
		assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")), file2);
		// corrupt file is never overwritten
		writeFileSync(path.join(agentDir, "settings.json"), "{ nope");
		assert.equal((await call("POST", "/api/settings", { changes: { steeringMode: "all" } })).status, 409);
		assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), "{ nope");
		assert.equal((await call("GET", "/api/settings")).status, 409);
	});
	// pi update: version lookup against a local stand-in for pi.dev, then `pi update` through the fake pi
	const CHANGELOG = ["# Changelog", "", "## [Unreleased]", "", "- x", "", "## [1.1.0] - 2026-10-07", "", "### Added", "", "- 새 기능 A", "", "## [1.0.5] - 2026-10-01", "", "### Fixed", "", "- 고침 B", "", "## [1.0.0] - 2026-09-01", "", "- first", ""].join("\n");
	const latest = http.createServer((req, res) => {
		if (req.url.endsWith("/changelog")) return res.end(CHANGELOG);
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ ok: true, version: "1.1.0", packageName: "@earendil-works/pi-coding-agent", note: "테스트 노트" }));
	});
	await new Promise((r) => latest.listen(0, "127.0.0.1", r));
	const versionFile = path.join(tmp, "pi-version.txt");
	const upEnv = { PI_WEB_LATEST_URL: `http://127.0.0.1:${latest.address().port}/`, PI_WEB_CHANGELOG_URL: `http://127.0.0.1:${latest.address().port}/changelog`, FAKE_PI_VERSION_FILE: versionFile, PI_WEB_PI_PACKAGE: path.join(tmp, "missing"), PI_WEB_NO_GLOBAL_PI: "1" };
	try {
		await run("pi update: status, run, success", upEnv, async (call) => {
			let st = (await call("GET", "/api/pi/update?refresh=1")).body;
			assert.equal(st.current, "1.0.0");
			assert.equal(st.latest, "1.1.0");
			assert.equal(st.updateAvailable, true);
			assert.equal(st.note, "테스트 노트");
			// release notes: only versions newer than the installed one, newest first
			const cl = (await call("GET", "/api/pi/changelog")).body;
			assert.deepEqual(cl.entries.map((e) => e.version), ["1.1.0", "1.0.5"]);
			assert.equal(cl.entries[0].date, "2026-10-07");
			assert.match(cl.entries[0].markdown, /새 기능 A/);
			assert.equal(cl.forCurrent, false);
			const start = await call("POST", "/api/pi/update", {});
			assert.equal(start.status, 200);
			for (let i = 0; i < 60 && st.job.state !== "done" && st.job.state !== "error"; i++) {
				await new Promise((r) => setTimeout(r, 150));
				st = (await call("GET", "/api/pi/update")).body;
			}
			assert.equal(st.job.state, "done", st.job.log);
			assert.match(st.job.log, /Updated to 1\.1\.0/);
			assert.equal(st.current, "1.1.0");
			assert.equal(st.updateAvailable, false);
			// up to date: notes of the installed version
			const cur = (await call("GET", "/api/pi/changelog")).body;
			assert.deepEqual(cur.entries.map((e) => e.version), ["1.1.0"]);
			assert.equal(cur.forCurrent, true);
		});
		writeFileSync(versionFile, "1.0.0\n");
		await run("pi update: failure is reported, refused while a session is busy", { ...upEnv, FAKE_PI_UPDATE_FAIL: "1" }, async (call) => {
			await call("GET", "/api/pi/update?refresh=1");
			assert.equal((await call("POST", "/api/pi/update", {})).status, 200);
			let st;
			for (let i = 0; i < 60; i++) {
				await new Promise((r) => setTimeout(r, 150));
				st = (await call("GET", "/api/pi/update")).body;
				if (st.job.state !== "running") break;
			}
			assert.equal(st.job.state, "error");
			assert.match(st.job.log, /EBUSY/);
			assert.equal(st.updateAvailable, true);
			// a working session blocks the update
			const open = await call("POST", "/api/live", { cwd });
			const id = open.body.live.id;
			await new Promise((r) => setTimeout(r, 600));
			await call("POST", `/api/live/${id}/command`, { type: "prompt", message: "긴 작업 해줘" });
			await new Promise((r) => setTimeout(r, 100));
			const blocked = await call("POST", "/api/pi/update", {});
			assert.equal(blocked.status, 409);
		});
	} finally {
		latest.close();
	}
	await run("file upload: stored under the agent dir, name sanitized, size limit", { PI_WEB_MAX_UPLOAD_MB: "1", PI_WEB_PI_PACKAGE: path.join(tmp, "missing"), PI_WEB_NO_GLOBAL_PI: "1" }, async (_call, base) => {
		const up = (name, body) => fetch(base + "/api/upload", { method: "POST", headers: { "X-File-Name": encodeURIComponent(name), "Content-Type": "application/octet-stream" }, body });
		const ok = await up("문서 ../../evil?.txt", "hello 파일");
		assert.equal(ok.status, 200);
		const meta = await ok.json();
		assert.equal(meta.name, "evil_.txt");
		assert.ok(meta.path.startsWith(path.join(agentDir, "web-uploads")), meta.path);
		assert.equal(readFileSync(meta.path, "utf8"), "hello 파일");
		assert.equal(meta.size, Buffer.byteLength("hello 파일"));
		const big = await up("big.bin", Buffer.alloc(1024 * 1024 + 10));
		assert.equal(big.status, 413);
		assert.equal((await up("CON.txt", "x").then((r) => r.json())).name, "_CON.txt");
	});
	console.log("server-auth: all passed");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
