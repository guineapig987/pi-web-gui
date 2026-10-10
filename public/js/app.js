// pi web — main controller (opencode-style shell: session tabs, home, session view, review panel, palette).
import { openAccountModal } from "./account.js";
import { api, openGlobalStream, openSessionStream } from "./api.js";
import { Composer } from "./composer.js";
import { h, icon, setChildren } from "./dom.js";
import { closeTopModal, modalOpen, openModal, pickFolder, pickFromList, showExtensionDialog, toast } from "./modals.js";
import { applyEvent, createView } from "./reducer.js";
import { openSettingsModal } from "./settings.js";
import { diffStats, diffView, extLang, fileHead, pre, splitPath } from "./tools.js";
import { Transcript } from "./transcript.js";
import { openUpdateModal } from "./update.js";
import { attachmentNote, basename, copyText, debounce, fmtCost, fmtTokens, relTime, splitAttachments, STATUS_LABEL, store, truncate } from "./util.js";

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

const S = {
	info: null,
	cwd: null,
	projects: [],
	sessions: [],
	live: [],
	activeId: null,
	view: createView(),
	es: null,
	models: null,
	drafts: new Map(),
	dock: null,
	filter: "",
	prevStatus: null,
	editorTextN: 0,
	notify: store("notify") === true,
	serverUp: true,
	reviewOpen: store("reviewOpen") === true,
	reviewExpanded: new Map(),
	branches: new Map(),
	update: null, // pi version status from /api/pi/update
	// Left sidebar with the running sessions; on narrow screens it slides over the page instead.
	sidebar: store("sidebar") !== false && !window.matchMedia("(max-width: 760px)").matches,
	collapsed: new Set(Array.isArray(store("sidebarCollapsed")) ? store("sidebarCollapsed") : []),
	all: [], // saved sessions of every project (sidebar)
	extra: Array.isArray(store("sidebarProjects")) ? store("sidebarProjects") : [], // folders opened here that have no saved session yet
	hiddenProjects: new Set(Array.isArray(store("hiddenProjects")) ? store("hiddenProjects") : []),
	more: new Set(), // projects whose full session list is shown
	sbFilter: "",
};

const NARROW = window.matchMedia("(max-width: 760px)");
const SB_LIMIT = 5;
const projKey = (cwd) => String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const saveExtra = () => store("sidebarProjects", S.extra.slice(0, 40));
const saveHiddenProjects = () => store("hiddenProjects", [...S.hiddenProjects]);

/** Projects for the sidebar: each with its running sessions and its saved (not running) sessions. */
function sidebarProjects() {
	const map = new Map();
	const get = (cwd, stamp = 0) => {
		const k = projKey(cwd);
		if (!map.has(k)) map.set(k, { key: k, cwd, stamp, live: [], saved: [] });
		const p = map.get(k);
		p.stamp = Math.max(p.stamp, stamp);
		return p;
	};
	for (const p of S.projects) get(p.cwd, p.lastModified || 0);
	for (const cwd of S.extra) get(cwd, 0);
	if (S.cwd) get(S.cwd, 0);
	const liveFiles = new Set(S.live.map((l) => l.sessionFile).filter(Boolean));
	for (const l of S.live) get(l.cwd, 0).live.push(l);
	for (const x of S.all) if (x.cwd && !liveFiles.has(x.path)) get(x.cwd, x.modified).saved.push(x);
	const q = S.sbFilter.trim().toLowerCase();
	const list = [...map.values()].filter((p) => p.live.length || !S.hiddenProjects.has(p.key));
	for (const p of list) {
		p.saved.sort((a, b) => b.modified - a.modified);
		if (q) {
			const match = (t) => String(t ?? "").toLowerCase().includes(q);
			p.live = p.live.filter((l) => match(tabTitle(l)) || match(p.cwd));
			p.saved = p.saved.filter((x) => match(x.name) || match(x.firstMessage) || match(p.cwd));
		}
	}
	return list.filter((p) => !q || p.live.length || p.saved.length).sort((a, b) => (b.live.length ? 1 : 0) - (a.live.length ? 1 : 0) || b.stamp - a.stamp);
}
/** Running sessions in the order the sidebar shows them (what Alt+1…9 count). */
const visibleTabs = () => sidebarProjects().flatMap((p) => p.live);

/** Makes a div behave like a button for the keyboard (Enter / Space). */
const kbdActivate = (fn) => (e) => {
	if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
		e.preventDefault();
		fn(e);
	}
};

// ---------- layout ----------
const titlebar = document.getElementById("titlebar");
const sidebar = document.getElementById("sidebar");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");
sidebarBackdrop.addEventListener("click", () => setSidebar(false));
NARROW.addEventListener("change", () => {
	if (NARROW.matches) S.sidebar = false;
	else S.sidebar = store("sidebar") !== false;
	renderSidebar();
});
const viewHome = document.getElementById("view-home");
const viewSession = document.getElementById("view-session");
const sessionHead = document.getElementById("session-head");
const scroller = document.getElementById("transcript-wrap");
const transcriptEl = document.getElementById("transcript");
const reviewEl = document.getElementById("review");
const newSessionEl = h("div.new-session.hidden");
scroller.prepend(newSessionEl);
const composerHost = document.getElementById("composer-area");
const bannerEl = h("div.banner.hidden");
composerHost.append(bannerEl);
// Floating "jump to latest" button, shown when the transcript is scrolled away from the bottom.
const jumpLabel = h("span", "맨 아래로");
const jumpBtn = h("button.jump-bottom.hidden", { type: "button", title: "맨 아래로 이동", onclick: () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }) }, icon("chevronDown"), jumpLabel);
composerHost.append(jumpBtn);
function updateJump() {
	const away = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
	const show = !!S.activeId && away > 240;
	const busy = show && isRunning();
	jumpBtn.classList.toggle("hidden", !show);
	jumpBtn.classList.toggle("busy", busy);
	jumpLabel.textContent = busy ? "작업 중 · 맨 아래로" : "맨 아래로";
}
scroller.addEventListener("scroll", updateJump, { passive: true });

const transcript = new Transcript(transcriptEl, {
	onRequestRender: () => scheduleRender(),
	onToast: (m) => toast(m),
	onOpenFile: (p) => openReviewAt(p),
	onFork: (text) => forkFromText(text),
});
const composer = new Composer(composerHost, {
	getContext: () => ({ running: isRunning(), cwd: currentCwd(), commands: slashCommands(), modelInput: S.view.state?.model?.input }),
	onSubmit: (p) => submit(p),
	onAbort: () => abort(),
	onClearQueue: () => clearQueueToEditor(),
	onToast: (m, k) => toast(m, k),
	onModelClick: () => openModelPicker(),
	onThinkingClick: (anchor) => openThinkingMenu(anchor),
});

function currentCwd() {
	return S.activeId ? S.live.find((l) => l.id === S.activeId)?.cwd || S.cwd : S.cwd;
}

function isRunning() {
	const v = S.view;
	return !!(S.activeId && (v.running || v.compacting || v.status === "waiting"));
}

function isEmptySession(v = S.view) {
	return !!v.state && !v.exited && v.status === "idle" && !v.messages.some((m) => m.role !== "_notice" && m.role !== "system");
}

// ---------- theme ----------
function applyTheme() {
	const t = store("theme");
	if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
	else delete document.documentElement.dataset.theme;
}
applyTheme();

function toggleTheme() {
	const cur = store("theme");
	const isDark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
	store("theme", isDark ? "light" : "dark");
	applyTheme();
}

// ---------- project avatar ----------
function hash(s) {
	let x = 0;
	for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) | 0;
	return Math.abs(x);
}
function avatar(cwd, large = false) {
	const name = basename(cwd) || "?";
	const ch = [...name.replace(/^[._-]+/, "")][0] || "?";
	return h(`span.avatar.c${hash(String(cwd).toLowerCase()) % 8}${large ? ".lg" : ""}`, { title: cwd }, ch.toUpperCase());
}

