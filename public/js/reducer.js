// Shared (server + browser) reducer that turns pi RPC events and gateway events into a view model.
// The server keeps one view per live session for snapshots; the browser applies the same events.

export function createView() {
	return {
		rev: 0,
		status: "starting",
		running: false,
		compacting: false,
		exited: null,
		messages: [],
		tools: {},
		state: null,
		stats: null,
		commands: [],
		thinkingLevels: [],
		queue: { steering: [], followUp: [] },
		pendingUi: [],
		statuses: {},
		widgets: {},
		title: null,
		bash: null,
		retry: null,
		editorText: null,
		noticeSeq: 0,
	};
}

export function deriveStatus(view) {
	if (view.exited) return "exited";
	if (view.state === null) return "starting";
	if (view.pendingUi.length > 0) return "waiting";
	if (view.compacting) return "compacting";
	if (view.running || view.bash) return "running";
	return "idle";
}

const bump = (m) => {
	m._v = (m._v || 0) + 1;
};

function findOwner(view, toolCallId) {
	for (let i = view.messages.length - 1; i >= 0; i--) {
		const m = view.messages[i];
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		if (m.content.some((b) => b && b.type === "toolCall" && b.id === toolCallId)) return m;
	}
	return null;
}

function lastLive(view, role) {
	for (let i = view.messages.length - 1; i >= 0; i--) {
		const m = view.messages[i];
		if (m._live && m.role === role) return i;
		if (!m._live && m.role !== "_notice") break;
	}
	return -1;
}

function pushNotice(view, kind, text) {
	view.noticeSeq += 1;
	view.messages.push({ role: "_notice", kind, text, timestamp: Date.now(), _v: 1, _nid: view.noticeSeq });
}

/** Best-effort parse of a partially streamed JSON object (tool-call arguments). */
export function parsePartialJson(text) {
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {}
	const stack = [];
	let inString = false;
	let escaped = false;
	for (const ch of text) {
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") stack.push(ch);
		else if (ch === "}" || ch === "]") stack.pop();
	}
	let s = text;
	if (inString) s += escaped ? '\\"' : '"';
	s = s.replace(/[,:]\s*$/, "");
	const close = stack
		.reverse()
		.map((c) => (c === "{" ? "}" : "]"))
		.join("");
	for (const candidate of [s + close, `${s}null${close}`]) {
		try {
			return JSON.parse(candidate);
		} catch {}
	}
	return null;
}

function applyAssistantEvent(m, e) {
	if (!Array.isArray(m.content)) m.content = [];
	const c = m.content;
	const i = e.contentIndex;
	switch (e.type) {
		case "text_start":
			c[i] = { type: "text", text: "" };
			break;
		case "text_delta":
			if (!c[i] || c[i].type !== "text") c[i] = { type: "text", text: "" };
			c[i].text += e.delta ?? "";
			break;
		case "text_end":
			if (!c[i] || c[i].type !== "text") c[i] = { type: "text", text: "" };
			if (typeof e.content === "string") c[i].text = e.content;
			break;
		case "thinking_start":
			c[i] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta":
			if (!c[i] || c[i].type !== "thinking") c[i] = { type: "thinking", thinking: "" };
			c[i].thinking += e.delta ?? "";
			break;
		case "thinking_end":
			if (!c[i] || c[i].type !== "thinking") c[i] = { type: "thinking", thinking: "" };
			if (typeof e.content === "string") c[i].thinking = e.content;
			break;
		case "toolcall_start":
			c[i] = { type: "toolCall", id: e.id, name: e.toolName, arguments: {}, _argsText: "" };
			break;
		case "toolcall_delta": {
			if (!c[i] || c[i].type !== "toolCall") c[i] = { type: "toolCall", id: "", name: "", arguments: {}, _argsText: "" };
			c[i]._argsText = (c[i]._argsText || "") + (e.delta ?? "");
			const parsed = parsePartialJson(c[i]._argsText);
			if (parsed && typeof parsed === "object") c[i].arguments = parsed;
			break;
		}
		case "toolcall_end":
			if (e.toolCall) c[i] = e.toolCall;
			break;
		case "done":
			if (e.message) Object.assign(m, e.message);
			break;
		case "error":
			if (e.error && typeof e.error === "object") Object.assign(m, e.error);
			m.stopReason = e.reason || "error";
			break;
	}
}

