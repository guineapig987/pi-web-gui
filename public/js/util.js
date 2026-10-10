// Formatting and misc helpers.

export function escapeHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// biome-ignore lint: control characters are intentional
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
export function stripAnsi(s) {
	return String(s ?? "").replace(ANSI_RE, "");
}

export function basename(p) {
	if (!p) return "";
	const parts = String(p).split(/[\\/]+/).filter(Boolean);
	return parts.length ? parts[parts.length - 1] : p;
}

export function fmtTokens(n) {
	if (typeof n !== "number" || !Number.isFinite(n)) return "–";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(n);
}

export function fmtCost(c) {
	if (typeof c !== "number" || !Number.isFinite(c)) return "";
	if (c === 0) return "$0";
	if (c < 0.01) return `$${c.toFixed(4)}`;
	return `$${c.toFixed(2)}`;
}

export function fmtDuration(ms) {
	if (typeof ms !== "number") return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}초`;
	const m = Math.floor(s / 60);
	return `${m}분 ${Math.round(s % 60)}초`;
}

export function relTime(ts) {
	if (!ts) return "";
	const t = typeof ts === "number" ? ts : Date.parse(ts);
	const d = (Date.now() - t) / 1000;
	if (d < 45) return "방금";
	if (d < 3600) return `${Math.round(d / 60)}분 전`;
	if (d < 86400) return `${Math.round(d / 3600)}시간 전`;
	if (d < 86400 * 7) return `${Math.round(d / 86400)}일 전`;
	const dt = new Date(t);
	return `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, "0")}.${String(dt.getDate()).padStart(2, "0")}`;
}

export function textOfContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

export function truncate(s, n) {
	s = String(s ?? "");
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function debounce(fn, ms) {
	let t = null;
	return (...a) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...a), ms);
	};
}

export function store(key, value) {
	try {
		if (value === undefined) return JSON.parse(localStorage.getItem(`piweb.${key}`) ?? "null");
		localStorage.setItem(`piweb.${key}`, JSON.stringify(value));
	} catch {
		return null;
	}
	return value;
}

export async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} catch {}
		ta.remove();
		return ok;
	}
}

export function fileToImageContent(file) {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => {
			const s = String(r.result);
			const i = s.indexOf(",");
			resolve({ type: "image", data: s.slice(i + 1), mimeType: file.type || "image/png", name: file.name || "image" });
		};
		r.onerror = () => reject(r.error);
		r.readAsDataURL(file);
	});
}

export function fmtBytes(n) {
	if (typeof n !== "number" || !Number.isFinite(n)) return "";
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
	if (n >= 1024) return `${Math.round(n / 1024)}KB`;
	return `${n}B`;
}

// Attached (non-image) files travel as a block at the end of the prompt text so pi can open them by path.
export const ATTACH_MARK = "[첨부 파일]";

export function attachmentNote(files) {
	return `\n\n${ATTACH_MARK}\n${files.map((f) => `- ${f.path} (${fmtBytes(f.size)})`).join("\n")}`;
}

/** Inverse of attachmentNote: {body, files:[{path, size}]}; text without a well-formed block is returned unchanged. */
export function splitAttachments(text) {
	const s = String(text ?? "");
	const head = `\n\n${ATTACH_MARK}\n`;
	const i = s.lastIndexOf(head);
	if (i < 0) return { body: s, files: [] };
	const files = [];
	for (const line of s.slice(i + head.length).split("\n")) {
		const m = /^- (.+) \(([^()]*)\)$/.exec(line);
		if (!m) return { body: s, files: [] };
		files.push({ path: m[1], size: m[2] });
	}
	return { body: s.slice(0, i), files };
}

export const STATUS_LABEL = {
	starting: "시작 중",
	idle: "대기",
	running: "작업 중",
	waiting: "응답 필요",
	compacting: "압축 중",
	exited: "종료됨",
};