// ---------- built-in slash commands ----------
const BUILTINS = [
	{ name: "new", description: "새 세션 시작", run: () => newSession() },
	{ name: "resume", description: "이전 세션 열기", run: () => openPalette("세션") },
	{ name: "model", description: "모델 선택", run: (a) => openModelPicker(a) },
	{ name: "thinking", description: "생각 수준 설정 (off, low, medium, high…)", run: (a) => (a ? setThinking(a) : openThinkingPicker()) },
	{ name: "compact", description: "컨텍스트 압축 [추가 지시]", run: (a) => compact(a) },
	{ name: "name", description: "세션 이름 변경", run: (a) => (a ? rename(a) : promptRename()) },
	{ name: "fork", description: "이전 메시지에서 분기", run: () => openForkPicker() },
	{ name: "clone", description: "현재 세션 복제", run: () => cloneSession() },
	{ name: "export", description: "HTML로 내보내기", run: () => exportHtml() },
	{ name: "copy", description: "마지막 응답 복사", run: () => copyLast() },
	{ name: "stats", description: "토큰·비용 통계", run: () => showStats() },
	{ name: "review", description: "변경 사항 패널 열기/닫기", run: () => toggleReview() },
	{ name: "open", description: "프로젝트 폴더 열기", run: () => openFolderPicker() },
	{ name: "close", description: "세션 닫기 (pi 프로세스 종료)", run: () => closeSession() },
	{ name: "login", description: "모델 공급자에 로그인 (구독 계정 또는 API 키)", run: () => openAccount() },
	{ name: "logout", description: "저장된 로그인 정보 지우기", run: () => openAccount() },
	{ name: "settings", description: "설정 열기", run: () => openSettings() },
	{ name: "update", description: "pi 업데이트 확인·실행", run: () => openUpdate() },
	{ name: "help", description: "도움말과 단축키", run: () => showHelp() },
];

function slashCommands() {
	const names = new Set(BUILTINS.map((b) => b.name));
	const pi = (S.view.commands || []).filter((c) => !names.has(c.name)).map((c) => ({ name: c.name, description: c.description || "", source: c.source }));
	return [...BUILTINS.map((b) => ({ name: b.name, description: b.description, source: "builtin" })), ...pi];
}

// ---------- session lifecycle ----------
function closeStream() {
	if (S.es) {
		S.es.close();
		S.es = null;
	}
}

function closeIfEmpty() {
	const id = S.activeId;
	if (id && isEmptySession() && !composer.value.trim()) api.close(id).catch(() => {});
}

function leaveCurrent() {
	if (!S.activeId) return;
	S.drafts.set(S.activeId, composer.getDraft());
	closeIfEmpty();
	closeStream();
	S.dock?.close?.();
	S.dock = null;
}

async function attach(id) {
	if (S.activeId === id && S.es) return;
	leaveCurrent();
	S.activeId = id;
	if (NARROW.matches) setSidebar(false);
	S.view = createView();
	S.models = null;
	S.prevStatus = null;
	S.editorTextN = 0;
	transcript.reset();
	composer.setDraft(S.drafts.get(id));
	const summary = S.live.find((l) => l.id === id);
	if (summary?.cwd && summary.cwd !== S.cwd) setCwd(summary.cwd, { keepSession: true });
	history.replaceState(null, "", `#/s/${id}`);
	const es = openSessionStream(id, {
		onSnapshot: (view) => {
			S.view = view;
			S.editorTextN = view.editorText?.n || 0;
			transcript.reset();
			scheduleRender();
		},
		onEvent: (ev) => {
			applyEvent(S.view, ev);
			sideEffects(ev);
			scheduleRender();
		},
		onState: (ok) => {
			if (!ok && es.readyState === 2 && S.es === es) {
				toast("세션 연결이 끊겼습니다", "warn");
				goHome();
			}
		},
	});
	S.es = es;
	renderAll();
	composer.focus();
}

function goHome() {
	leaveCurrent();
	S.activeId = null;
	S.view = createView();
	transcript.reset();
	history.replaceState(null, "", "#/");
	refreshSessions();
	renderAll();
}

async function newSession(cwd = currentCwd()) {
	if (!cwd) return openFolderPicker();
	if (S.activeId && isEmptySession() && currentCwd() === cwd) {
		composer.focus();
		return;
	}
	try {
		const live = await api.open(cwd);
		if (!S.live.some((l) => l.id === live.id)) S.live = [...S.live, live];
		await attach(live.id);
	} catch (err) {
		toast(err.message, "error");
	}
}

async function openDiskSession(s) {
	try {
		const live = await api.open(s.cwd, s.path);
		if (!S.live.some((l) => l.id === live.id)) S.live = [...S.live, live];
		await attach(live.id);
	} catch (err) {
		toast(err.message, "error");
	}
}

async function closeSession(id = S.activeId) {
	if (!id) return;
	const live = S.live.find((l) => l.id === id);
	if (live && (live.status === "running" || live.status === "waiting")) {
		const ok = await confirmModal("작업 중인 세션을 닫을까요?", "pi 프로세스가 종료되고 진행 중인 작업이 중단됩니다. 대화 기록은 세션 파일에 남습니다.", "닫기");
		if (!ok) return;
	}
	try {
		const before = visibleTabs();
		const idx = before.findIndex((l) => l.id === id);
		await api.close(id);
		S.live = S.live.filter((l) => l.id !== id);
		if (id === S.activeId) {
			S.activeId = null;
			closeStream();
			const rest = visibleTabs();
			const next = rest[Math.min(Math.max(idx, 0), rest.length - 1)];
			if (next) attach(next.id);
			else goHome();
		} else {
			renderTitlebar();
			if (!S.activeId) renderHome();
		}
	} catch (err) {
		toast(err.message, "error");
	}
}

function setSidebar(open) {
	S.sidebar = open;
	// On narrow screens the drawer always starts closed, so its state is not worth remembering.
	if (!NARROW.matches) store("sidebar", open);
	renderSidebar();
}

function rememberProject(cwd) {
	const k = projKey(cwd);
	if (S.hiddenProjects.delete(k)) saveHiddenProjects();
	if (!S.extra.some((c) => projKey(c) === k)) {
		S.extra.unshift(cwd);
		saveExtra();
	}
}

function setCwd(cwd, { keepSession = false } = {}) {
	if (!cwd || cwd === S.cwd) return;
	S.cwd = cwd;
	store("cwd", cwd);
	rememberProject(cwd);
	if (!keepSession && S.activeId) goHome();
	refreshSessions();
	loadBranch(cwd);
	renderAll();
}

async function loadBranch(cwd) {
	if (!cwd || S.branches.has(cwd)) return;
	S.branches.set(cwd, null);
	try {
		const p = await api.project(cwd);
		S.branches.set(cwd, p.branch);
		renderActive();
	} catch {}
}

function confirmModal(title, message, okLabel = "확인") {
	return new Promise((resolve) => {
		let done = false;
		const finish = (v) => {
			if (done) return;
			done = true;
			m.close();
			resolve(v);
		};
		const m = openModal({
			title,
			body: h("div.dialog-message.muted", message),
			actions: [h("button.btn", { type: "button", onclick: () => finish(false) }, "취소"), h("button.btn.primary", { type: "button", onclick: () => finish(true) }, okLabel)],
			onClose: () => {
				if (!done) {
					done = true;
					resolve(false);
				}
			},
		});
	});
}

// ---------- commands ----------
async function cmd(command) {
	const id = S.activeId;
	if (!id) throw new Error("열린 세션이 없습니다");
	return api.command(id, command);
}

async function ensureSession() {
	if (S.activeId) return S.activeId;
	await newSession();
	if (!S.activeId) throw new Error("세션을 열지 못했습니다");
	return S.activeId;
}

async function submit({ text, images, files = [], mode }) {
	const trimmed = text.trim();
	const attached = images.length > 0 || files.length > 0;
	if (trimmed.startsWith("/") && !attached) {
		const name = trimmed.slice(1).split(/\s+/)[0];
		const builtin = BUILTINS.find((b) => b.name === name);
		if (builtin) {
			builtin.run(trimmed.slice(1 + name.length).trim());
			return true;
		}
	}
	let id;
	try {
		id = await ensureSession();
	} catch (err) {
		toast(err.message, "error");
		composer.value = text;
		composer.restoreAttachments({ images, files });
		return true;
	}
	if (trimmed.startsWith("!") && !attached) {
		const exclude = trimmed.startsWith("!!");
		const command = trimmed.slice(exclude ? 2 : 1).trim();
		if (command) api.command(id, { type: "bash", command, excludeFromContext: exclude }).catch((err) => toast(err.message, "error"));
		return true;
	}
	// Non-image files are passed by path (pi opens them with its own tools); the transcript shows them as chips.
	const message = files.length ? `${trimmed ? text : "첨부한 파일을 확인해 주세요."}${attachmentNote(files)}` : text;
	const command = { type: "prompt", message };
	if (images.length) command.images = images;
	if (S.view.running || S.view.compacting) command.streamingBehavior = mode === "followUp" ? "followUp" : "steer";
	api.command(id, command).catch((err) => {
		toast(err.message, "error");
		if (!composer.value.trim()) composer.value = text;
		composer.restoreAttachments({ images, files });
	});
	return true;
}

async function abort() {
	const id = S.activeId;
	if (!id) return;
	const v = S.view;
	if (v.bash) {
		api.command(id, { type: "abort_bash" }).catch(() => {});
		return;
	}
	if (!(v.running || v.compacting)) return;
	try {
		await clearQueueToEditor();
	} catch {}
	api.command(id, { type: "abort" }).catch((err) => toast(err.message, "error"));
}

