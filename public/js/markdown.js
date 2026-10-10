// Small, safe Markdown → HTML renderer (all text is escaped; only known tags are produced).
// Handles partial input while streaming (an unclosed code fence renders as an open code block).
import { escapeHtml } from "./util.js";

const SAFE_URL = /^(https?:|mailto:|#|\/(?!\/))/i;

// ---------- syntax highlighting (lightweight, language-agnostic-ish) ----------
const KW = {
	js: "async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined interface type enum implements private public protected readonly as",
	py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self",
	go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
	rust: "as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while dyn",
	sh: "if then else elif fi for while do done case esac in function return export local echo exit set unset cd source",
	c: "auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected virtual namespace using template typename new delete true false nullptr bool include define",
	java: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws try void volatile while true false null var record",
};
const LANG_ALIAS = {
	javascript: "js", jsx: "js", ts: "js", tsx: "js", typescript: "js", mjs: "js", cjs: "js", json: "js",
	python: "py", py: "py", go: "go", golang: "go", rust: "rust", rs: "rust",
	bash: "sh", sh: "sh", shell: "sh", zsh: "sh", powershell: "sh", ps1: "sh", console: "sh",
	c: "c", cpp: "c", "c++": "c", h: "c", hpp: "c", cs: "java", csharp: "java", java: "java", kotlin: "java", kt: "java", swift: "java",
};
const kwCache = new Map();

export function highlight(code, lang) {
	const l = (lang || "").toLowerCase();
	const key = LANG_ALIAS[l] || (KW[l] ? l : undefined);
	if (!key || code.length > 200_000) return escapeHtml(code);
	let kws = kwCache.get(key);
	if (!kws) {
		kws = new Set(KW[key].split(" "));
		kwCache.set(key, kws);
	}
	const hashComment = key === "py" || key === "sh";
	const re = hashComment
		? /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g
		: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
	let out = "";
	let last = 0;
	for (let m = re.exec(code); m; m = re.exec(code)) {
		out += escapeHtml(code.slice(last, m.index));
		const t = m[0];
		if (m[1]) out += `<span class="tok-c">${escapeHtml(t)}</span>`;
		else if (m[2]) out += `<span class="tok-s">${escapeHtml(t)}</span>`;
		else if (m[3]) out += `<span class="tok-n">${t}</span>`;
		else if (kws.has(t)) out += `<span class="tok-k">${t}</span>`;
		else if (code[re.lastIndex] === "(") out += `<span class="tok-f">${escapeHtml(t)}</span>`;
		else out += escapeHtml(t);
		last = re.lastIndex;
	}
	return out + escapeHtml(code.slice(last));
}

// ---------- inline ----------
function inline(text) {
	const slots = [];
	const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
	let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => keep(`<code>${escapeHtml(code.trim() === "" ? code : code.replace(/^ (.*) $/, "$1"))}</code>`));
	s = escapeHtml(s);
	// images → link (avoid loading remote images)
	s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, alt, url) => {
		const u = url.replace(/&amp;/g, "&");
		if (!SAFE_URL.test(u)) return m;
		return keep(`<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">🖼 ${alt || "image"}</a>`);
	});
	s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => {
		const u = url.replace(/&amp;/g, "&");
		if (!SAFE_URL.test(u)) return m;
		return keep(`<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
	});
	s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, u) => keep(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`));
	s = s.replace(/(^|[\s(])(https?:\/\/[^\s<\u0000]+[^\s<.,:;!?'")\]\u0000])/g, (_, pre, u) => pre + keep(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`));
	s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
	s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>");
	s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
	s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
	s = s.replace(/ {2,}\n|\\\n/g, "<br>").replace(/\n/g, "<br>");
	return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

// ---------- blocks ----------
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_QUOTE = /^ {0,3}>\s?(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function indentOf(line) {
	const m = /^[ \t]*/.exec(line)[0];
	return m.replace(/\t/g, "    ").length;
}

function splitRow(line) {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	const cells = [];
	let cur = "";
	let inCode = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "`") inCode = !inCode;
		if (ch === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
			continue;
		}
		if (ch === "|" && !inCode) {
			cells.push(cur.trim());
			cur = "";
		} else cur += ch;
	}
	cells.push(cur.trim());
	return cells;
}

function codeBlock(code, lang) {
	const label = lang ? escapeHtml(lang) : "";
	return `<div class="code-block"><div class="code-head"><span class="code-lang">${label}</span><button type="button" class="copy-code" title="복사">복사</button></div><pre><code>${highlight(code, lang)}</code></pre></div>`;
}

function renderBlocks(lines) {
	let html = "";
	let i = 0;
	let para = [];
	const flush = () => {
		if (para.length) {
			html += `<p>${inline(para.join("\n"))}</p>`;
			para = [];
		}
	};
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			flush();
			i++;
			continue;
		}
		const fence = RE_FENCE.exec(line);
		if (fence) {
			flush();
			const marker = fence[1];
			const lang = fence[2] || "";
			const body = [];
			i++;
			while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
			i++; // skip closing fence (or past end while streaming)
			html += codeBlock(body.join("\n"), lang);
			continue;
		}
		const heading = RE_HEADING.exec(line);
		if (heading) {
			flush();
			const level = heading[1].length;
			html += `<h${level}>${inline(heading[2])}</h${level}>`;
			i++;
			continue;
		}
		if (RE_HR.test(line) && !(para.length && /^\s*-+\s*$/.test(line))) {
			flush();
			html += "<hr>";
			i++;
			continue;
		}
		if (RE_QUOTE.test(line)) {
			flush();
			const body = [];
			while (i < lines.length && (RE_QUOTE.test(lines[i]) || (lines[i].trim() && !RE_LIST.test(lines[i]) && body.length && body[body.length - 1].trim()))) {
				const q = RE_QUOTE.exec(lines[i]);
				body.push(q ? q[1] : lines[i]);
				i++;
			}
			html += `<blockquote>${renderBlocks(body)}</blockquote>`;
			continue;
		}
		if (line.includes("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
			flush();
			const head = splitRow(line);
			const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
			i += 2;
			const rows = [];
			while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
			const td = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c ?? "")}</${tag}>`;
			html += `<div class="table-wrap"><table><thead><tr>${head.map((c, k) => td("th", c, k)).join("")}</tr></thead><tbody>${rows
				.map((r) => `<tr>${head.map((_, k) => td("td", r[k], k)).join("")}</tr>`)
				.join("")}</tbody></table></div>`;
			continue;
		}
		const li = RE_LIST.exec(line);
		if (li && (!para.length || li[2].length <= 2)) {
			flush();
			const ordered = /\d/.test(li[2]);
			const baseIndent = indentOf(line);
			const start = ordered ? Number.parseInt(li[2], 10) : 1;
			const items = [];
			while (i < lines.length) {
				const cur = lines[i];
				const m = RE_LIST.exec(cur);
				if (m && indentOf(cur) === baseIndent && /\d/.test(m[2]) === ordered) {
					const contentIndent = baseIndent + m[2].length + 1;
					const body = [m[3]];
					i++;
					while (i < lines.length) {
						const nxt = lines[i];
						if (!nxt.trim()) {
							// blank line: continue only if the following line is indented into the item
							if (i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > baseIndent) {
								body.push("");
								i++;
								continue;
							}
							break;
						}
						if (indentOf(nxt) > baseIndent) {
							body.push(nxt.slice(Math.min(contentIndent, indentOf(nxt))));
							i++;
							continue;
						}
						if (RE_LIST.test(nxt) || RE_FENCE.test(nxt) || RE_HEADING.test(nxt) || RE_QUOTE.test(nxt)) break;
						body.push(nxt.trim()); // lazy continuation
						i++;
					}
					items.push(body);
				} else break;
				if (i < lines.length && !lines[i].trim()) {
					const after = lines[i + 1];
					const am = after !== undefined ? RE_LIST.exec(after) : null;
					if (am && indentOf(after) === baseIndent && /\d/.test(am[2]) === ordered) i++;
				}
			}
			const itemsHtml = items
				.map((body) => {
					let task = "";
					const tm = /^\[([ xX])\]\s+/.exec(body[0]);
					if (tm) {
						task = `<input type="checkbox" disabled${tm[1] !== " " ? " checked" : ""}> `;
						body[0] = body[0].slice(tm[0].length);
					}
					let inner = renderBlocks(body);
					const tight = !body.some((l) => !l.trim());
					if (tight) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
					return `<li${task ? ' class="task"' : ""}>${task}${inner}</li>`;
				})
				.join("");
			html += ordered ? `<ol${start !== 1 ? ` start="${start}"` : ""}>${itemsHtml}</ol>` : `<ul>${itemsHtml}</ul>`;
			continue;
		}
		para.push(line);
		i++;
	}
	flush();
	return html;
}

export function renderMarkdown(text) {
	if (!text) return "";
	return renderBlocks(String(text).replace(/\r\n?/g, "\n").split("\n"));
}
