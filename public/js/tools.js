// Tool rows in the opencode style: one compact line (icon · title · subtitle · meta) that expands to details.
import { h, icon } from "./dom.js";
import { highlight } from "./markdown.js";
import { escapeHtml, fmtDuration, stripAnsi, textOfContent, truncate } from "./util.js";

export const TITLES = { bash: "Shell", powershell: "PowerShell", read: "Read", write: "Write", edit: "Edit", grep: "Grep", find: "Find", ls: "List" };
export const EXPLORE = new Set(["read", "grep", "find", "ls"]);
const ICON = { bash: "terminal", powershell: "terminal", read: "file", write: "edit", edit: "edit", grep: "search", find: "search", ls: "folder" };

export function extLang(p) {
	const m = /\.([a-z0-9+]+)$/i.exec(p || "");
	return m ? m[1].toLowerCase() : "";
}

/** "src/app/main.ts" → [dir "src/app/", name "main.ts"] */
export function splitPath(p) {
	const s = String(p ?? "");
	const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
	return i >= 0 ? [s.slice(0, i + 1), s.slice(i + 1)] : ["", s];
}

export function pathEl(p, cls = "") {
	const [dir, name] = splitPath(p);
	return h(`span${cls ? `.${cls}` : ""}`, { title: p }, dir ? h("span.path-dir", dir) : null, name);
}

export function diffStats(diff) {
	let add = 0;
	let del = 0;
	for (const line of String(diff || "").split("\n")) {
		if (line.startsWith("+")) add++;
		else if (line.startsWith("-")) del++;
	}
	return { add, del };
}

export function statEl({ add, del }) {
	if (!add && !del) return null;
	return h("span.tool-stat", add ? h("span.add", `+${add}`) : null, del ? h("span.del", `-${del}`) : null);
}

function resultText(result) {
	if (!result) return "";
	return stripAnsi(textOfContent(result.content));
}

function images(result) {
	if (!result || !Array.isArray(result.content)) return [];
	return result.content.filter((b) => b && b.type === "image" && b.data);
}

export function pre(text, cls = "", lang = "") {
	const el = h(`pre.tool-pre${cls ? `.${cls}` : ""}`);
	el.innerHTML = lang ? highlight(text, lang) : escapeHtml(text);
	return el;
}

function tailLines(text, n) {
	const lines = text.replace(/\n$/, "").split("\n");
	if (lines.length <= n) return { text: lines.join("\n"), hidden: 0 };
	return { text: lines.slice(-n).join("\n"), hidden: lines.length - n };
}

const diffCache = new Map();
export function diffView(diff) {
	let html = diffCache.get(diff);
	if (html === undefined) {
		html = diff
			.split("\n")
			.map((line) => {
				const c = line[0];
				const cls = c === "+" ? "add" : c === "-" ? "del" : /^\s*\.\.\.\s*$/.test(line) ? "skip" : "ctx";
				return `<span class="dl ${cls}">${escapeHtml(line) || " "}</span>`;
			})
			.join("");
		if (diffCache.size > 300) diffCache.clear();
		diffCache.set(diff, html);
	}
	const el = h("pre.tool-pre.diff");
	el.innerHTML = html;
	return el;
}

export function editsPreview(edits) {
	if (!Array.isArray(edits)) return "";
	return edits
		.map((e) => {
			const o = (e?.oldText ?? "").split("\n").map((l) => `- ${l}`);
			const n = (e?.newText ?? "").split("\n").map((l) => `+ ${l}`);
			return [...o, ...n].join("\n");
		})
		.join("\n...\n");
}

export function fileHead(p, stats) {
	const [dir, name] = splitPath(p);
	return h("div.file-head", icon("file"), h("span.fname", name), dir ? h("span.fdir", dir) : null, h("span.spacer"), stats ? statEl(stats) : null);
}

function subtitleOf(name, a) {
	a = a || {};
	switch (name) {
		case "bash":
		case "powershell":
			return h("span.tool-sum.mono", { title: a.command ?? "" }, truncate(String(a.command ?? "").split("\n")[0], 200));
		case "read": {
			const range = a.offset || a.limit ? ` · ${a.offset ?? 1}${a.limit ? `–${(a.offset ?? 1) + a.limit - 1}` : "~"}행` : "";
			return h("span.tool-sum", pathEl(a.path ?? ""), range);
		}
		case "write":
		case "edit":
			return h("span.tool-sum", pathEl(a.path ?? ""));
		case "grep":
			return h("span.tool-sum", h("span.mono", a.pattern ?? ""), a.path ? h("span.path-dir", `  ${a.path}`) : null, a.glob ? h("span.path-dir", `  ${a.glob}`) : null);
		case "find":
			return h("span.tool-sum", h("span.mono", a.pattern ?? ""), a.path ? h("span.path-dir", `  ${a.path}`) : null);
		case "ls":
			return h("span.tool-sum", pathEl(a.path ?? "."));
		default: {
			const json = JSON.stringify(a);
			return json && json !== "{}" ? h("span.tool-sum.mono", { title: json }, truncate(json, 160)) : null;
		}
	}
}

