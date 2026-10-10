// Reads pi session files (~/.pi/agent/sessions/**.jsonl) to list projects and sessions.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const FULL_READ_LIMIT = 8 * 1024 * 1024;
const HEAD_BYTES = 512 * 1024;

function expandHome(p) {
	if (!p) return p;
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2));
	return p;
}

export function getAgentDir() {
	const env = process.env.PI_CODING_AGENT_DIR;
	return env ? path.resolve(expandHome(env)) : path.join(homedir(), ".pi", "agent");
}

export function getSessionsDir() {
	const env = process.env.PI_CODING_AGENT_SESSION_DIR;
	if (env) return path.resolve(expandHome(env));
	try {
		const settings = JSON.parse(readFileSync(path.join(getAgentDir(), "settings.json"), "utf8"));
		if (typeof settings.sessionDir === "string" && settings.sessionDir.trim()) {
			return path.resolve(expandHome(settings.sessionDir.trim()));
		}
	} catch {}
	return path.join(getAgentDir(), "sessions");
}

export function normalizeCwd(p) {
	if (!p) return "";
	let r = path.resolve(p);
	if (r.length > 1 && (r.endsWith("/") || r.endsWith("\\"))) r = r.slice(0, -1);
	return IS_WIN ? r.toLowerCase() : r;
}

/** Prompts with attached files end in a "[첨부 파일]" block (see public/js/util.js); titles should not show it. */
export function stripAttachmentNote(text) {
	return String(text ?? "").split("\n\n[첨부 파일]\n")[0];
}

const cache = new Map();

function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((b) => b && b.type === "text")
			.map((b) => b.text)
			.join(" ");
	return "";
}

function parseSessionText(text, truncated) {
	const info = {
		id: null,
		cwd: null,
		created: null,
		name: null,
		firstMessage: null,
		messageCount: 0,
		parentSession: null,
		truncated,
	};
	let start = 0;
	while (start < text.length) {
		let end = text.indexOf("\n", start);
		if (end === -1) end = text.length;
		const line = text.slice(start, end);
		start = end + 1;
		if (!line.trim()) continue;
		const head = line.slice(0, 400);
		const needParse = info.id === null || head.includes('"type":"session_info"');
		const roleMatch = /"message":\{"role":"(\w+)"/.exec(head);
		const role = roleMatch ? roleMatch[1] : null;
		if (role === "user" || role === "assistant") info.messageCount += 1;
		if (!needParse && !(role === "user" && info.firstMessage === null)) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "session") {
			info.id = entry.id ?? null;
			info.cwd = entry.cwd ?? null;
			info.created = entry.timestamp ?? null;
			info.parentSession = entry.parentSession ?? null;
		} else if (entry.type === "session_info") {
			info.name = entry.name || null;
		} else if (entry.type === "message" && entry.message?.role === "user" && info.firstMessage === null) {
			const t = stripAttachmentNote(textOf(entry.message.content)).replace(/\s+/g, " ").trim();
			if (t) info.firstMessage = t.slice(0, 200);
		}
	}
	return info;
}

async function readSessionInfo(file, st) {
	const cached = cache.get(file);
	if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.info;
	let text;
	let truncated = false;
	if (st.size <= FULL_READ_LIMIT) {
		text = await readFile(file, "utf8");
	} else {
		const fh = await open(file, "r");
		try {
			const buf = Buffer.alloc(HEAD_BYTES);
			const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
			text = buf.subarray(0, bytesRead).toString("utf8");
			truncated = true;
		} finally {
			await fh.close();
		}
	}
	const info = parseSessionText(text, truncated);
	cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
	return info;
}

async function collectJsonl(dir, depth, out) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (depth > 0) await collectJsonl(p, depth - 1, out);
		} else if (e.isFile() && e.name.endsWith(".jsonl")) {
			out.push(p);
		}
	}
}

/** All sessions (optionally only those whose cwd matches), newest first. */
export async function listSessions({ cwd } = {}) {
	const dir = getSessionsDir();
	const files = [];
	await collectJsonl(dir, 2, files);
	const want = cwd ? normalizeCwd(cwd) : null;
	const result = [];
	await Promise.all(
		files.map(async (file) => {
			try {
				const st = await stat(file);
				const info = await readSessionInfo(file, st);
				if (!info.id) return;
				if (want && normalizeCwd(info.cwd) !== want) return;
				result.push({ path: file, modified: st.mtimeMs, size: st.size, ...info });
			} catch {}
		}),
	);
	result.sort((a, b) => b.modified - a.modified);
	return result;
}

export async function listProjects() {
	const sessions = await listSessions();
	const byCwd = new Map();
	for (const s of sessions) {
		if (!s.cwd) continue;
		const key = normalizeCwd(s.cwd);
		const p = byCwd.get(key);
		if (p) {
			p.count += 1;
			if (s.modified > p.lastModified) p.lastModified = s.modified;
		} else byCwd.set(key, { cwd: s.cwd, count: 1, lastModified: s.modified });
	}
	return [...byCwd.values()].sort((a, b) => b.lastModified - a.lastModified);
}
