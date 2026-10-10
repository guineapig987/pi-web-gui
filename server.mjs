#!/usr/bin/env node
// pi-web: browser GUI gateway for the pi coding agent. No npm dependencies.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import http from "node:http";
import { homedir, networkInterfaces, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDir, gitBranch, listDirs, searchFiles } from "./lib/files.mjs";
import { LiveManager } from "./lib/live-session.mjs";
import { AuthService } from "./lib/auth-service.mjs";
import { saveUpload } from "./lib/uploads.mjs";
import { nativePickerAvailable, pickFolderNative } from "./lib/native-picker.mjs";
import { resolvePi } from "./lib/pi-launcher.mjs";
import { PiUpdater } from "./lib/pi-update.mjs";
import { readSettings, writeSettings } from "./lib/settings-service.mjs";
import { getAgentDir, getSessionsDir, listProjects, listSessions } from "./lib/session-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const VERSION = "0.1.0";

function parseArgs(argv) {
	const opts = { port: Number(process.env.PI_WEB_PORT || 8787), host: process.env.PI_WEB_HOST || "127.0.0.1", open: false, cwd: process.cwd(), cwdExplicit: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--port" || a === "-p") opts.port = Number(argv[++i]);
		else if (a === "--host") opts.host = argv[++i];
		else if (a === "--open") opts.open = true;
		else if (a === "--remote") opts.remote = true;
		else if (a === "--cwd") {
			opts.cwd = path.resolve(argv[++i]);
			opts.cwdExplicit = true;
		}
		else if (a === "--help" || a === "-h") {
			console.log(`pi-web ${VERSION}

사용법: node server.mjs [옵션]
  --port, -p <번호>   포트 (기본 8787, 환경 변수 PI_WEB_PORT)
  --host <주소>       바인딩 주소 (기본 127.0.0.1)
  --cwd <폴더>        처음 열 프로젝트 폴더 (생략하면 기본 작업 폴더 Documents/pi)
  --open              시작 후 브라우저 열기
  --remote            원격 접속 허용: 모든 네트워크 카드에서 받습니다 (로그인 없음)

환경 변수:
  PI_CLI              pi의 cli.js 또는 실행 파일 경로 (자동 탐색이 안 될 때)
  PI_WEB_PI_ARGS      pi에 추가로 넘길 인자 (예: "--approve")
  PI_WEB_ALLOWED_HOSTS 허용할 Host 헤더 목록 (쉼표로 구분)
  PI_WEB_IDLE_MINUTES 보는 사람 없이 대기 중인 세션을 종료하기까지의 분 (기본 30)`);
			process.exit(0);
		}
	}
	if (opts.remote && !process.env.PI_WEB_HOST && !argv.includes("--host")) opts.host = "0.0.0.0";
	return opts;
}

const opts = parseArgs(process.argv.slice(2));

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
// Reachable from other machines (--remote / non-loopback host): the PC-side dialogs make no sense there.
const REMOTE = !!opts.remote || !LOOPBACK.has(opts.host);
const LOCAL_ONLY = !REMOTE;

// Default working folder for new sessions: PI_WEB_DEFAULT_DIR, else ~/Documents/pi (created on demand).
const DEFAULT_DIR = path.resolve(process.env.PI_WEB_DEFAULT_DIR || path.join(homedir(), "Documents", "pi"));
try {
	mkdirSync(DEFAULT_DIR, { recursive: true });
} catch (err) {
	console.error(`기본 작업 폴더를 만들 수 없습니다 (${DEFAULT_DIR}): ${err.message}`);
}
const launcher = resolvePi();
const manager = new LiveManager({ launcher });
function defaultCwdForTerminal() {
	return existsSync(DEFAULT_DIR) ? DEFAULT_DIR : homedir();
}
// After `pi update`, idle sessions are restarted so they run the new version; busy ones block the update.
const updater = new PiUpdater({
	launcher,
	isBusy: () => manager.list().some((s) => s.status === "running" || s.status === "waiting" || s.status === "compacting"),
	onUpdated: async () => {
		auth.recheck();
		return manager.restartIdle();
	},
});
let lastAuthChange = { restarted: 0, skipped: 0 };
const auth = new AuthService({
	launcher,
	onChanged: async () => {
		lastAuthChange = await manager.restartIdle();
	},
});

// ---------- helpers ----------
const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
};