async function clearQueueToEditor() {
	const q = await cmd({ type: "clear_queue" });
	const restored = [...(q?.steering || []), ...(q?.followUp || [])].join("\n\n");
	if (restored) {
		composer.value = composer.value.trim() ? `${composer.value}\n\n${restored}` : restored;
		composer.focus();
	}
}

async function loadModels() {
	if (!S.models) S.models = (await cmd({ type: "get_available_models" })).models || [];
	return S.models;
}

async function openModelPicker(query = "") {
	let models;
	try {
		await ensureSession();
		models = await loadModels();
	} catch (err) {
		return toast(err.message, "error");
	}
	if (!models.length) return toast("사용 가능한 모델이 없습니다. 터미널에서 pi를 실행해 /login 하세요.", "warn");
	const setModel = (m) => cmd({ type: "set_model", provider: m.provider, modelId: m.id }).catch((err) => toast(err.message, "error"));
	const q = query.trim().toLowerCase();
	if (q) {
		const exact = models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === q || m.id.toLowerCase() === q);
		if (exact) return setModel(exact);
	}
	const cur = S.view.state?.model;
	const items = models.map((m) => ({
		label: m.name || m.id,
		sub: `${m.id} · 컨텍스트 ${fmtTokens(m.contextWindow)}${m.reasoning ? " · 추론" : ""}${m.input?.includes("image") ? " · 이미지" : ""}${m.cost ? ` · $${m.cost.input}/$${m.cost.output}` : ""}`,
		group: m.provider,
		value: m,
		search: `${m.provider}/${m.id}`,
		current: !!cur && cur.provider === m.provider && cur.id === m.id,
	}));
	const modal = pickFromList({ title: "모델 선택", items, placeholder: "모델 검색", onPick: setModel });
	if (q) {
		const input = modal.el.querySelector("input");
		input.value = query;
		input.dispatchEvent(new Event("input"));
	}
}

const THINKING_LABEL = { off: "생각 끔", minimal: "최소", low: "낮음", medium: "보통", high: "높음", xhigh: "매우 높음", max: "최대" };

function setThinking(level) {
	cmd({ type: "set_thinking_level", level }).catch((err) => toast(err.message, "error"));
}

function openThinkingMenu(anchor) {
	const levels = S.view.thinkingLevels || [];
	if (levels.length <= 1) return;
	openMenu(
		anchor,
		levels.map((l) => ({ label: THINKING_LABEL[l] || l, hint: l, checked: S.view.state?.thinkingLevel === l, run: () => setThinking(l) })),
		{ above: true },
	);
}

function openThinkingPicker() {
	const levels = S.view.thinkingLevels || [];
	if (levels.length <= 1) return toast("현재 모델은 생각 수준을 지원하지 않습니다", "warn");
	pickFromList({ title: "생각 수준", items: levels.map((l) => ({ label: `${THINKING_LABEL[l] || l} (${l})`, value: l, current: S.view.state?.thinkingLevel === l })), onPick: setThinking });
}

function compact(instructions) {
	cmd({ type: "compact", ...(instructions ? { customInstructions: instructions } : {}) }).catch((err) => toast(`압축 실패: ${err.message}`, "error"));
}

function rename(name) {
	cmd({ type: "set_session_name", name }).catch((err) => toast(err.message, "error"));
}

function promptRename() {
	if (!S.activeId) return;
	const input = h("input.input", { type: "text", value: S.view.state?.sessionName || "", autofocus: true });
	const m = openModal({
		title: "세션 이름",
		body: [input],
		actions: [h("button.btn", { type: "button", onclick: () => m.close() }, "취소"), h("button.btn.primary", { type: "button", onclick: () => save() }, "저장")],
	});
	const save = () => {
		const v = input.value.trim();
		m.close();
		if (v) rename(v);
	};
	input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && save());
	setTimeout(() => input.select(), 0);
}

async function doFork(entryId, fallbackText) {
	try {
		const r = await cmd({ type: "fork", entryId });
		if (r?.cancelled) return toast("확장이 분기를 취소했습니다", "warn");
		composer.value = r?.text || fallbackText || "";
		composer.focus();
		toast("새 분기를 만들었습니다. 메시지를 고쳐 다시 보내세요.");
	} catch (err) {
		toast(err.message, "error");
	}
}

async function forkFromText(text) {
	if (isRunning()) return toast("작업이 끝난 뒤 분기할 수 있습니다", "warn");
	try {
		const data = await cmd({ type: "get_fork_messages" });
		const match = [...(data.messages || [])].reverse().find((m) => m.text.trim() === text.trim());
		if (!match) return openForkPicker();
		doFork(match.entryId, text);
	} catch (err) {
		toast(err.message, "error");
	}
}

async function openForkPicker() {
	if (!S.activeId) return;
	try {
		const data = await cmd({ type: "get_fork_messages" });
		const msgs = (data.messages || []).slice().reverse();
		pickFromList({
			title: "어느 메시지에서 분기할까요?",
			items: msgs.map((m, i) => ({ label: truncate(m.text.replace(/\s+/g, " "), 140) || "(빈 메시지)", sub: i === 0 ? "가장 최근" : null, value: m })),
			emptyText: "분기할 메시지가 없습니다",
			onPick: (m) => doFork(m.entryId, m.text),
		});
	} catch (err) {
		toast(err.message, "error");
	}
}

function cloneSession() {
	cmd({ type: "clone" })
		.then((r) => toast(r?.cancelled ? "복제가 취소되었습니다" : "세션을 복제했습니다"))
		.catch((err) => toast(err.message, "error"));
}

async function exportHtml() {
	try {
		const r = await cmd({ type: "export_html" });
		openModal({
			title: "HTML로 내보냈습니다",
			body: [h("div.mono.muted", { style: { fontSize: "12px", wordBreak: "break-all" } }, r.path), h("div", h("a.btn.primary", { href: `/api/download?path=${encodeURIComponent(r.path)}`, download: basename(r.path) }, "다운로드"))],
		});
	} catch (err) {
		toast(err.message, "error");
	}
}

async function copyLast() {
	try {
		const r = await cmd({ type: "get_last_assistant_text" });
		if (!r?.text) return toast("복사할 응답이 없습니다", "warn");
		await copyText(r.text);
		toast("마지막 응답을 복사했습니다");
	} catch (err) {
		toast(err.message, "error");
	}
}

function showStats() {
	const st = S.view.stats;
	if (!st) return toast("통계가 아직 없습니다", "warn");
	const row = (k, v) => h("tr", h("th", k), h("td", v));
	openModal({
		title: "세션 통계",
		body: h(
			"table.stats",
			row("메시지", `사용자 ${st.userMessages} · 어시스턴트 ${st.assistantMessages} · 도구 결과 ${st.toolResults}`),
			row("입력 토큰", fmtTokens(st.tokens?.input)),
			row("출력 토큰", fmtTokens(st.tokens?.output)),
			row("캐시 읽기/쓰기", `${fmtTokens(st.tokens?.cacheRead)} / ${fmtTokens(st.tokens?.cacheWrite)}`),
			row("비용", fmtCost(st.cost) || "–"),
			row("컨텍스트", st.contextUsage ? `${fmtTokens(st.contextUsage.tokens)} / ${fmtTokens(st.contextUsage.contextWindow)} (${st.contextUsage.percent ?? "?"}%)` : "–"),
			row("세션 파일", h("span.mono", { style: { fontSize: "12px" } }, st.sessionFile || "–")),
		),
	});
}

const SHORTCUTS = [
	["명령 팔레트", `${MOD}K`],
	["새 세션", `${MOD}Shift+S`],
	["입력창으로 이동", `${MOD}L`],
	["변경 사항 패널", `${MOD}Shift+E`],
	["홈", "Alt+0"],
	["세션 전환", "Alt+1…9"],
	["사이드바 접기/열기", `${MOD}B`],
	["작업 중지", "Esc"],
];

function showHelp() {
	const cmds = slashCommands();
	openModal({
		title: "도움말",
		wide: true,
		body: [
			h("h4", "입력"),
			h(
				"ul.help",
				h("li", h("kbd", "Enter"), " 보내기 · ", h("kbd", "Shift+Enter"), " 줄바꿈 · ", h("kbd", "↑"), " 이전 입력"),
				h("li", "작업 중 ", h("kbd", "Enter"), " = 지금 끼어들기(조향), ", h("kbd", `${MOD}Enter`), " = 작업이 끝난 뒤 보내기"),
				h("li", h("code", "@"), " 파일 · ", h("code", "/"), " 명령 · ", h("code", "!명령"), " 셸 실행(결과를 컨텍스트에 추가) · ", h("code", "!!명령"), " 컨텍스트 제외"),
				h("li", "이미지: 붙여넣기, 끌어놓기, 이미지 버튼"),
			),
			h("h4", "단축키"),
			h("div.help-cmds", SHORTCUTS.map(([k, v]) => h("div.help-cmd", h("span", k), h("span"), h("kbd", v)))),
			h("h4", "명령"),
			h("div.help-cmds", cmds.map((c) => h("div.help-cmd", h("code", `/${c.name}`), h("span", c.description || ""), c.source !== "builtin" ? h("span.badge", c.source) : h("span")))),
		],
	});
}