/** Status of a tool call from its execution record and result message. */
export function toolStatus(exec, resultMsg, streaming) {
	if (resultMsg) return resultMsg.isError ? "error" : "done";
	if (exec?.status) return exec.status;
	return streaming ? "pending" : "unknown";
}

/**
 * @param call toolCall block {id,name,arguments}
 * @param exec view.tools[id] or undefined
 * @param resultMsg toolResult message or undefined
 * @param opts {expanded: Map, streaming: boolean, onToggle()}
 */
export function renderToolCard(call, exec, resultMsg, opts) {
	const name = call.name || exec?.name || "tool";
	const args = call.arguments || exec?.args || {};
	const result = resultMsg || exec?.result || exec?.partial || null;
	const status = toolStatus(exec, resultMsg, opts.streaming);
	const isError = status === "error";
	const text = resultText(result);
	const details = resultMsg?.details ?? exec?.result?.details;
	const stats = name === "edit" ? (details?.diff ? diffStats(details.diff) : diffStats(editsPreview(args.edits))) : name === "write" ? { add: String(args.content ?? "").split("\n").length, del: 0 } : null;

	let defaultOpen = false;
	if (name === "edit" || name === "bash" || name === "powershell") defaultOpen = true;
	else if (name === "write") defaultOpen = String(args.content ?? "").split("\n").length <= 12;
	if (isError) defaultOpen = true;
	const key = call.id || `${name}:${JSON.stringify(args).slice(0, 80)}`;
	const open = opts.expanded.has(key) ? opts.expanded.get(key) : defaultOpen;

	const lead =
		status === "running" || status === "pending"
			? h("span.spinner")
			: isError
				? icon("alert", "err")
				: icon(ICON[name] || "tool");
	const head = h(
		"button.tool-head",
		{
			type: "button",
			onclick: () => {
				opts.expanded.set(key, !open);
				opts.onToggle?.();
			},
		},
		lead,
		h("span.tool-name", TITLES[name] || name),
		subtitleOf(name, args),
		stats ? statEl(stats) : null,
		h("span.tool-meta", exec?.durationMs !== undefined && exec.durationMs >= 1000 ? fmtDuration(exec.durationMs) : status === "aborted" ? "중단됨" : ""),
		icon(open ? "chevronDown" : "chevron", "chev"),
	);

	const card = h(`div.tool-card.tool-${name}.st-${status}${open ? ".open" : ""}`, head);
	if (!open) {
		if (isError && text) card.append(h("div.tool-hint.err", truncate(text.split("\n")[0], 200)));
		return card;
	}

	const body = h("div.tool-body");
	if (name === "bash" || name === "powershell") {
		const cmd = String(args.command ?? "");
		if (cmd.includes("\n")) body.append(pre(cmd, "cmd", "sh"));
		if (text) {
			const showAll = opts.expanded.get(`${key}:all`);
			const { text: shown, hidden } = showAll ? { text, hidden: 0 } : tailLines(text, 12);
			if (hidden)
				body.append(
					h(
						"button.link-btn",
						{
							type: "button",
							onclick: () => {
								opts.expanded.set(`${key}:all`, true);
								opts.onToggle?.();
							},
						},
						`앞부분 ${hidden}줄 더 보기`,
					),
				);
			body.append(pre(shown, isError ? "err" : ""));
		} else if (status === "running" || status === "pending") body.append(h("div.tool-wait", "실행 중…"));
		else if (status === "done") body.append(h("div.tool-wait", "출력 없음"));
		if (details?.fullOutputPath) body.append(h("div.tool-note", `전체 출력: ${details.fullOutputPath}`));
	} else if (name === "edit") {
		if (details?.diff) body.append(diffView(details.diff));
		else if (!resultMsg && args.edits) body.append(diffView(editsPreview(args.edits)));
		if (isError && text) body.append(pre(text, "err"));
	} else if (name === "write") {
		body.append(pre(String(args.content ?? ""), "", extLang(args.path)));
		if (isError && text) body.append(pre(text, "err"));
	} else if (name === "read") {
		for (const img of images(result)) body.append(h("img.tool-img", { src: `data:${img.mimeType};base64,${img.data}`, alt: args.path ?? "" }));
		if (text) body.append(pre(text, isError ? "err" : "", isError ? "" : extLang(args.path)));
		else if (status === "running" || status === "pending") body.append(h("div.tool-wait", "읽는 중…"));
	} else {
		if (Object.keys(args).length) body.append(pre(JSON.stringify(args, null, 2), "cmd", "json"));
		for (const img of images(result)) body.append(h("img.tool-img", { src: `data:${img.mimeType};base64,${img.data}` }));
		if (text) body.append(pre(text, isError ? "err" : ""));
	}
	if (body.childNodes.length) card.append(body);
	return card;
}