function contentDisposition(name) {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendJson(res, status, data) {
	const body = JSON.stringify(data);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(body);
}

function sendError(res, err) {
	const status = err?.status || 500;
	sendJson(res, status, { error: err?.message || String(err) });
}

async function readJson(req, limit = 64 * 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw Object.assign(new Error("요청이 너무 큽니다"), { status: 413 });
		chunks.push(chunk);
	}
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw Object.assign(new Error("JSON 형식 오류"), { status: 400 });
	}
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function hostAllowed(req) {
	// Remote mode is meant for a private network (e.g. Tailscale), where the Host header is the PC's own address or name.
	if (REMOTE) return true;
	const host = (req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
	if (LOCAL_HOSTS.has(host)) return true;
	// `tailscale serve` proxies https://<pc>.<tailnet>.ts.net to this loopback server; that name only resolves inside the tailnet.
	if (/\.ts\.net$/.test(host)) return true;
	const extra = (process.env.PI_WEB_ALLOWED_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
	if (opts.host !== "127.0.0.1" && opts.host !== "localhost" && host === opts.host.toLowerCase()) return true;
	return extra.includes(host);
}

function originAllowed(req) {
	const origin = req.headers.origin;
	if (!origin) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}

function serveStatic(req, res, pathname) {
	let rel = decodeURIComponent(pathname);
	if (rel === "/" || rel === "") rel = "/index.html";
	const file = path.normalize(path.join(PUBLIC, rel));
	if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: "forbidden" });
	let st;
	try {
		st = statSync(file);
	} catch {
		return sendJson(res, 404, { error: "not found" });
	}
	if (!st.isFile()) return sendJson(res, 404, { error: "not found" });
	res.writeHead(200, {
		"Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
		"Content-Length": st.size,
		"Cache-Control": "no-cache",
		"X-Content-Type-Options": "nosniff",
	});
	createReadStream(file).pipe(res);
}

function openSse(req, res) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write("retry: 1500\n\n");
	const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
	res.on("close", () => clearInterval(ping));
}

// ---------- global event stream (live list + sessions changed) ----------
const globalClients = new Set();
manager.on("change", (list) => {
	for (const res of globalClients) res.write(`event: live\ndata: ${JSON.stringify(list)}\n\n`);
});
manager.on("sessions", () => {
	for (const res of globalClients) res.write(`event: sessions\ndata: {}\n\n`);
});

