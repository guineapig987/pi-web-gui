// "pi 업데이트" dialog: shows installed vs. latest version and runs `pi update` on the gateway machine.
import { api } from "./api.js";
import { h, icon } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { openModal } from "./modals.js";

/** @param onStatus(status) called whenever fresh status arrives (the app uses it for the title bar badge) */
export function openUpdateModal({ onStatus }) {
	let timer = null;
	let closed = false;
	let st = null;
	let busy = false;
	const summary = h("div.upd-summary");
	const versions = h("div.upd-versions");
	const notesTitle = h("div.upd-notes-title.hidden");
	const notes = h("div.upd-notes.hidden");
	let notesKey = "";
	const msg = h("div.upd-msg.hidden");
	const log = h("pre.tool-pre.upd-log.hidden");
	const checkBtn = h("button.btn", { type: "button", onclick: () => load(true) }, icon("refresh"), "다시 확인");
	const runBtn = h("button.btn.primary", { type: "button", onclick: () => run() }, "지금 업데이트");
	const modal = openModal({
		title: "pi 업데이트",
		body: [summary, versions, msg, notesTitle, notes, log],
		actions: [checkBtn, runBtn],
		onClose: () => {
			closed = true;
			clearInterval(timer);
		},
	});

	function say(text, kind = "error") {
		msg.textContent = text || "";
		msg.className = `upd-msg ${kind}${text ? "" : " hidden"}`;
	}

	function draw() {
		if (closed || !st) return;
		const job = st.job || {};
		const running = job.state === "running";
		let line;
		if (running) line = "pi를 업데이트하는 중입니다…";
		else if (job.state === "done" && !st.updateAvailable) line = `업데이트가 끝났습니다. 현재 버전 ${st.current || "?"}`;
		else if (st.updateAvailable) line = `새 버전이 있습니다: ${st.current || "?"} → ${st.latest}`;
		else if (st.latest) line = `최신 버전입니다 (현재 ${st.current || "?"})`;
		else line = st.current ? `현재 버전 ${st.current}` : "설치된 pi 버전을 확인하지 못했습니다";
		summary.replaceChildren(h("strong", line));
		const row = (label, value, cls = "") => h("div.upd-ver", h("span.upd-ver-label", label), h(`span.upd-ver-value${cls}`, value));
		versions.replaceChildren(
			row("현재 버전", st.current || "알 수 없음"),
			row("최신 버전", st.latest || (st.error ? "확인 실패" : "…"), st.updateAvailable ? ".new" : ""),
		);
		loadNotes();
		if (running) say("");
		else if (job.state === "error") say(job.error || "업데이트에 실패했습니다");
		else if (job.state === "done") {
			const r = job.restarted;
			say(
				st.updateAvailable
					? "업데이트 명령은 끝났지만 아직 새 버전이 아닙니다. pi를 다른 방법(예: 패키지 관리자)으로 설치했다면 그 방법으로 업데이트하세요."
					: r?.restarted
						? `대기 중이던 세션 ${r.restarted}개를 다시 시작해 새 버전을 적용했습니다.${r.skipped ? ` 작업 중이던 ${r.skipped}개는 끝난 뒤 'pi 프로세스 재시작'으로 적용하세요.` : ""}`
						: "새로 여는 세션부터 새 버전이 적용됩니다.",
				st.updateAvailable ? "warn" : "ok",
			);
		} else if (st.error) say(st.error, "warn");
		else if (st.disabled) say("온라인 버전 확인이 꺼져 있습니다 (PI_WEB_NO_UPDATE_CHECK).", "warn");
		else if (st.updateAvailable) say("열려 있는 세션이 있으면 파일이 사용 중이라 실패할 수 있습니다. 작업 중인 세션이 있으면 시작되지 않습니다.", "info");
		else say("");
		const text = (job.log || "").trim();
		log.textContent = text;
		log.classList.toggle("hidden", !text);
		log.scrollTop = log.scrollHeight;
		runBtn.classList.toggle("hidden", !(st.updateAvailable || running) || !st.canRun);
		runBtn.disabled = running || busy;
		runBtn.textContent = running ? "업데이트 중…" : "지금 업데이트";
		checkBtn.disabled = running;
		clearInterval(timer);
		if (running) timer = setInterval(() => load(false), 1000);
	}

	/** Release notes: what an update brings, or what the installed version contains. */
	async function loadNotes() {
		if (!st) return;
		const key = `${st.current}>${st.latest}>${st.updateAvailable}`;
		if (key === notesKey) return;
		notesKey = key;
		try {
			const d = await api.piChangelog();
			if (closed || notesKey !== key) return;
			notesTitle.textContent = d.entries.length ? (d.forCurrent ? `이 버전(${st.current})의 변경 사항` : `업데이트 사항 (${d.entries.length}개 버전)`) : "";
			notesTitle.classList.toggle("hidden", !d.entries.length);
			notes.replaceChildren(
				...(d.entries.length
					? d.entries.map((e, i) => h("details.upd-entry", { open: i === 0 }, h("summary", h("strong", e.version), e.date ? h("span.faint", ` · ${e.date}`) : null), h("div.md", { html: renderMarkdown(e.markdown) })))
					: [h("div.muted", d.error || "변경 내역을 찾지 못했습니다")]),
			);
			notes.classList.remove("hidden");
		} catch (err) {
			notesKey = "";
			notes.replaceChildren(h("div.muted", `변경 내역을 불러오지 못했습니다: ${err.message}`));
			notes.classList.remove("hidden");
		}
	}

	async function load(refresh) {
		try {
			st = await api.piUpdate(refresh);
			onStatus?.(st);
		} catch (err) {
			say(err.message);
			return;
		}
		draw();
	}

	async function run() {
		busy = true;
		say("");
		try {
			st = await api.piUpdateStart(false);
			onStatus?.(st);
		} catch (err) {
			say(err.message);
		}
		busy = false;
		draw();
	}

	summary.textContent = "버전을 확인하는 중…";
	load(true);
	return modal;
}