/** Restart the (empty) new session in folder `p`, keeping any text typed in the composer. */
async function startInFolder(p) {
	const old = S.activeId;
	if (old && p === currentCwd()) return composer.focus();
	const draft = composer.getDraft();
	try {
		const live = await api.open(p);
		if (!S.live.some((l) => l.id === live.id)) S.live = [...S.live, live];
		setCwd(p, { keepSession: true });
		await attach(live.id);
		composer.setDraft(draft);
		if (old && old !== live.id) {
			S.live = S.live.filter((l) => l.id !== old);
			// attach() already closed the old session when it was empty and had no draft
			if (draft.text.trim() || draft.images.length) api.close(old).catch(() => {});
		}
		renderAll();
	} catch (err) {
		toast(err.message, "error");
	}
}

/** Ask the OS folder dialog (Explorer-style, with a "새 폴더 만들기" button). → path, or null when cancelled. */
async function browseNative(start) {
	const r = await api.pickNative(start || S.info?.defaultDir || "", "프로젝트 폴더를 선택하거나 새로 만드세요");
	return r.cancelled ? null : r.path;
}

/** Folder picker rendered inside the page — only used when the OS folder dialog is unavailable. */
async function openInAppPicker(onPick, { title = "프로젝트 생성", okLabel = "이 폴더로 시작", create = true } = {}) {
	try {
		S.projects = await api.projects();
	} catch {}
	const def = S.info?.defaultDir;
	pickFolder({
		start: def || currentCwd() || S.cwd,
		recent: S.projects,
		shortcuts: def ? [{ label: "기본 폴더", path: def }] : [],
		create,
		title,
		okLabel,
		onPick,
	});
}

/** "프로젝트 생성" on the new-session screen: the Windows folder dialog creates or selects the work folder. */
async function changeProjectFolder() {
	if (S.info?.nativePicker) {
		try {
			const p = await browseNative(currentCwd());
			if (p) await startInFolder(p);
			return;
		} catch (err) {
			if (!err.unsupported) toast(err.message, "error");
		}
	}
	openInAppPicker(startInFolder);
}

async function openFolderPicker() {
	if (S.info?.nativePicker) {
		try {
			const p = await browseNative(S.cwd);
			if (p) {
				setCwd(p);
				if (!S.activeId) renderAll();
			}
			return;
		} catch (err) {
			if (!err.unsupported) return toast(err.message, "error");
		}
	}
	try {
		S.projects = await api.projects();
	} catch {}
	pickFolder({
		start: S.cwd,
		recent: S.projects,
		onPick: (p) => {
			setCwd(p);
			if (!S.activeId) renderAll();
		},
	});
}

// ---------- command palette ----------
function commandItems() {
	const active = !!S.activeId;
	const list = [
		{ label: "새 세션", icon: "plus", kbd: `${MOD}Shift+S`, run: () => newSession() },
		{ label: "프로젝트 폴더 열기", icon: "folder", run: () => openFolderPicker() },
		{ label: "계정 · 로그인", icon: "user", run: () => openAccount() },
		{ label: "설정", icon: "settings", run: () => openSettings() },
		{ label: S.update?.updateAvailable ? `pi 업데이트 (${S.update.latest} 사용 가능)` : "pi 업데이트 확인", icon: "refresh", run: () => openUpdate() },
		{ label: "홈으로", icon: "home", kbd: "Alt+0", run: () => goHome() },
		active && { label: "모델 선택", icon: "brain", run: () => openModelPicker() },
		active && (S.view.thinkingLevels || []).length > 1 && { label: "생각 수준", icon: "brain", run: () => openThinkingPicker() },
		active && { label: "변경 사항 패널 열기/닫기", icon: "review", kbd: `${MOD}Shift+E`, run: () => toggleReview() },
		active && { label: "컨텍스트 압축", icon: "refresh", run: () => compact() },
		active && { label: "이전 메시지에서 분기", icon: "branch", run: () => openForkPicker() },
		active && { label: "세션 이름 바꾸기", icon: "edit", run: () => promptRename() },
		active && { label: "세션 복제", icon: "copy", run: () => cloneSession() },
		active && { label: "HTML로 내보내기", icon: "file", run: () => exportHtml() },
		active && { label: "마지막 응답 복사", icon: "copy", run: () => copyLast() },
		active && { label: "세션 통계", icon: "clock", run: () => showStats() },
		active && { label: "pi 프로세스 재시작", icon: "refresh", run: () => restartSession() },
		active && { label: "세션 닫기", icon: "x", run: () => closeSession() },
		{ label: "테마 전환", icon: "moon", run: () => toggleTheme() },
		{ label: "도움말", icon: "command", run: () => showHelp() },
	];
	return list.filter(Boolean).map((c) => ({ ...c, group: "명령", value: c }));
}

async function openPalette(focusGroup) {
	const items = [];
	for (const l of S.live)
		items.push({ label: l.name || l.preview || "새 세션", sub: `열린 탭 · ${basename(l.cwd)}`, avatar: avatar(l.cwd), group: "열린 세션", value: { run: () => attach(l.id) }, current: l.id === S.activeId });
	const liveFiles = new Set(S.live.map((l) => l.sessionFile));
	let sessions = S.sessions;
	try {
		sessions = await api.sessions();
	} catch {}
	for (const s of sessions.slice(0, 200)) {
		if (liveFiles.has(s.path)) continue;
		items.push({
			label: s.name || s.firstMessage || "(빈 세션)",
			sub: `${basename(s.cwd)} · ${relTime(s.modified)} · 메시지 ${s.messageCount}개`,
			avatar: avatar(s.cwd),
			group: "세션",
			search: `${s.cwd} ${s.firstMessage ?? ""}`,
			value: { run: () => openDiskSession(s) },
		});
	}
	const cmds = commandItems();
	const ordered = focusGroup === "세션" ? [...items, ...cmds] : [...cmds, ...items];
	pickFromList({ title: "명령 팔레트", items: ordered, placeholder: "명령이나 세션 검색", palette: true, onPick: (v) => v.run() });
}

// ---------- review panel ----------
function reviewFiles(v = S.view) {
	const results = new Map();
	for (const m of v.messages) if (m.role === "toolResult") results.set(m.toolCallId, m);
	const files = new Map();
	for (const m of v.messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content) {
			if (b?.type !== "toolCall" || (b.name !== "edit" && b.name !== "write")) continue;
			const r = results.get(b.id);
			const p = b.arguments?.path;
			if (!r || r.isError || !p) continue;
			const entry = files.get(p) || { path: p, changes: [], add: 0, del: 0 };
			if (b.name === "edit") {
				const diff = r.details?.diff || "";
				const st = diffStats(diff);
				entry.changes.push({ kind: "edit", diff });
				entry.add += st.add;
				entry.del += st.del;
			} else {
				const content = String(b.arguments?.content ?? "");
				entry.changes.push({ kind: "write", content });
				entry.add += content.split("\n").length;
			}
			files.set(p, entry);
		}
	}
	return [...files.values()];
}

function toggleReview(force) {
	S.reviewOpen = force ?? !S.reviewOpen;
	store("reviewOpen", S.reviewOpen);
	renderActive();
}

function openReviewAt(p) {
	S.reviewExpanded.set(p, true);
	toggleReview(true);
	requestAnimationFrame(() => {
		const el = [...reviewEl.querySelectorAll(".review-file")].find((x) => x.dataset.path === p);
		if (el) {
			el.scrollIntoView({ block: "start", behavior: "smooth" });
			el.classList.add("flash");
			setTimeout(() => el.classList.remove("flash"), 1200);
		}
	});
}