// ---------- routes ----------
async function handleApi(req, res, url) {
	const p = url.pathname;
	const m = p.match(/^\/api\/live\/([\w-]+)(?:\/(\w+))?$/);

	if (req.method === "GET" && p === "/api/info") {
		return sendJson(res, 200, {
			version: VERSION,
			platform: platform(),
			sep: path.sep,
			home: homedir(),
			// Started from the pi-web folder itself → let the browser pick the last project instead.
			defaultCwd: opts.cwdExplicit || path.resolve(opts.cwd) !== ROOT ? opts.cwd : null,
			nativePicker: LOCAL_ONLY && nativePickerAvailable(),
			remote: REMOTE,
			defaultDir: existsSync(DEFAULT_DIR) ? DEFAULT_DIR : null,
			agentDir: getAgentDir(),
			sessionsDir: getSessionsDir(),
			pi: launcher.error ? null : { kind: launcher.kind, entry: launcher.entry, source: launcher.source },
			piError: launcher.error || null,
		});
	}
	if (req.method === "GET" && p === "/api/projects") return sendJson(res, 200, { projects: await listProjects() });
	if (req.method === "GET" && p === "/api/sessions") {
		const cwd = url.searchParams.get("cwd") || undefined;
		const sessions = await listSessions({ cwd });
		return sendJson(res, 200, { sessions: sessions.slice(0, Number(url.searchParams.get("limit") || 300)) });
	}
	if (req.method === "GET" && p === "/api/files") {
		const cwd = url.searchParams.get("cwd");
		if (!cwd || !existsSync(cwd)) return sendJson(res, 400, { error: "cwd가 필요합니다" });
		return sendJson(res, 200, { files: await searchFiles(cwd, url.searchParams.get("q") || "") });
	}
	if (req.method === "GET" && p === "/api/project") {
		const cwd = url.searchParams.get("cwd");
		if (!cwd || !existsSync(cwd)) return sendJson(res, 404, { error: "폴더가 없습니다" });
		return sendJson(res, 200, { cwd, branch: await gitBranch(cwd) });
	}
	if (req.method === "GET" && p === "/api/dirs") {
		try {
			return sendJson(res, 200, await listDirs(url.searchParams.get("path") || ""));
		} catch (err) {
			return sendJson(res, 400, { error: err.message });
		}
	}
	// ---- accounts (login / logout) and settings; secrets only travel browser → gateway and are never echoed back
	if (p === "/api/auth/status" && req.method === "GET") return sendJson(res, 200, await auth.status());
	if (p === "/api/auth/login" && req.method === "POST") {
		const body = await readJson(req);
		try {
			return sendJson(res, 200, { flow: await auth.startLogin({ providerId: body.provider, type: body.type }) });
		} catch (err) {
			return sendJson(res, err.status || 500, { error: err.message });
		}
	}
	const af = /^\/api\/auth\/flows\/([\w-]+)(?:\/(answer))?$/.exec(p);
	if (af) {
		const flow = auth.getFlow(af[1]);
		if (!flow) return sendJson(res, 404, { error: "로그인 진행 정보를 찾을 수 없습니다" });
		if (req.method === "GET" && !af[2]) return sendJson(res, 200, { flow: auth.flowView(flow, Number(url.searchParams.get("since")) || 0), authChange: flow.status === "done" ? lastAuthChange : null });
		if (req.method === "POST" && af[2] === "answer") {
			const body = await readJson(req);
			try {
				auth.answer(af[1], String(body.promptId || ""), body.value);
				return sendJson(res, 200, { ok: true });
			} catch (err) {
				return sendJson(res, err.status || 500, { error: err.message });
			}
		}
		if (req.method === "DELETE" && !af[2]) return sendJson(res, 200, { ok: auth.cancel(af[1]) });
	}
	if (p === "/api/auth/recheck" && req.method === "POST") {
		auth.recheck();
		return sendJson(res, 200, await auth.status());
	}
	if (p === "/api/auth/terminal" && req.method === "POST") {
		if (!LOCAL_ONLY) return sendJson(res, 403, { error: "원격 접속 중에는 터미널을 열 수 없습니다" });
		try {
			return sendJson(res, 200, await auth.openTerminalLogin(defaultCwdForTerminal()));
		} catch (err) {
			return sendJson(res, err.code === "UNSUPPORTED" ? 501 : 500, { error: err.message });
		}
	}
	if (p === "/api/auth/terminal" && req.method === "GET") return sendJson(res, 200, { ...(await auth.pollTerminalLogin()), ...lastAuthChange });
	if (p === "/api/auth/logout" && req.method === "POST") {
		const body = await readJson(req);
		try {
			await auth.logout(body.provider);
			return sendJson(res, 200, { ok: true, ...lastAuthChange });
		} catch (err) {
			return sendJson(res, err.status || 500, { error: err.message });
		}
	}
	// ---- pi version check and `pi update`
	if (p === "/api/pi/update" && req.method === "GET") return sendJson(res, 200, await updater.check({ force: url.searchParams.get("refresh") === "1" }));
	if (p === "/api/pi/changelog" && req.method === "GET") return sendJson(res, 200, await updater.changelog());
	if (p === "/api/pi/update" && req.method === "POST") {
		const body = await readJson(req);
		try {
			return sendJson(res, 200, updater.start({ force: body.force === true }));
		} catch (err) {
			return sendJson(res, err.status || 500, { error: err.message });
		}
	}
	if (p === "/api/settings" && req.method === "GET") {
		try {
			return sendJson(res, 200, readSettings());
		} catch (err) {
			return sendJson(res, err.status || 500, { error: err.message });
		}
	}
	if (p === "/api/settings" && req.method === "POST") {
		const body = await readJson(req);
		try {
			return sendJson(res, 200, writeSettings(body.changes));
		} catch (err) {
			return sendJson(res, err.status || 500, { error: err.message });
		}
	}
	if (req.method === "POST" && p === "/api/pick-folder") {
		// The dialog opens on the gateway machine, so only offer it when the gateway is bound to loopback.
		if (!LOCAL_ONLY) return sendJson(res, 403, { error: "원격 접속 중에는 폴더 선택 창을 쓸 수 없습니다" });
		const body = await readJson(req);
		const ac = new AbortController();
		res.on("close", () => !res.writableEnded && ac.abort());
		try {
			const start = body.start && existsSync(String(body.start)) ? path.resolve(String(body.start)) : "";
			return sendJson(res, 200, await pickFolderNative({ start, title: String(body.title || "프로젝트 폴더 선택").slice(0, 120), signal: ac.signal }));
		} catch (err) {
			return sendJson(res, err.code === "UNSUPPORTED" ? 501 : err.code === "BUSY" ? 409 : 500, { error: err.message, unsupported: err.code === "UNSUPPORTED" });
		}
	}
	if (req.method === "POST" && p === "/api/upload") {
		let name = "";
		try {
			name = decodeURIComponent(String(req.headers["x-file-name"] || ""));
		} catch {}
		try {
			return sendJson(res, 200, await saveUpload(req, name));
		} catch (err) {
			if (!res.headersSent) res.setHeader("Connection", "close");
			return sendJson(res, err.status || 500, { error: err.message });
		}
	}
	if (req.method === "POST" && p === "/api/mkdir") {
		const body = await readJson(req);
		try {
			return sendJson(res, 200, { path: await createDir(body.parent, body.name) });
		} catch (err) {
			return sendJson(res, 400, { error: err.message });
		}
	}
	if (req.method === "GET" && p === "/api/download") {
		const file = path.resolve(url.searchParams.get("path") || "");
		if (!manager.exports.has(file) || !existsSync(file)) return sendJson(res, 404, { error: "not found" });
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Disposition": contentDisposition(path.basename(file)),
		});
		return createReadStream(file).pipe(res);
	}
	if (req.method === "GET" && p === "/api/stream") {
		openSse(req, res);
		res.write(`event: live\ndata: ${JSON.stringify(manager.list())}\n\n`);
		globalClients.add(res);
		res.on("close", () => globalClients.delete(res));
		return;
	}
	if (req.method === "GET" && p === "/api/live") return sendJson(res, 200, { live: manager.list() });
	if (req.method === "POST" && p === "/api/live") {
		const body = await readJson(req);
		const live = await manager.open({ cwd: body.cwd, sessionFile: body.sessionFile || null });
		return sendJson(res, 200, { live: live.summary() });
	}
	if (m) {
		const live = manager.get(m[1]);
		if (!live) return sendJson(res, 404, { error: "세션이 없습니다 (서버가 재시작되었을 수 있습니다)" });
		const action = m[2];
		if (req.method === "GET" && action === "stream") {
			openSse(req, res);
			live.addClient(res, req.headers["last-event-id"] ?? url.searchParams.get("last"));
			return;
		}
		if (req.method === "POST" && action === "command") {
			const body = await readJson(req);
			const result = await live.command(body);
			return sendJson(res, 200, result);
		}
		if (req.method === "POST" && action === "ui") {
			const body = await readJson(req);
			return sendJson(res, 200, { ok: live.uiResponse(body) });
		}
		if (req.method === "POST" && action === "restart") {
			await live.restart();
			return sendJson(res, 200, { live: live.summary() });
		}
		if (req.method === "DELETE" && !action) {
			await manager.close(live.id);
			return sendJson(res, 200, { ok: true });
		}
	}
	return sendJson(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
	try {
		if (!hostAllowed(req)) return sendJson(res, 403, { error: "허용되지 않은 Host 헤더입니다" });
		const url = new URL(req.url, "http://localhost");
		const isApi = url.pathname.startsWith("/api/");
		if (isApi && req.method !== "GET" && !originAllowed(req)) return sendJson(res, 403, { error: "허용되지 않은 Origin입니다" });
		if (isApi) return await handleApi(req, res, url);
		if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
		return serveStatic(req, res, url.pathname);
	} catch (err) {
		if (!res.headersSent) sendError(res, err);
		else res.end();
	}
});