function fmtTokens(n) {
	if (typeof n !== "number") return "?";
	return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Apply one event (pi record or gateway `gw_*` event) to the view. Mutates and returns the view. */
export function applyEvent(view, ev) {
	if (!ev || typeof ev !== "object") return view;
	switch (ev.type) {
		case "agent_start":
			view.running = true;
			break;
		case "agent_settled":
			view.running = false;
			view.retry = null;
			for (const m of view.messages) {
				if (m._live) {
					m._live = false;
					if (m.stopReason === "pending") m.stopReason = ev.aborted ? "aborted" : "stop";
					bump(m);
				}
			}
			for (const t of Object.values(view.tools)) if (t.status === "running") t.status = "aborted";
			break;
		case "message_start": {
			if (!ev.message) break;
			const m = { ...ev.message, _live: true, _v: 1 };
			if (m.role === "assistant" && !Array.isArray(m.content)) m.content = [];
			if (m.role === "assistant") m.content = m.content.map((b) => ({ ...b }));
			view.messages.push(m);
			break;
		}
		case "message_update": {
			let idx = lastLive(view, "assistant");
			if (idx === -1) {
				view.messages.push({ role: "assistant", content: [], stopReason: "pending", _live: true, _v: 1 });
				idx = view.messages.length - 1;
			}
			const m = view.messages[idx];
			if (ev.assistantMessageEvent) applyAssistantEvent(m, ev.assistantMessageEvent);
			if (ev.usage) m.usage = ev.usage;
			bump(m);
			break;
		}
		case "message_end": {
			if (!ev.message) break;
			const idx = lastLive(view, ev.message.role);
			const prevV = idx >= 0 ? view.messages[idx]._v || 1 : 0;
			const m = { ...ev.message, _v: prevV + 1 };
			if (idx >= 0) view.messages[idx] = m;
			else view.messages.push(m);
			if (m.role === "toolResult") {
				const owner = findOwner(view, m.toolCallId);
				if (owner) bump(owner);
			}
			break;
		}
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end": {
			const id = ev.toolCallId;
			const prev = view.tools[id] || { startedAt: Date.now() };
			if (ev.type === "tool_execution_start") view.tools[id] = { ...prev, status: "running", args: ev.args, name: ev.toolName };
			else if (ev.type === "tool_execution_update") view.tools[id] = { ...prev, status: "running", partial: ev.partialResult };
			else
				view.tools[id] = {
					...prev,
					status: ev.isError ? "error" : "done",
					result: ev.result,
					isError: !!ev.isError,
					durationMs: ev.durationMs,
					partial: undefined,
				};
			const owner = findOwner(view, id);
			if (owner) bump(owner);
			break;
		}
		case "queue_update":
			view.queue = { steering: ev.steering || [], followUp: ev.followUp || [] };
			break;
		case "session_info_changed":
			view.state = { ...(view.state || {}), sessionName: ev.name };
			break;
		case "thinking_level_changed":
			view.state = { ...(view.state || {}), thinkingLevel: ev.level };
			break;
		case "compaction_start":
			view.compacting = true;
			pushNotice(view, "info", ev.reason === "manual" ? "컨텍스트 압축 중…" : "컨텍스트가 가득 차서 자동 압축 중…");
			break;
		case "compaction_end":
			view.compacting = false;
			if (ev.result)
				pushNotice(
					view,
					"info",
					`컨텍스트 압축 완료: ${fmtTokens(ev.result.tokensBefore)} → 약 ${fmtTokens(ev.result.estimatedTokensAfter)} 토큰`,
				);
			else if (ev.aborted) pushNotice(view, "warn", "컨텍스트 압축이 취소되었습니다");
			else pushNotice(view, "error", `컨텍스트 압축 실패: ${ev.errorMessage ?? "알 수 없는 오류"}`);
			break;
		case "auto_retry_start":
			view.retry = { attempt: ev.attempt, maxAttempts: ev.maxAttempts, delayMs: ev.delayMs, errorMessage: ev.errorMessage };
			pushNotice(view, "warn", `오류로 재시도 ${ev.attempt}/${ev.maxAttempts} (${Math.round((ev.delayMs || 0) / 1000)}초 후): ${ev.errorMessage ?? ""}`);
			break;
		case "auto_retry_end":
			view.retry = null;
			if (!ev.success) pushNotice(view, "error", `재시도 실패: ${ev.finalError ?? ""}`);
			break;
		case "extension_error":
			pushNotice(view, "error", `확장 오류 (${ev.event ?? "?"}): ${ev.error ?? ""}`);
			break;
		case "extension_ui_request": {
			const method = ev.method;
			if (DIALOG_METHODS.has(method)) {
				if (!view.pendingUi.some((r) => r.id === ev.id)) view.pendingUi.push({ ...ev, receivedAt: Date.now() });
			} else if (method === "notify") {
				pushNotice(view, ev.notifyType === "error" ? "error" : ev.notifyType === "warning" ? "warn" : "info", ev.message ?? "");
			} else if (method === "setStatus") {
				if (ev.statusText === undefined || ev.statusText === null || ev.statusText === "") delete view.statuses[ev.statusKey];
				else view.statuses[ev.statusKey] = ev.statusText;
			} else if (method === "setWidget") {
				if (!ev.widgetLines) delete view.widgets[ev.widgetKey];
				else view.widgets[ev.widgetKey] = { lines: ev.widgetLines, placement: ev.widgetPlacement || "aboveEditor" };
			} else if (method === "setTitle") {
				view.title = ev.title || null;
			} else if (method === "set_editor_text") {
				view.editorText = { text: ev.text ?? "", n: (view.editorText?.n || 0) + 1 };
			}
			break;
		}
		case "bash_execution_update":
			if (view.bash && view.bash.id === ev.id) {
				view.bash.output = (view.bash.output + (ev.delta ?? "")).slice(-200_000);
				view.bash._v = (view.bash._v || 0) + 1;
			}
			break;

		// ---- gateway events ----
		case "gw_state":
			view.state = ev.state || {};
			break;
		case "gw_messages": {
			const keepTools = {};
			for (const [id, t] of Object.entries(view.tools)) if (t.status === "running") keepTools[id] = t;
			view.tools = keepTools;
			const next = (ev.messages || []).map((m) => ({ ...m, _v: 1 }));
			// keep recent gateway notices (e.g. "compaction finished") that are newer than every pi message
			const newest = next.reduce((t, m) => Math.max(t, typeof m.timestamp === "number" ? m.timestamp : 0), 0);
			for (const n of view.messages) if (n.role === "_notice" && n.timestamp >= newest) next.push({ ...n, _v: 1 });
			view.messages = next;
			break;
		}
		case "gw_stats":
			view.stats = ev.stats || null;
			break;
		case "gw_commands":
			view.commands = ev.commands || [];
			break;
		case "gw_thinking_levels":
			view.thinkingLevels = ev.levels || [];
			break;
		case "gw_ui_resolved":
			view.pendingUi = view.pendingUi.filter((r) => r.id !== ev.id);
			break;
		case "gw_bash_start":
			view.bash = { id: ev.id, command: ev.command, output: "", excludeFromContext: !!ev.excludeFromContext, _v: 1 };
			break;
		case "gw_bash_end":
			view.bash = null;
			break;
		case "gw_notice":
			pushNotice(view, ev.kind || "info", ev.text || "");
			break;
		case "gw_exit":
			view.exited = { code: ev.code, signal: ev.signal, stderr: ev.stderr, error: ev.error };
			view.running = false;
			view.compacting = false;
			view.pendingUi = [];
			view.bash = null;
			break;
		case "gw_started":
			view.exited = null;
			break;
	}
	view.status = deriveStatus(view);
	view.rev += 1;
	return view;
}
