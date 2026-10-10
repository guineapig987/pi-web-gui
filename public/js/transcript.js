// Turn-based transcript (opencode style): a user message followed by everything the agent did for it.
// Exploration steps (thinking, read/grep/find/ls) collapse into one summary row; edits show inline diffs;
// each turn ends with the files it changed. Only turns whose messages changed are re-rendered.
import { h, icon } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { diffStats, EXPLORE, pathEl, renderToolCard, statEl, toolStatus } from "./tools.js";
import { basename, copyText, fmtCost, fmtDuration, fmtTokens, splitAttachments, stripAnsi, textOfContent, truncate } from "./util.js";

const mdCache = new Map();
function md(text) {
	let html = mdCache.get(text);
	if (html === undefined) {
		html = renderMarkdown(text);
		if (mdCache.size >= 400) mdCache.delete(mdCache.keys().next().value);
		mdCache.set(text, html);
	}
	return html;
}

const STARTS_TURN = new Set(["user", "bashExecution", "compactionSummary", "branchSummary"]);

/** Split messages into turns: [{start, end}] (end exclusive). */
export function splitTurns(msgs) {
	const turns = [];
	let start = 0;
	for (let i = 0; i < msgs.length; i++) {
		if (i > start && STARTS_TURN.has(msgs[i].role)) {
			turns.push({ start, end: i });
			start = i;
		}
	}
	if (msgs.length) turns.push({ start, end: msgs.length });
	return turns;
}

/** Files changed by edit/write calls in a range of messages: Map path → {add, del}. */
export function changedFiles(msgs, results) {
	const files = new Map();
	for (const m of msgs) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (b?.type !== "toolCall" || (b.name !== "edit" && b.name !== "write")) continue;
			const r = results.get(b.id);
			if (!r || r.isError) continue;
			const p = b.arguments?.path;
			if (!p) continue;
			const s = b.name === "edit" ? diffStats(r.details?.diff || "") : { add: String(b.arguments?.content ?? "").split("\n").length, del: 0 };
			const prev = files.get(p) || { add: 0, del: 0 };
			files.set(p, { add: prev.add + s.add, del: prev.del + s.del });
		}
	}
	return files;
}

function exploreSummary(items) {
	let reads = 0;
	let searches = 0;
	let lists = 0;
	let thoughts = 0;
	for (const it of items) {
		if (it.kind === "thinking") thoughts++;
		else if (it.block.name === "read") reads++;
		else if (it.block.name === "ls") lists++;
		else searches++;
	}
	const parts = [];
	if (reads) parts.push(`파일 ${reads}개 읽음`);
	if (searches) parts.push(`검색 ${searches}회`);
	if (lists) parts.push(`목록 ${lists}회`);
	if (thoughts) parts.push(thoughts > 1 ? `생각 ${thoughts}` : "생각");
	return parts.join(" · ");
}

export class Transcript {
	constructor(el, { onRequestRender, onToast, onOpenFile, onFork }) {
		this.el = el;
		this.list = h("div.turns");
		this.tail = h("div.tail");
		this.el.append(this.list, this.tail);
		this.nodes = [];
		this.messagesRef = null;
		this.expanded = new Map();
		this.onRequestRender = onRequestRender;
		this.onToast = onToast;
		this.onOpenFile = onOpenFile;
		this.onFork = onFork;
		this.dirty = new Set();
		this.el.addEventListener("click", (e) => {
			const btn = e.target.closest?.(".copy-code");
			if (btn) {
				const code = btn.closest(".code-block")?.querySelector("pre")?.innerText ?? "";
				copyText(code).then(() => {
					btn.textContent = "복사됨";
					setTimeout(() => (btn.textContent = "복사"), 1200);
				});
			}
		});
	}

	reset() {
		this.nodes = [];
		this.messagesRef = null;
		this.list.replaceChildren();
		this.tail.replaceChildren();
	}

	toggled(start) {
		if (start !== undefined) this.dirty.add(start);
		this.onRequestRender();
	}