server.on("error", (err) => {
	if (err.code === "EADDRINUSE") console.error(`포트 ${opts.port}이(가) 이미 사용 중입니다. --port 로 다른 포트를 지정하세요.`);
	else console.error(err);
	process.exit(1);
});

server.listen(opts.port, opts.host, () => {
	const url = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`;
	console.log(`pi-web ${VERSION} 실행 중: ${url}`);
	if (launcher.error) console.warn(`경고: ${launcher.error}`);
	else console.log(`pi: ${launcher.entry} (${launcher.kind})`);
	console.log(`세션 폴더: ${getSessionsDir()}`);
	if (REMOTE) printRemoteInfo();
	if (opts.open) openBrowser(url);
});

function printRemoteInfo() {
	console.log("\n원격 접속 모드: 로그인이 없으므로 Tailscale 같은 비공개 네트워크 안에서만 쓰세요.");
	const urls = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const n of list || []) {
			if (n.family !== "IPv4" || n.internal) continue;
			// 100.64.0.0/10 is the range Tailscale hands out
			const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(n.address);
			urls.push(`  ${tailscale ? "Tailscale" : "같은 와이파이"}: http://${n.address}:${opts.port}`);
		}
	}
	if (opts.host === "0.0.0.0" && urls.length) console.log(urls.join("\n"));
	console.log("  집 밖에서 쓰려면 README의 '원격 접속' 항목(Tailscale)을 따라 하세요. 포트를 공유기에서 직접 여는 방식은 권하지 않습니다.");
}

function openBrowser(url) {
	const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
	} catch {}
}

let shuttingDown = false;
async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("\n종료 중… (실행 중인 pi 세션을 닫습니다)");
	for (const res of globalClients) res.end();
	await manager.stopAll();
	server.close();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
