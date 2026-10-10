// Live sessions: one pi RPC process each, with a server-side view model, an event ring buffer and SSE fan-out.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { applyEvent, createView } from "../public/js/reducer.js";
import { PiProcess } from "./pi-process.mjs";
import { normalizeCwd, stripAttachmentNote } from "./session-store.mjs";

const BUFFER_LIMIT = 3000;
const IDLE_REAP_MS = Number(process.env.PI_WEB_IDLE_MINUTES || 30) * 60_000;

/** Commands the browser may send, with their response timeouts (0 = none). */
const ALLOWED = {
	prompt: 0,
	steer: 30_000,
	follow_up: 30_000,
	abort: 120_000,
	clear_queue: 30_000,
	new_session: 0,
	get_state: 30_000,
	get_messages: 60_000,
	set_model: 60_000,
	cycle_model: 60_000,
	get_available_models: 60_000,
	set_thinking_level: 30_000,
	cycle_thinking_level: 30_000,
	get_available_thinking_levels: 30_000,
	set_steering_mode: 30_000,
	set_follow_up_mode: 30_000,
	compact: 0,
	set_auto_compaction: 30_000,
	set_auto_retry: 30_000,
	abort_retry: 30_000,
	bash: 0,
	abort_bash: 30_000,
	get_session_stats: 30_000,
	export_html: 120_000,
	switch_session: 0,
	fork: 0,
	clone: 0,
	get_fork_messages: 30_000,
	get_entries: 60_000,
	get_tree: 60_000,
	get_last_assistant_text: 30_000,
	set_session_name: 30_000,
	get_commands: 30_000,
};

function sseWrite(res, { id, event, data }) {
	let out = "";
	if (id !== undefined) out += `id: ${id}\n`;
	if (event) out += `event: ${event}\n`;
	out += `data: ${JSON.stringify(data)}\n\n`;
	res.write(out);
}

export class LiveSession extends EventEmitter {
	constructor({ manager, cwd, sessionFile }) {
		super();
		this.id = randomUUID().slice(0, 8);
		this.manager = manager;
		this.cwd = cwd;
		this.initialSessionFile = sessionFile || null;
		this.view = createView();
		this.seq = 0;
		this.buffer = [];
		this.clients = new Set();
		this.proc = null;
		this.lastActivity = Date.now();
		this.uiTimers = new Map();
		this.createdAt = Date.now();
	}

	get sessionFile() {
		return this.view.state?.sessionFile || this.initialSessionFile;
	}

	summary() {
		const s = this.view.state || {};
		const firstUser = this.view.messages.find((m) => m.role === "user");
		let preview = null;
		if (firstUser) {
			const c = firstUser.content;
			preview = stripAttachmentNote(typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 120);
		}
		return {
			id: this.id,
			cwd: this.cwd,
			sessionFile: this.sessionFile,
			sessionId: s.sessionId || null,
			name: s.sessionName || null,
			preview,
			status: this.view.status,
			clients: this.clients.size,
			createdAt: this.createdAt,
			lastActivity: this.lastActivity,
		};
	}

	async start() {
		const launcher = this.manager.launcher;
		if (!launcher || launcher.error) throw new Error(launcher?.error || "pi를 찾지 못했습니다");
		const args = [...this.manager.extraArgs];
		const file = this.sessionFile;
		if (file && existsSync(file)) args.push("--session", file);
		this.view.exited = null;
		this.proc = new PiProcess({ launcher, cwd: this.cwd, args });
		this.proc.on("record", (r) => this.#onRecord(r));
		this.proc.on("exit", (info) => {
			for (const t of this.uiTimers.values()) clearTimeout(t);
			this.uiTimers.clear();
			this.emitEvent({ type: "gw_exit", ...info, stderr: (info.stderr || "").slice(-4000) });
		});
		this.proc.start();
		this.emitEvent({ type: "gw_started" });
		await this.refreshAll();
	}

	async restart() {
		if (this.proc && !this.proc.exited) {
			this.proc.removeAllListeners("exit");
			await this.proc.stop();
		}
		this.view = createView();
		this.buffer = [];
		this.#broadcastSnapshot();
		this.start().catch((err) => {
			if (!this.view.exited) this.emitEvent({ type: "gw_notice", kind: "error", text: `pi 초기화 실패: ${err.message}` });
		});
	}

	emitEvent(ev) {
		const before = this.view.status;
		const beforeName = this.view.state?.sessionName;
		applyEvent(this.view, ev);
		this.seq += 1;
		this.buffer.push({ seq: this.seq, ev });
		if (this.buffer.length > BUFFER_LIMIT) this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT);
		for (const res of this.clients) sseWrite(res, { id: this.seq, event: "ev", data: ev });
		if (before !== this.view.status || beforeName !== this.view.state?.sessionName) this.manager.changed();
		if (this.view.status === "running" || this.view.status === "waiting") this.lastActivity = Date.now();
	}