function renderReview() {
	const show = !!S.activeId && S.reviewOpen;
	reviewEl.classList.toggle("hidden", !show);
	if (!show) return;
	const files = reviewFiles();
	const allOpen = files.length > 0 && files.every((f) => S.reviewExpanded.get(f.path) !== false);
	const resize = h("div.review-resize", {
		onpointerdown: (e) => {
			const startX = e.clientX;
			const startW = reviewEl.getBoundingClientRect().width;
			const move = (ev) => {
				const w = Math.max(320, Math.min(window.innerWidth * 0.7, startW + (startX - ev.clientX)));
				reviewEl.style.setProperty("--review-w", `${w}px`);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				store("reviewWidth", reviewEl.style.getPropertyValue("--review-w"));
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		},
	});
	setChildren(
		reviewEl,
		resize,
		h(
			"div.review-head",
			h("span", "세션 변경 사항"),
			files.length ? h("span.badge", String(files.length)) : null,
			h("span.spacer"),
			files.length
				? h(
						"button.btn.ghost",
						{
							type: "button",
							onclick: () => {
								for (const f of files) S.reviewExpanded.set(f.path, !allOpen);
								renderReview();
							},
						},
						icon(allOpen ? "chevronDown" : "chevron"),
						allOpen ? "모두 접기" : "모두 펼치기",
					)
				: null,
			h("button.icon-btn", { type: "button", title: "닫기", onclick: () => toggleReview(false) }, icon("x")),
		),
		h(
			"div.review-body",
			files.length
				? files.map((f) => {
						const open = S.reviewExpanded.get(f.path) !== false;
						const head = fileHead(f.path, { add: f.add, del: f.del });
						head.prepend(icon(open ? "chevronDown" : "chevron", "chev-static"));
						head.addEventListener("click", () => {
							S.reviewExpanded.set(f.path, !open);
							renderReview();
						});
						return h(
							`div.review-file${open ? ".open" : ""}`,
							{ dataset: { path: f.path } },
							head,
							open ? f.changes.map((c) => (c.kind === "edit" ? diffView(c.diff) : pre(c.content, "", extLang(f.path)))) : null,
						);
					})
				: h("div.empty", "이 세션에서 아직 바뀐 파일이 없습니다."),
		),
	);
}

// ---------- docked extension requests ----------
function syncDock() {
	const first = S.view.pendingUi[0];
	if (S.dock && (!first || S.dock.id !== first.id)) {
		S.dock.close();
		S.dock = null;
	}
	if (!first || S.dock) return;
	const id = S.activeId;
	const respond = (payload) => api.ui(id, { id: first.id, ...payload }).catch((err) => toast(err.message, "error"));
	if (first.method === "editor") {
		const handle = showExtensionDialog(first, respond);
		S.dock = { id: first.id, close: () => handle.dismiss() };
		return;
	}
	const host = composer.dockEl;
	let done = false;
	const answer = (payload) => {
		if (done) return;
		done = true;
		respond(payload);
	};
	let card;
	let sel = 0;
	const deadline = first.timeout ? first.receivedAt + first.timeout : null;
	const timerEl = deadline ? h("span.faint") : null;
	const tick = deadline
		? setInterval(() => {
				timerEl.textContent = `${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}초 후 기본값 적용`;
			}, 250)
		: null;
	if (first.method === "confirm") {
		card = h(
			"div.dock-card.warn.ext-dialog",
			{ tabindex: -1 },
			h("div.dock-title", icon("alert"), h("span", first.title || "확인 요청")),
			first.message ? h("div.dialog-message.muted", first.message) : null,
			h(
				"div.dock-actions",
				timerEl,
				h("button.btn", { type: "button", onclick: () => answer({ confirmed: false }) }, "거부", h("kbd", "Esc")),
				h("button.btn.primary", { type: "button", onclick: () => answer({ confirmed: true }) }, "허용", h("kbd", "Enter")),
			),
		);
		card.addEventListener("keydown", (e) => {
			if (e.target.tagName === "BUTTON" && e.key === "Enter") return;
			if (e.key === "Enter") {
				e.preventDefault();
				answer({ confirmed: true });
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				answer({ confirmed: false });
			}
		});
	} else if (first.method === "select") {
		const opts = first.options || [];
		const optsEl = h("div.dock-options");
		const draw = () =>
			optsEl.replaceChildren(
				...opts.map((o, i) =>
					h(`button.dock-option.list-item${i === sel ? ".sel" : ""}`, { type: "button", onclick: () => answer({ value: o }) }, h("kbd", String(i + 1)), h("span", o)),
				),
			);
		draw();
		card = h(
			"div.dock-card.ext-dialog",
			{ tabindex: -1 },
			h("div.dock-title", icon("command"), h("span", first.title || "선택")),
			optsEl,
			h("div.dock-actions", timerEl, h("button.btn.ghost", { type: "button", onclick: () => answer({ cancelled: true }) }, "건너뛰기", h("kbd", "Esc"))),
		);
		card.addEventListener("keydown", (e) => {
			const n = Number.parseInt(e.key, 10);
			if (n >= 1 && n <= opts.length) {
				e.preventDefault();
				answer({ value: opts[n - 1] });
			} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
				draw();
			} else if (e.key === "Enter" && e.target === card) {
				e.preventDefault();
				answer({ value: opts[sel] });
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				answer({ cancelled: true });
			}
		});
	} else {
		const input = h("input.input", { type: "text", placeholder: first.placeholder ?? "" });
		input.addEventListener("keydown", (e) => {
			if (e.isComposing) return;
			if (e.key === "Enter") {
				e.preventDefault();
				answer({ value: input.value });
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				answer({ cancelled: true });
			}
		});
		card = h(
			"div.dock-card.ext-dialog",
			h("div.dock-title", icon("edit"), h("span", first.title || "입력")),
			input,
			h(
				"div.dock-actions",
				timerEl,
				h("button.btn.ghost", { type: "button", onclick: () => answer({ cancelled: true }) }, "취소"),
				h("button.btn.primary", { type: "button", onclick: () => answer({ value: input.value }) }, "확인"),
			),
		);
		setTimeout(() => input.focus(), 0);
	}
	host.replaceChildren(card);
	host.classList.remove("hidden");
	if (first.method !== "input") setTimeout(() => card.focus(), 0);
	S.dock = {
		id: first.id,
		close: () => {
			clearInterval(tick);
			done = true;
			host.replaceChildren();
			host.classList.add("hidden");
			if (document.activeElement === document.body) composer.focus();
		},
	};
}

// ---------- event side effects ----------
function sideEffects(ev) {
	if (ev.type === "extension_ui_request" && ev.method === "notify") {
		toast(ev.message || "", ev.notifyType === "error" ? "error" : ev.notifyType === "warning" ? "warn" : "info");
	}
}