	render(view, scroller) {
		const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
		const msgs = view.messages;
		if (msgs !== this.messagesRef) {
			this.nodes = [];
			this.list.replaceChildren();
			this.messagesRef = msgs;
		}
		const results = new Map();
		const callIds = new Set();
		for (const m of msgs) {
			if (m.role === "toolResult") results.set(m.toolCallId, m);
			else if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b?.type === "toolCall") callIds.add(b.id);
		}
		this.callIds = callIds;
		const turns = splitTurns(msgs);
		const dirty = this.dirty;
		this.dirty = new Set();
		turns.forEach((t, k) => {
			const sig = msgs
				.slice(t.start, t.end)
				.map((m) => m._v || 1)
				.join(",");
			const isLast = k === turns.length - 1;
			const prev = this.nodes[k];
			const live = isLast && (view.running || view.compacting);
			if (prev && prev.start === t.start && prev.end === t.end && prev.sig === sig && prev.live === live && !dirty.has(t.start) && prev.first === msgs[t.start]) return;
			const el = this.renderTurn(msgs, t, view, results, live);
			if (prev) prev.el.replaceWith(el);
			else this.list.append(el);
			this.nodes[k] = { start: t.start, end: t.end, sig, live, el, first: msgs[t.start] };
		});
		while (this.nodes.length > turns.length) this.nodes.pop().el.remove();
		this.renderTail(view, turns, results);
		if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
	}

	renderTurn(msgs, t, view, results, live) {
		const turn = h("div.turn", { dataset: { start: t.start } });
		const first = msgs[t.start];
		const body = h("div.turn-body");
		let i = t.start;
		if (first.role === "user") {
			turn.append(this.renderUser(first));
			i++;
		} else if (first.role === "bashExecution") {
			body.append(this.renderBash(first, `bash:${t.start}`, false, t.start));
			i++;
		} else if (first.role === "compactionSummary" || first.role === "branchSummary") {
			turn.append(...this.renderSummary(first, `sum:${t.start}`, t.start));
			i++;
		}
		// Flatten the rest of the turn into display items.
		const items = [];
		for (; i < t.end; i++) {
			const m = msgs[i];
			if (m.role === "assistant") {
				const blocks = Array.isArray(m.content) ? m.content : [];
				blocks.forEach((b, j) => {
					if (!b) return;
					const lastBlock = !!m._live && j === blocks.length - 1;
					if (b.type === "text") {
						if (b.text || m._live) items.push({ kind: "text", text: b.text, streaming: lastBlock });
					} else if (b.type === "thinking") {
						if (b.thinking || b.redacted || lastBlock) items.push({ kind: "thinking", block: b, key: `think:${i}:${j}`, streaming: lastBlock });
					} else if (b.type === "toolCall") {
						items.push({ kind: EXPLORE.has(b.name) ? "explore" : "tool", block: b, streaming: !!m._live });
					}
				});
				if (m.stopReason === "error") items.push({ kind: "error", text: m.errorMessage || "오류가 발생했습니다" });
				else if (m.stopReason === "aborted") items.push({ kind: "aborted", text: "중단됨" });
				else if (m.stopReason === "length") items.push({ kind: "aborted", text: "출력 길이 제한에 도달했습니다" });
			} else if (m.role === "toolResult") {
				if (!this.callIds?.has(m.toolCallId))
					items.push({ kind: "tool", block: { type: "toolCall", id: m.toolCallId, name: m.toolName, arguments: {} }, streaming: false });
			} else if (m.role === "_notice") {
				items.push({ kind: "notice", m });
			} else if (m.role === "custom") {
				if (m.display !== false) items.push({ kind: "custom", m });
			} else if (m.role !== "system") {
				items.push({ kind: "unknown", m });
			}
		}
		// Group consecutive exploration steps.
		const out = [];
		for (let k = 0; k < items.length; k++) {
			const it = items[k];
			if (it.kind === "explore" || it.kind === "thinking") {
				const run = [it];
				while (k + 1 < items.length && (items[k + 1].kind === "explore" || items[k + 1].kind === "thinking")) run.push(items[++k]);
				const isTail = k === items.length - 1;
				if (run.length === 1 && run[0].kind === "thinking") out.push(this.renderThinking(run[0], t.start));
				else if (run.length === 1) out.push(this.renderTool(run[0], view, results, t.start));
				else out.push(this.renderGroup(run, view, results, t.start, live && isTail));
			} else if (it.kind === "tool") out.push(this.renderTool(it, view, results, t.start));
			else if (it.kind === "text") out.push(h(`div.md${it.streaming ? ".streaming" : ""}`, { html: md(it.text) }));
			else if (it.kind === "error") out.push(h("div.msg-error", icon("alert"), h("span", it.text)));
			else if (it.kind === "aborted") out.push(h("div.msg-aborted", it.text));
			else if (it.kind === "notice")
				out.push(h(`div.notice.${it.m.kind || "info"}`, icon(it.m.kind === "error" || it.m.kind === "warn" ? "alert" : "check"), h("span", stripAnsi(it.m.text))));
			else if (it.kind === "custom") out.push(h("div.custom-msg", h("div.custom-label", it.m.customType || "custom"), h("div.md", { html: md(textOfContent(it.m.content)) })));
			else out.push(h("pre.tool-pre", truncate(JSON.stringify(it.m, null, 2), 3000)));
		}
		body.append(...out);
		if (body.childNodes.length) turn.append(body);

		const turnMsgs = msgs.slice(t.start, t.end);
		const files = changedFiles(turnMsgs, results);
		if (files.size && !live) {
			turn.append(
				h(
					"div.turn-changes",
					h("div.turn-changes-head", icon("edit"), `변경된 파일 ${files.size}개`),
					[...files].map(([p, s]) => h("button.change-row", { type: "button", onclick: () => this.onOpenFile?.(p) }, icon("file"), pathEl(p, "change-path"), statEl(s))),
				),
			);
		}
		if (!live) {
			const foot = this.renderFoot(turnMsgs);
			if (foot) turn.append(foot);
		}
		return turn;
	}

	renderFoot(turnMsgs) {
		const asst = turnMsgs.filter((m) => m.role === "assistant");
		if (!asst.length) return null;
		const last = asst[asst.length - 1];
		let out = 0;
		let cost = 0;
		for (const m of asst) {
			out += m.usage?.output || 0;
			cost += m.usage?.cost?.total || 0;
		}
		const user = turnMsgs[0]?.role === "user" ? turnMsgs[0] : null;
		const dur = user && typeof last.timestamp === "number" && typeof user.timestamp === "number" ? last.timestamp - user.timestamp : null;
		const text = asst
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((b) => b?.type === "text")
			.map((b) => b.text)
			.join("\n\n");
		const bits = [last.model, dur && dur > 0 ? fmtDuration(dur) : null, out ? `출력 ${fmtTokens(out)}` : null, cost ? fmtCost(cost) : null].filter(Boolean);
		return h(
			"div.turn-foot",
			text
				? h(
						"button.icon-btn.small",
						{ type: "button", title: "응답 복사 (마크다운)", onclick: () => copyText(text).then(() => this.onToast?.("응답을 복사했습니다")) },
						icon("copy"),
					)
				: null,
			h("span", bits.join(" · ")),
		);
	}

	renderUser(m) {
		const content = m.content;
		const text = textOfContent(content);
		const { body, files } = splitAttachments(text);
		const imgs = Array.isArray(content) ? content.filter((b) => b?.type === "image" && b.data) : [];
		return h(
			"div.msg-user",
			imgs.length ? h("div.user-imgs", imgs.map((b) => h("img", { src: `data:${b.mimeType};base64,${b.data}`, alt: "첨부 이미지" }))) : null,
			h(
				"div.user-row",
				h(
					"div.user-actions",
					h("button.icon-btn.small", { type: "button", title: "복사", onclick: () => copyText(text).then(() => this.onToast?.("복사했습니다")) }, icon("copy")),
					this.onFork ? h("button.icon-btn.small", { type: "button", title: "이 메시지부터 다시 (분기)", onclick: () => this.onFork(text) }, icon("branch")) : null,
				),
				text
						? h(
								"div.user-bubble",
								body ? h("div.user-text", body) : null,
								files.length ? h("div.user-files", files.map((f) => h("div.user-file", { title: f.path }, icon("file"), h("span.attach-name", basename(f.path)), f.size ? h("span.attach-size", f.size) : null))) : null,
							)
						: null,
			),
		);
	}

	renderTool(it, view, results, start) {
		return renderToolCard(it.block, view.tools[it.block.id], results.get(it.block.id), {
			expanded: this.expanded,
			streaming: it.streaming,
			onToggle: () => this.toggled(start),
		});
	}

	renderThinking(it, start) {
		const b = it.block;
		const open = this.expanded.get(it.key) ?? false;
		const text = b.thinking || (b.redacted ? "(암호화된 생각)" : "");
		const lines = text.trim().split("\n");
		const preview = truncate(lines[lines.length - 1] || "", 140);
		return h(
			`div.thinking${open ? ".open" : ""}`,
			h(
				"button.thinking-head",
				{
					type: "button",
					onclick: () => {
						this.expanded.set(it.key, !open);
						this.toggled(start);
					},
				},
				it.streaming ? h("span.spinner") : icon("brain"),
				h("span.thinking-label", it.streaming ? "생각 중" : "생각"),
				!open && preview ? h("span.thinking-preview", preview) : null,
				icon(open ? "chevronDown" : "chevron", "chev"),
			),
			open ? h("div.thinking-body", text) : null,
		);
	}

	renderGroup(run, view, results, start, liveTail) {
		const firstKey = run[0].key || run[0].block?.id || "";
		const key = `grp:${firstKey}`;
		const open = this.expanded.get(key) ?? false;
		const running = liveTail || run.some((it) => it.kind === "explore" && ["running", "pending"].includes(toolStatus(view.tools[it.block.id], results.get(it.block.id), it.streaming)));
		const failed = run.some((it) => it.kind === "explore" && results.get(it.block.id)?.isError);
		return h(
			`div.ctx-group${open ? ".open" : ""}`,
			h(
				"button.group-head",
				{
					type: "button",
					onclick: () => {
						this.expanded.set(key, !open);
						this.toggled(start);
					},
				},
				running ? h("span.spinner") : failed ? icon("alert", "err") : icon("search"),
				h("span.group-label", running ? "탐색 중" : "탐색함"),
				h("span.group-sum", exploreSummary(run)),
				icon(open ? "chevronDown" : "chevron", "chev"),
			),
			h(
				"div.group-items",
				open ? run.map((it) => (it.kind === "thinking" ? this.renderThinking(it, start) : this.renderTool(it, view, results, start))) : null,
			),
		);
	}

	renderBash(b, key, running, start) {
		const open = this.expanded.get(key) ?? true;
		const lines = stripAnsi(b.output || "").replace(/\n$/, "").split("\n");
		const showAll = this.expanded.get(`${key}:all`);
		const hidden = !showAll && lines.length > 16 ? lines.length - 16 : 0;
		const out = hidden ? lines.slice(-16).join("\n") : lines.join("\n");
		const badge = running
			? h("span.spinner")
			: b.cancelled
				? h("span.badge.warn", "취소됨")
				: b.exitCode === 0
					? h("span.badge.ok", "exit 0")
					: b.exitCode !== undefined && b.exitCode !== null
						? h("span.badge.err", `exit ${b.exitCode}`)
						: null;
		return h(
			"div.msg.bash",
			h(
				`div.tool-card.bash-card${open ? ".open" : ""}`,
				h(
					"button.tool-head",
					{
						type: "button",
						onclick: () => {
							this.expanded.set(key, !open);
							this.toggled(start);
						},
					},
					icon("terminal"),
					h("span.tool-name", b.excludeFromContext ? "!!" : "!"),
					h("span.tool-sum.mono", truncate(b.command, 200)),
					b.excludeFromContext ? h("span.tool-meta", "컨텍스트 제외") : null,
					badge,
					icon(open ? "chevronDown" : "chevron", "chev"),
				),
				open
					? h(
							"div.tool-body",
							hidden
								? h(
										"button.link-btn",
										{
											type: "button",
											onclick: () => {
												this.expanded.set(`${key}:all`, true);
												this.toggled(start);
											},
										},
										`앞부분 ${hidden}줄 더 보기`,
									)
								: null,
							out ? h("pre.tool-pre", out) : h("div.tool-wait", running ? "실행 중…" : "출력 없음"),
							b.truncated && b.fullOutputPath ? h("div.tool-note", `전체 출력: ${b.fullOutputPath}`) : null,
						)
					: null,
			),
		);
	}

	renderSummary(m, key, start) {
		const open = this.expanded.get(key) ?? false;
		const title = m.role === "compactionSummary" ? `세션 압축됨 · 이전 ${fmtTokens(m.tokensBefore)} 토큰 요약` : "다른 분기의 요약";
		return [
			h(
				"button.divider-row.msg.summary",
				{
					type: "button",
					onclick: () => {
						this.expanded.set(key, !open);
						this.toggled(start);
					},
				},
				h("span", title),
			),
			open ? h("div.summary-body.md", { html: md(m.summary || "") }) : null,
		].filter(Boolean);
	}

	activityLabel(view, turns, results) {
		if (view.retry) return `재시도 대기 중 (${view.retry.attempt}/${view.retry.maxAttempts})`;
		if (view.compacting) return "컨텍스트 압축 중";
		const msgs = view.messages;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m.role === "user") break;
			if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
			const running = m.content.filter((b) => b?.type === "toolCall" && ["running", "pending"].includes(toolStatus(view.tools[b.id], results.get(b.id), !!m._live)));
			const pick = running.length ? running[running.length - 1] : m._live ? m.content[m.content.length - 1] : null;
			if (!pick) break;
			if (pick.type === "thinking") return "생각 중";
			if (pick.type === "text") return "응답 작성 중";
			if (pick.type === "toolCall") {
				if (pick.name === "bash" || pick.name === "powershell") return "명령 실행 중";
				if (pick.name === "edit" || pick.name === "write") return "수정 중";
				if (EXPLORE.has(pick.name)) return "탐색 중";
				return `${pick.name} 실행 중`;
			}
			break;
		}
		return "작업 중";
	}

	renderTail(view, turns, results) {
		const parts = [];
		if (view.bash) parts.push(this.renderBash({ command: view.bash.command, output: view.bash.output, excludeFromContext: view.bash.excludeFromContext }, "bash:live", true));
		if (view.status === "running" || view.status === "compacting") {
			const lastTurn = turns[turns.length - 1];
			const startMsg = lastTurn ? view.messages[lastTurn.start] : null;
			const since = startMsg?.role === "user" && typeof startMsg.timestamp === "number" ? startMsg.timestamp : null;
			parts.push(
				h(
					"div.working",
					h("span.spinner"),
					h("span.working-label", this.activityLabel(view, turns, results)),
					since ? h("span.elapsed", fmtDuration(Math.max(0, Date.now() - since))) : null,
					h("span.kbd-hint", h("kbd", "Esc"), "중지"),
				),
			);
		}
		if (view.exited) {
			parts.push(
				h(
					"div.exited-box",
					h("div.exited-title", icon("alert"), `pi 프로세스가 종료되었습니다${view.exited.code !== null && view.exited.code !== undefined ? ` (코드 ${view.exited.code})` : ""}`),
					view.exited.error ? h("div", view.exited.error) : null,
					view.exited.stderr ? h("pre.tool-pre.err", view.exited.stderr.slice(-3000)) : null,
					h("button.btn.primary", { type: "button", "data-action": "restart" }, icon("refresh"), "다시 시작"),
				),
			);
		}
		this.tail.replaceChildren(...parts);
	}
}