	#broadcastSnapshot() {
		for (const res of this.clients) sseWrite(res, { id: this.seq, event: "snapshot", data: this.view });
		this.manager.changed();
	}

	#onRecord(r) {
		if (r.type === "response") return; // uncorrelated responses (e.g. parse errors)
		if (r.type === "extension_ui_request" && typeof r.timeout === "number" && r.timeout > 0) {
			const t = setTimeout(() => {
				this.uiTimers.delete(r.id);
				if (this.view.pendingUi.some((p) => p.id === r.id)) this.emitEvent({ type: "gw_ui_resolved", id: r.id, reason: "timeout" });
			}, r.timeout + 250);
			this.uiTimers.set(r.id, t);
		}
		this.emitEvent(r);
		if (r.type === "agent_settled") {
			this.refreshStats();
			this.refreshState();
			this.manager.sessionsChanged();
		} else if (r.type === "compaction_end") {
			this.refreshMessages();
			this.refreshStats();
		} else if (r.type === "message_end" && r.message?.role === "assistant") {
			this.refreshStats();
		}
	}

	async #get(type, extra = {}) {
		const res = await this.proc.request({ type, ...extra }, { timeoutMs: 60_000 });
		if (!res.success) throw new Error(res.error || `${type} 실패`);
		return res.data;
	}

	async refreshState() {
		try {
			this.emitEvent({ type: "gw_state", state: await this.#get("get_state") });
		} catch {}
	}

	async refreshMessages() {
		try {
			const data = await this.#get("get_messages");
			this.emitEvent({ type: "gw_messages", messages: data.messages || [] });
		} catch {}
	}

	async refreshStats() {
		try {
			this.emitEvent({ type: "gw_stats", stats: await this.#get("get_session_stats") });
		} catch {}
	}

	async refreshCommands() {
		try {
			const data = await this.#get("get_commands");
			this.emitEvent({ type: "gw_commands", commands: data.commands || [] });
		} catch {}
	}

	async refreshThinkingLevels() {
		try {
			const data = await this.#get("get_available_thinking_levels");
			this.emitEvent({ type: "gw_thinking_levels", levels: data.levels || [] });
		} catch {}
	}

	async refreshAll() {
		const state = await this.#get("get_state");
		this.emitEvent({ type: "gw_state", state });
		await Promise.all([this.refreshMessages(), this.refreshStats(), this.refreshCommands(), this.refreshThinkingLevels()]);
		this.manager.changed();
	}

	async command(cmd) {
		if (!cmd || typeof cmd.type !== "string" || !(cmd.type in ALLOWED)) {
			throw Object.assign(new Error(`허용되지 않은 명령: ${cmd?.type}`), { status: 400 });
		}
		if (!this.proc || this.proc.exited) throw Object.assign(new Error("pi 프로세스가 종료되었습니다"), { status: 409 });
		this.lastActivity = Date.now();
		const { id: _ignored, ...body } = cmd;
		const id = this.proc.nextId();
		if (body.type === "bash" && this.view.bash) throw Object.assign(new Error("이미 실행 중인 ! 명령이 있습니다. 끝난 뒤 다시 시도하세요"), { status: 409 });
		if (body.type === "bash") {
			this.emitEvent({ type: "gw_bash_start", id, command: body.command, excludeFromContext: !!body.excludeFromContext });
		}
		let res;
		try {
			res = await this.proc.request(body, { id, timeoutMs: ALLOWED[body.type] });
		} finally {
			if (body.type === "bash") this.emitEvent({ type: "gw_bash_end", id });
		}
		if (res.success) await this.#afterCommand(body, res);
		return res;
	}

	async #afterCommand(cmd, res) {
		switch (cmd.type) {
			case "set_model":
			case "cycle_model":
				await Promise.all([this.refreshState(), this.refreshThinkingLevels(), this.refreshStats()]);
				break;
			case "set_thinking_level":
			case "cycle_thinking_level":
			case "set_auto_compaction":
			case "set_steering_mode":
			case "set_follow_up_mode":
				await this.refreshState();
				break;
			case "new_session":
			case "switch_session":
			case "fork":
			case "clone":
				if (!res.data?.cancelled) {
					await this.refreshAll();
					this.manager.sessionsChanged();
				}
				break;
			case "compact":
			case "bash":
				await Promise.all([this.refreshMessages(), this.refreshStats()]);
				break;
			case "set_session_name":
				await this.refreshState();
				this.manager.sessionsChanged();
				break;
			case "export_html":
				if (res.data?.path) this.manager.addExport(path.resolve(this.cwd, res.data.path));
				break;
		}
	}

	uiResponse(payload) {
		const id = payload?.id;
		if (!id || !this.view.pendingUi.some((r) => r.id === id)) return false;
		const msg = { type: "extension_ui_response", id };
		if (payload.cancelled) msg.cancelled = true;
		else if (typeof payload.confirmed === "boolean") msg.confirmed = payload.confirmed;
		else msg.value = String(payload.value ?? "");
		this.proc?.write(msg);
		const t = this.uiTimers.get(id);
		if (t) clearTimeout(t);
		this.uiTimers.delete(id);
		this.emitEvent({ type: "gw_ui_resolved", id });
		return true;
	}

	addClient(res, lastEventId) {
		this.clients.add(res);
		this.lastActivity = Date.now();
		const last = Number.parseInt(lastEventId, 10);
		const first = this.buffer[0]?.seq ?? this.seq + 1;
		if (Number.isFinite(last) && last <= this.seq && last >= first - 1) {
			for (const { seq, ev } of this.buffer) if (seq > last) sseWrite(res, { id: seq, event: "ev", data: ev });
		} else {
			sseWrite(res, { id: this.seq, event: "snapshot", data: this.view });
		}
		this.manager.changed();
		res.on("close", () => {
			this.clients.delete(res);
			this.lastActivity = Date.now();
			this.manager.changed();
		});
	}

	async stop() {
		for (const res of this.clients) {
			try {
				res.end();
			} catch {}
		}
		this.clients.clear();
		if (this.proc) await this.proc.stop();
	}
}

export class LiveManager extends EventEmitter {
	constructor({ launcher }) {
		super();
		this.launcher = launcher;
		this.extraArgs = (process.env.PI_WEB_PI_ARGS || "").split(/\s+/).filter(Boolean);
		this.sessions = new Map();
		this.exports = new Set();
		this.changeTimer = null;
		this.reaper = setInterval(() => this.#reap(), 60_000);
		this.reaper.unref();
	}

	addExport(file) {
		this.exports.delete(file);
		this.exports.add(file);
		if (this.exports.size > 50) this.exports.delete(this.exports.values().next().value);
	}

	changed() {
		if (this.changeTimer) return;
		this.changeTimer = setTimeout(() => {
			this.changeTimer = null;
			this.emit("change", this.list());
		}, 50);
	}

	sessionsChanged() {
		this.emit("sessions");
	}

	list() {
		return [...this.sessions.values()].map((s) => s.summary());
	}

	get(id) {
		return this.sessions.get(id) || null;
	}

	findByFile(file) {
		const want = normalizeCwd(file);
		for (const s of this.sessions.values()) if (s.sessionFile && normalizeCwd(s.sessionFile) === want) return s;
		return null;
	}

	async open({ cwd, sessionFile }) {
		if (!this.launcher || this.launcher.error) throw Object.assign(new Error(this.launcher?.error || "pi를 찾지 못했습니다"), { status: 500 });
		if (sessionFile) {
			const existing = this.findByFile(sessionFile);
			if (existing) {
				if (existing.view.exited) existing.restart().catch(() => {});
				return existing;
			}
			if (!existsSync(sessionFile)) throw Object.assign(new Error("세션 파일이 없습니다"), { status: 404 });
		}
		if (!cwd) throw Object.assign(new Error("작업 폴더(cwd)가 필요합니다"), { status: 400 });
		const resolved = path.resolve(cwd);
		let st;
		try {
			st = statSync(resolved);
		} catch {
			throw Object.assign(new Error(`폴더가 없습니다: ${resolved}`), { status: 404 });
		}
		if (!st.isDirectory()) throw Object.assign(new Error(`폴더가 아닙니다: ${resolved}`), { status: 400 });
		const live = new LiveSession({ manager: this, cwd: resolved, sessionFile });
		this.sessions.set(live.id, live);
		// Start in the background: pi may take a moment (or wait on an extension dialog) before answering,
		// and the browser should already be attached to see that.
		live.start().catch((err) => {
			if (!live.view.exited) live.emitEvent({ type: "gw_notice", kind: "error", text: `pi 초기화 실패: ${err.message}` });
		});
		this.changed();
		return live;
	}

	async close(id) {
		const s = this.sessions.get(id);
		if (!s) return false;
		this.sessions.delete(id);
		await s.stop();
		this.changed();
		this.sessionsChanged();
		return true;
	}

	/** After credentials changed: restart idle sessions so their pi process picks the new login up. */
	async restartIdle() {
		let restarted = 0;
		let skipped = 0;
		for (const s of this.sessions.values()) {
			if (s.view.status === "idle" || s.view.status === "exited") {
				await s.restart().catch(() => {});
				restarted++;
			} else skipped++;
		}
		return { restarted, skipped };
	}

	async #reap() {
		const now = Date.now();
		for (const s of this.sessions.values()) {
			const idle = s.view.status === "idle" || s.view.status === "exited";
			if (idle && s.clients.size === 0 && now - s.lastActivity > IDLE_REAP_MS) await this.close(s.id);
		}
	}

	async stopAll() {
		await Promise.all([...this.sessions.values()].map((s) => s.stop()));
		this.sessions.clear();
	}
}