function notifyDesktop(title, body) {
	if (!S.notify || !document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
	try {
		const n = new Notification(title, { body, tag: `piweb-${S.activeId}` });
		n.onclick = () => {
			window.focus();
			n.close();
		};
	} catch {}
}

// ---------- rendering ----------
let rafPending = false;
function scheduleRender() {
	if (rafPending) return;
	rafPending = true;
	requestAnimationFrame(() => {
		rafPending = false;
		renderActive();
	});
}

function sessionTitle(v = S.view) {
	const s = v.state || {};
	if (s.sessionName) return s.sessionName;
	const first = v.messages.find((m) => m.role === "user");
	if (first) {
		const c = first.content;
		const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
		const body = splitAttachments(t).body;
		if (body.trim()) return truncate(body.replace(/\s+/g, " ").trim(), 80);
	}
	return "새 세션";
}

function tabTitle(l) {
	if (l.id === S.activeId && S.view.state) return sessionTitle();
	return l.name || l.preview || "새 세션";
}

function hideProject(p) {
	S.hiddenProjects.add(p.key);
	saveHiddenProjects();
	renderSidebar();
	toast(`"${basename(p.cwd)}" 프로젝트를 사이드바에서 숨겼습니다 (폴더와 대화 기록은 그대로입니다)`, "info", 7000, {
		label: "되돌리기",
		run: () => {
			S.hiddenProjects.delete(p.key);
			saveHiddenProjects();
			renderSidebar();
		},
	});
}

function sbSessionRow({ live, saved }, flat) {
	if (live) {
		const l = live;
		const status = l.id === S.activeId && S.view.state ? S.view.status : l.status;
		const busy = status === "running" || status === "compacting";
		const i = flat.indexOf(l);
		return h(
			`div.sb-item${l.id === S.activeId ? ".active" : ""}`,
			{
				title: `${tabTitle(l)}\n${l.cwd}${i >= 0 && i < 9 ? `\nAlt+${i + 1}` : ""}`,
				role: "button",
				tabindex: "0",
				"aria-current": l.id === S.activeId ? "page" : null,
				onclick: () => attach(l.id),
				onkeydown: kbdActivate(() => attach(l.id)),
			},
			busy ? h("span.spinner") : h(`span.dot.${status}`),
			h("span.sb-title", tabTitle(l)),
			h("button.sb-close", { type: "button", title: "세션 종료 (pi 프로세스 종료)", onclick: (e) => (e.stopPropagation(), closeSession(l.id)) }, icon("x")),
		);
	}
	const x = saved;
	const title = x.name || splitAttachments(x.firstMessage || "").body.trim() || "(빈 세션)";
	return h(
		"div.sb-item.saved",
		{ title: `${title}\n${x.cwd}`, role: "button", tabindex: "0", onclick: () => openDiskSession(x), onkeydown: kbdActivate(() => openDiskSession(x)) },
		h("span.sb-title", title),
		h("span.sb-time", relTime(x.modified)),
	);
}

function renderSidebar() {
	document.body.classList.toggle("sidebar-open", S.sidebar);
	const projects = sidebarProjects();
	const flat = visibleTabs();
	const activeCwd = S.activeId ? S.live.find((l) => l.id === S.activeId)?.cwd : S.cwd;
	const searching = !!S.sbFilter.trim();
	const rows = projects.map((p) => {
		const folded = !searching && S.collapsed.has(p.key);
		const showAll = searching || S.more.has(p.key);
		const savedShown = showAll ? p.saved : p.saved.slice(0, SB_LIMIT);
		const toggle = () => {
			folded ? S.collapsed.delete(p.key) : S.collapsed.add(p.key);
			store("sidebarCollapsed", [...S.collapsed]);
			renderSidebar();
		};
		const busyCount = p.live.filter((l) => l.status === "running" || l.status === "compacting").length;
		return h(
			"div.sb-group",
			h(
				`div.sb-group-head${projKey(activeCwd) === p.key ? ".current" : ""}`,
				{ title: p.cwd, role: "button", tabindex: "0", "aria-expanded": String(!folded), onclick: toggle, onkeydown: kbdActivate(toggle) },
				icon(folded ? "chevron" : "chevronDown"),
				avatar(p.cwd),
				h("span.sb-group-name", basename(p.cwd) || p.cwd),
				folded && p.live.length ? h("span.sb-count", busyCount ? h("span.spinner") : String(p.live.length)) : null,
				h("button.sb-act", { type: "button", title: `${basename(p.cwd)}에서 새 세션`, onclick: (e) => (e.stopPropagation(), newSession(p.cwd)) }, icon("plus")),
				p.live.length ? null : h("button.sb-act", { type: "button", title: "사이드바에서 숨기기", onclick: (e) => (e.stopPropagation(), hideProject(p)) }, icon("x")),
			),
			folded
				? null
				: [
						p.live.map((l) => sbSessionRow({ live: l }, flat)),
						savedShown.map((x) => sbSessionRow({ saved: x }, flat)),
						!showAll && p.saved.length > SB_LIMIT
							? h("button.sb-more", { type: "button", onclick: () => (S.more.add(p.key), renderSidebar()) }, `${p.saved.length - SB_LIMIT}개 더 보기`)
							: null,
						!p.live.length && !p.saved.length ? h("div.sb-empty", "아직 세션이 없습니다") : null,
					],
		);
	});
	const search = h("input.sb-search", {
		type: "search",
		placeholder: "세션·프로젝트 검색",
		"aria-label": "세션·프로젝트 검색",
		value: S.sbFilter,
		oninput: (e) => {
			S.sbFilter = e.target.value;
			const pos = e.target.selectionStart;
			renderSidebar();
			const el = sidebar.querySelector(".sb-search");
			el?.focus();
			el?.setSelectionRange(pos, pos);
		},
	});
	setChildren(
		sidebar,
		h(
			"div.sb-top",
			h("button.sb-new", { type: "button", title: `새 세션 (${MOD}Shift+S)`, onclick: () => newSession() }, icon("plus"), h("span", "새 세션")),
			h(`button.sb-home${S.activeId ? "" : ".active"}`, { type: "button", title: "홈 (Alt+0)", onclick: () => (goHome(), NARROW.matches && setSidebar(false)) }, icon("home"), h("span", "홈")),
			search,
		),
		h(
			"div.sb-label",
			h("span", "프로젝트"),
			h("button.sb-act.always", { type: "button", title: "프로젝트 폴더 열기", onclick: () => openFolderPicker() }, icon("folder"), h("span", "폴더 추가")),
		),
		h("div.sb-list", rows.length ? rows : h("div.sb-empty", searching ? "검색 결과가 없습니다" : "프로젝트가 없습니다. 폴더를 추가해 보세요.")),
	);
	sidebarBackdrop.hidden = !(S.sidebar && NARROW.matches);
	sidebar.querySelector(".sb-item.active")?.scrollIntoView({ block: "nearest" });
}

function renderTitlebar() {
	renderSidebar();
	setChildren(
		titlebar,
		h("button.icon-btn.tb-side", { type: "button", title: `사이드바 ${S.sidebar ? "접기" : "열기"} (${MOD}B)`, "aria-expanded": String(S.sidebar), onclick: () => setSidebar(!S.sidebar) }, icon("sidebar")),
		h(`button.tb-home${S.activeId ? "" : ".active"}`, { type: "button", title: "홈 (Alt+0)", onclick: () => goHome() }, h("span.tb-mark", "π")),
		h(
			"div.tb-right",
			h("button.tb-kbd", { type: "button", title: "명령 팔레트", onclick: () => openPalette() }, h("span", "명령"), h("kbd", `${MOD}K`)),
			h(
				"button.tb-status",
				{ type: "button", title: `${S.info?.pi?.entry || S.info?.piError || ""}${S.update?.current ? `
버전 ${S.update.current} (눌러서 업데이트 사항 보기)` : ""}`, onclick: () => openUpdate() },
				h(`span.tb-dot${S.serverUp && S.info?.pi ? "" : ".off"}`),
				h("span.tb-label", S.serverUp ? (S.update?.current ? `pi ${S.update.current}` : "pi") : "연결 끊김"),
			),
			S.update?.updateAvailable || S.update?.job?.state === "running"
				? h(
						"button.tb-update",
						{ type: "button", title: S.update.job?.state === "running" ? "pi 업데이트 진행 중" : `pi ${S.update.current} → ${S.update.latest}`, onclick: () => openUpdate() },
						S.update.job?.state === "running" ? h("span.spinner") : icon("refresh"),
						h("span.tb-update-label", S.update.job?.state === "running" ? "업데이트 중" : "pi 업데이트"),
					)
				: null,
			h("button.icon-btn", { type: "button", title: "계정 · 로그인", onclick: () => openAccount() }, icon("user")),
			h("button.icon-btn", { type: "button", title: "설정", onclick: () => openSettings() }, icon("settings")),
			h(
				`button.icon-btn${S.notify ? ".on" : ""}`,
				{
					type: "button",
					title: S.notify ? "작업 완료 알림 끄기" : "작업 완료 알림 켜기",
					onclick: async () => {
						if (!S.notify && "Notification" in window && Notification.permission !== "granted") {
							const p = await Notification.requestPermission();
							if (p !== "granted") return toast("브라우저 알림이 허용되지 않았습니다", "warn");
						}
						S.notify = !S.notify;
						store("notify", S.notify);
						toast(S.notify ? "다른 창에 있을 때 작업 완료를 알립니다" : "알림을 껐습니다");
						renderTitlebar();
					},
				},
				icon("bell"),
			),
			h("button.icon-btn", { type: "button", title: "테마 전환", onclick: () => toggleTheme() }, icon("moon")),
		),
	);
}

function renderHome() {
	const filter = S.filter.toLowerCase();
	const sessions = S.sessions.filter((s) => !filter || `${s.name ?? ""} ${s.firstMessage ?? ""}`.toLowerCase().includes(filter));
	const liveFiles = new Map(S.live.filter((l) => l.sessionFile).map((l) => [l.sessionFile, l]));
	const projects = [...S.projects];
	if (S.cwd && !projects.some((p) => p.cwd === S.cwd)) projects.unshift({ cwd: S.cwd, count: 0, lastModified: 0 });
	const groups = [];
	const now = Date.now();
	for (const s of sessions) {
		const age = (now - s.modified) / 86400000;
		const g = age < 1 ? "오늘" : age < 7 ? "이번 주" : age < 31 ? "이번 달" : "이전";
		if (!groups.length || groups[groups.length - 1].name !== g) groups.push({ name: g, items: [] });
		groups[groups.length - 1].items.push(s);
	}
	const search = h("input.input", {
		type: "search",
		placeholder: "세션 검색",
		value: S.filter,
		oninput: (e) => {
			S.filter = e.target.value;
			const pos = e.target.selectionStart;
			renderHome();
			const el = viewHome.querySelector(".session-panel input");
			el?.focus();
			el?.setSelectionRange(pos, pos);
		},
	});
	setChildren(
		viewHome,
		h(
			"div.home",
			h(
				"div.home-inner",
				h(
					"div.home-head",
					S.cwd ? avatar(S.cwd, true) : null,
					h("div", h("h1", basename(S.cwd) || "pi web"), h("div.home-path.mono", S.cwd || "프로젝트 폴더를 여세요")),
					h("span.spacer"),
					h("button.btn.lg.project-btn", { type: "button", onclick: () => openFolderPicker() }, icon("folder"), "폴더 열기"),
					h("button.btn.lg.primary.new-btn", { type: "button", disabled: !S.cwd, onclick: () => newSession(S.cwd) }, icon("plus"), "새 세션"),
				),
				h(
					"div.project-col",
					h("div.home-section-title", "프로젝트"),
					h(
						"div.project-list",
						projects.length
							? projects.map((p) =>
									h(
										`button.project-item${p.cwd === S.cwd ? ".active" : ""}`,
										{ type: "button", title: p.cwd, onclick: () => setCwd(p.cwd) },
										avatar(p.cwd),
										h("span.p-name", basename(p.cwd)),
										h("span.p-count", p.count ? String(p.count) : ""),
										h("span.p-path.mono", p.cwd),
									),
								)
							: h("div.empty", "아직 프로젝트가 없습니다"),
					),
				),
				h(
					"div.session-panel",
					h("div.session-panel-head", search),
					h(
						"div.session-list",
						groups.length
							? groups.map((g) => [
									h("div.session-group", g.name),
									g.items.map((s) => {
										const live = liveFiles.get(s.path);
										return h(
											"div.session-row.side-item",
											{
												title: s.firstMessage || "",
												role: "button",
												tabindex: "0",
												onclick: () => (live ? attach(live.id) : openDiskSession(s)),
												onkeydown: kbdActivate(() => (live ? attach(live.id) : openDiskSession(s))),
											},
											live ? h(`span.dot.${live.status}`) : null,
											h("span.s-title", s.name || s.firstMessage || "(빈 세션)"),
											h("span.s-meta", `${relTime(s.modified)} · ${s.messageCount}`),
										);
									}),
								])
							: h("div.empty", S.filter ? "검색 결과가 없습니다" : "이 프로젝트에 저장된 세션이 없습니다. 새 세션을 시작해 보세요."),
					),
				),
				h(
					"div.home-foot",
					S.info?.pi ? h("span", { title: S.info.pi.entry }, `pi${S.update?.current ? ` ${S.update.current}` : ""}: ${truncate(S.info.pi.entry, 70)}`, S.update?.current ? h("button.link-btn", { type: "button", onclick: () => openUpdate() }, S.update.updateAvailable ? ` · ${S.update.latest} 업데이트 가능` : " · 업데이트 사항 보기") : null) : h("span.err", S.info?.piError || "pi를 찾지 못했습니다"),
					S.info?.sessionsDir ? h("span", `세션 폴더: ${S.info.sessionsDir}`) : null,
					h("span", `${MOD}K 명령 팔레트`),
				),
			),
		),
	);
}

function renderSessionHead() {
	const v = S.view;
	const st = v.stats;
	const files = reviewFiles();
	const pct = st?.contextUsage?.percent;
	const ringColor = pct >= 85 ? "var(--danger-fg)" : pct >= 65 ? "var(--warn-fg)" : "var(--text-muted)";
	setChildren(
		sessionHead,
		h("button.sh-title.session-title", { type: "button", title: "이름 바꾸기", onclick: () => promptRename() }, sessionTitle()),
		h("span.sh-path.mono", { title: currentCwd() }, currentCwd() || ""),
		h(`span.status-pill.${v.status}`, v.status === "running" || v.status === "compacting" ? h("span.spinner") : null, STATUS_LABEL[v.status] || v.status),
		h("span.spacer"),
		st
			? h(
					"button.ctx-meter",
					{ type: "button", onclick: () => showStats(), title: `컨텍스트 ${fmtTokens(st.contextUsage?.tokens)} / ${fmtTokens(st.contextUsage?.contextWindow)} · 총 ${fmtTokens(st.tokens?.total)} 토큰` },
					h("span.ring", { style: { "--p": String(Math.min(100, pct ?? 0)), "--ring-color": ringColor } }),
					h("span", `${pct ?? "–"}%`),
					st.cost ? h("span.ctx-cost.faint", fmtCost(st.cost)) : null,
				)
			: null,
		h(
			`button.review-toggle${S.reviewOpen ? ".on" : ""}`,
			{ type: "button", title: `변경 사항 (${MOD}Shift+E)`, onclick: () => toggleReview() },
			icon("review"),
			h("span.rt-label", "변경 사항"),
			files.length ? h("span.badge", String(files.length)) : null,
		),
		h("button.icon-btn", { type: "button", title: "메뉴", onclick: (e) => openSessionMenu(e.currentTarget) }, icon("more")),
	);
}

function openMenu(anchor, items, { above = false } = {}) {
	document.querySelector(".menu")?.remove();
	const menu = h(
		"div.menu",
		items.map((it) =>
			it === "-"
				? h("div.menu-sep")
				: h(
						`button.menu-item${it.danger ? ".danger" : ""}`,
						{
							type: "button",
							disabled: it.disabled,
							onclick: () => {
								menu.remove();
								it.run();
							},
						},
						it.checked ? icon("check") : it.icon ? icon(it.icon) : h("span", { style: { width: "16px" } }),
						h("span", it.label),
						it.kbd ? h("kbd", it.kbd) : it.hint ? h("span.faint", { style: { marginLeft: "auto", fontSize: "12px" } }, it.hint) : null,
					),
		),
	);
	document.body.append(menu);
	const r = anchor.getBoundingClientRect();
	if (above) {
		menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
		menu.style.left = `${Math.max(8, r.left)}px`;
	} else {
		menu.style.top = `${r.bottom + 6}px`;
		menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
	}
	setTimeout(() => {
		const off = (e) => {
			if (!menu.contains(e.target)) {
				menu.remove();
				document.removeEventListener("mousedown", off);
			}
		};
		document.addEventListener("mousedown", off);
	}, 0);
}

function openSessionMenu(anchor) {
	const v = S.view;
	openMenu(anchor, [
		{ label: "이름 바꾸기", icon: "edit", run: promptRename },
		{ label: "컨텍스트 압축", icon: "refresh", disabled: v.running, run: () => compact() },
		{ label: "이전 메시지에서 분기", icon: "branch", disabled: v.running, run: openForkPicker },
		{ label: "세션 복제", icon: "copy", disabled: v.running, run: cloneSession },
		"-",
		{ label: "HTML로 내보내기", icon: "file", run: exportHtml },
		{ label: "마지막 응답 복사", icon: "copy", run: copyLast },
		{ label: "세션 통계", icon: "clock", run: showStats },
		{
			label: v.state?.autoCompactionEnabled === false ? "자동 압축 켜기" : "자동 압축 끄기",
			icon: "refresh",
			run: () => {
				const enable = v.state?.autoCompactionEnabled === false;
				cmd({ type: "set_auto_compaction", enabled: enable })
					.then(() => toast(enable ? "자동 압축을 켰습니다" : "자동 압축을 껐습니다"))
					.catch((err) => toast(err.message, "error"));
			},
		},
		"-",
		{ label: "계정 · 로그인", icon: "user", run: openAccount },
		{ label: "설정", icon: "settings", run: openSettings },
		"-",
		{ label: "pi 프로세스 재시작", icon: "refresh", run: restartSession },
		{ label: "홈으로 (세션은 계속 실행)", icon: "home", run: () => goHome() },
		{ label: "세션 종료 (pi 프로세스 종료)", icon: "x", danger: true, run: () => closeSession() },
	]);
}

function openAccount() {
	openAccountModal({ onChanged: () => api.info().then((i) => ((S.info = i), renderBanner())).catch(() => {}) });
}

function openUpdate() {
	openUpdateModal({
		onStatus: (st) => {
			const was = S.update;
			S.update = st;
			if (was?.updateAvailable !== st.updateAvailable || was?.current !== st.current || was?.job?.state !== st.job?.state) {
				renderTitlebar();
				if (!S.activeId) renderHome();
			}
		},
	});
}

/** Quiet background check; announces a new pi version once per version. */
async function checkPiUpdate() {
	try {
		const st = await api.piUpdate(false);
		S.update = st;
		renderTitlebar();
		if (!S.activeId) renderHome();
		if (st.updateAvailable && store("updateSeen") !== st.latest) {
			store("updateSeen", st.latest);
			toast(`pi ${st.latest} 업데이트가 있습니다 (현재 ${st.current})`, "info", 12000, { label: "자세히", run: () => openUpdate() });
		}
	} catch {}
}

function openSettings() {
	openSettingsModal({
		sessionId: () => S.activeId,
		command: (c) => cmd(c),
		restart: () => restartSession(),
	});
}

async function restartSession() {
	if (!S.activeId) return;
	try {
		await api.restart(S.activeId);
		toast("pi 프로세스를 다시 시작했습니다");
	} catch (err) {
		toast(err.message, "error");
	}
}

function renderNewSession() {
	const v = S.view;
	const show = !!S.activeId && !v.exited && !v.messages.some((m) => m.role !== "system" && m.role !== "_notice") && !v.running && !v.bash;
	newSessionEl.classList.toggle("hidden", !show);
	transcriptEl.classList.toggle("hidden", show && !v.messages.length);
	if (!show) return;
	const cwd = currentCwd() || "";
	const [dir, name] = splitPath(cwd);
	const branch = S.branches.get(cwd);
	const last = S.sessions[0];
	setChildren(
		newSessionEl,
		h("h2", "새 세션"),
		h("div.ns-row", icon("folder"), h("span.mono", { title: cwd }, dir, h("b", name))),
		h(
			"div.ns-actions",
			h("button.btn.ns-create", { type: "button", title: "작업 폴더를 새로 만들거나 다른 폴더로 지정합니다", onclick: () => changeProjectFolder() }, icon("plus"), "프로젝트 생성"),
			S.info?.defaultDir && cwd !== S.info.defaultDir ? h("button.btn.ns-default", { type: "button", title: S.info.defaultDir, onclick: () => startInFolder(S.info.defaultDir) }, icon("folder"), "기본 폴더로") : null,
		),
		branch ? h("div.ns-row", icon("git"), h("span", "브랜치 "), h("b", branch)) : null,
		last ? h("div.ns-row", icon("clock"), h("span", "마지막 세션 "), h("b", relTime(last.modified))) : null,
		h("div.ns-tips", h("span", h("code", "/"), " 명령"), h("span", h("code", "@"), " 파일"), h("span", h("code", "!"), " 셸"), h("span", h("kbd", `${MOD}K`), " 팔레트")),
	);
	loadBranch(cwd);
}

function renderBanner() {
	let msg = null;
	if (S.info?.piError) msg = [icon("alert"), h("span", S.info.piError)];
	else if (S.activeId && S.view.state && !S.view.state.model && !S.view.exited)
		msg = [icon("alert"), h("span", "선택된 모델이 없습니다. 모델 공급자에 로그인하거나 API 키를 설정하세요."), h("button.btn.sm", { type: "button", onclick: () => openAccount() }, icon("user"), "로그인")];
	else if (!S.serverUp) msg = [icon("alert"), h("span", "서버 연결이 끊겼습니다. 다시 연결하는 중…")];
	bannerEl.classList.toggle("hidden", !msg);
	if (msg) bannerEl.replaceChildren(...msg);
}

function renderComposerControls() {
	const v = S.view;
	const s = v.state || {};
	const levels = v.thinkingLevels || [];
	composer.setControls({
		model: s.model ? s.model.name || s.model.id : v.state ? "모델 없음" : "…",
		thinking: THINKING_LABEL[s.thinkingLevel] || s.thinkingLevel || "",
		showThinking: levels.length > 1,
	});
}

function renderActive() {
	const v = S.view;
	const inSession = !!S.activeId;
	viewHome.classList.toggle("hidden", inSession);
	viewSession.classList.toggle("hidden", !inSession);
	if (!inSession) {
		document.title = "pi web";
		updateJump();
		renderTitlebar();
		return;
	}
	renderSessionHead();
	renderNewSession();
	transcript.render(v, scroller);
	updateJump();
	renderReview();
	composer.setMeta(v);
	composer.syncRunning(isRunning());
	renderComposerControls();
	renderBanner();
	syncDock();
	if (v.editorText && v.editorText.n !== S.editorTextN) {
		S.editorTextN = v.editorText.n;
		composer.value = v.editorText.text;
		composer.focus();
	}
	const st = v.status;
	if (st !== S.prevStatus) {
		if (S.prevStatus === "running" && st === "idle") notifyDesktop("pi 작업 완료", sessionTitle());
		if (st === "waiting") notifyDesktop("pi가 응답을 기다립니다", v.pendingUi[0]?.title || sessionTitle());
		S.prevStatus = st;
		renderTitlebar();
	}
	const mark = st === "running" || st === "compacting" ? "● " : st === "waiting" ? "❗ " : "";
	document.title = `${mark}${sessionTitle()} · pi`;
}

function renderAll() {
	renderTitlebar();
	if (!S.activeId) renderHome();
	renderActive();
}

// ---------- data refresh ----------
const refreshSessions = debounce(async () => {
	if (!S.cwd) return;
	try {
		const [sessions, projects, all] = await Promise.all([api.sessions(S.cwd), api.projects(), api.allSessions()]);
		S.sessions = sessions;
		S.projects = projects;
		S.all = all;
	} catch {}
	renderSidebar();
	if (!S.activeId) renderHome();
	else renderNewSession();
}, 250);

// tick elapsed time while running
setInterval(() => {
	if (S.activeId && (S.view.status === "running" || S.view.status === "compacting")) scheduleRender();
}, 1000);

// ---------- global handlers ----------
document.addEventListener("keydown", (e) => {
	if (e.isComposing) return;
	const mod = IS_MAC ? e.metaKey : e.ctrlKey;
	const key = e.key.toLowerCase();
	if (mod && !e.shiftKey && key === "k") {
		e.preventDefault();
		if (!modalOpen()) openPalette();
		return;
	}
	if (mod && e.shiftKey && key === "s") {
		e.preventDefault();
		newSession();
		return;
	}
	if (mod && e.shiftKey && key === "e") {
		e.preventDefault();
		if (S.activeId) toggleReview();
		return;
	}
	if (mod && !e.shiftKey && key === "b") {
		e.preventDefault();
		setSidebar(!S.sidebar);
		return;
	}
	if (mod && !e.shiftKey && key === "l") {
		e.preventDefault();
		if (S.activeId) composer.focus();
		return;
	}
	if (e.altKey && !mod && /^[0-9]$/.test(e.key)) {
		e.preventDefault();
		const n = Number(e.key);
		if (n === 0) goHome();
		else if (visibleTabs()[n - 1]) attach(visibleTabs()[n - 1].id);
		return;
	}
	if (e.key === "Escape") {
		if (document.querySelector(".menu")) {
			document.querySelector(".menu").remove();
			return;
		}
		if (modalOpen()) {
			closeTopModal();
			e.preventDefault();
			return;
		}
		if (isRunning() || S.view.bash) {
			e.preventDefault();
			abort();
		}
	}
});

transcriptEl.addEventListener("click", (e) => {
	if (e.target.closest?.("[data-action=restart]")) restartSession();
});

window.addEventListener("hashchange", () => {
	const m = /^#\/s\/([\w-]+)/.exec(location.hash);
	if (m && m[1] !== S.activeId && S.live.some((l) => l.id === m[1])) attach(m[1]);
});

// ---------- boot ----------
async function boot() {
	const w = store("reviewWidth");
	if (w) reviewEl.style.setProperty("--review-w", w);
	try {
		S.info = await api.info();
	} catch (err) {
		document.body.prepend(h("div.banner", `서버에 연결할 수 없습니다: ${err.message}`));
		return;
	}
	try {
		S.projects = await api.projects();
	} catch {}
	// Every launch starts in --cwd if given, otherwise in the default work folder (~/Documents/pi).
	S.cwd = S.info.defaultCwd || S.info.defaultDir || store("cwd") || S.projects[0]?.cwd || S.info.home;
	store("cwd", S.cwd);
	loadBranch(S.cwd);
	try {
		S.live = await api.live();
	} catch {}
	try {
		S.sessions = await api.sessions(S.cwd);
		S.all = await api.allSessions();
	} catch {}
	openGlobalStream({
		onLive: (list) => {
			const prev = new Map(S.live.map((l) => [l.id, l.status]));
			S.live = list;
			// Tell the user when a session they are not looking at finished or needs them.
			for (const l of list) {
				if (l.id === S.activeId) continue;
				const was = prev.get(l.id);
				const wasBusy = was === "running" || was === "compacting";
				if (wasBusy && l.status === "idle") {
					toast(`작업 완료: ${truncate(tabTitle(l), 40)}`, "info", 8000, { label: "열기", run: () => attach(l.id) });
					notifyDesktop("pi 작업 완료", tabTitle(l));
				} else if (was !== "waiting" && l.status === "waiting") {
					toast(`세션이 응답을 기다립니다: ${truncate(tabTitle(l), 40)}`, "warn", 10000, { label: "열기", run: () => attach(l.id) });
					notifyDesktop("pi가 응답을 기다립니다", tabTitle(l));
				}
			}
			if (S.activeId && !list.some((l) => l.id === S.activeId)) {
				S.activeId = null;
				closeStream();
				goHome();
				return;
			}
			renderTitlebar();
			if (!S.activeId) renderHome();
		},
		onSessions: () => refreshSessions(),
		onState: (ok) => {
			if (ok !== S.serverUp) {
				S.serverUp = ok;
				renderTitlebar();
				renderBanner();
				if (ok) refreshSessions();
			}
		},
	});
	const m = /^#\/s\/([\w-]+)/.exec(location.hash);
	if (m && S.live.some((l) => l.id === m[1])) await attach(m[1]);
	else renderAll();
	checkPiUpdate();
	setInterval(checkPiUpdate, 6 * 60 * 60_000);
}

boot();

// Lets Chrome offer "install app" (needs localhost or https).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
