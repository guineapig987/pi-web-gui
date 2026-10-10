// Prompt composer: auto-growing textarea, slash-command and @file autocomplete, image attachments,
// input history, and running-state controls (steer / follow-up / stop).
import { api } from "./api.js";
import { h, icon } from "./dom.js";
import { debounce, fileToImageContent, fmtBytes, store, stripAnsi, truncate } from "./util.js";

const HISTORY_MAX = 200;
const PLACEHOLDER = '무엇이든 물어보세요… "이 함수에 테스트를 추가해 줘"';

export class Composer {
	/**
	 * @param host element
	 * @param o {getContext():{running, cwd, commands, modelInput}, onSubmit({text, images, mode}), onAbort(), onClearQueue()}
	 */
	constructor(host, o) {
		this.o = o;
		this.images = [];
		this.files = []; // uploaded (non-image) attachments: {name, size, path, uploading, error}
		this.history = store("history") || [];
		this.histIdx = -1;
		this.histDraft = "";
		this.popup = null; // {kind, items, sel, start, end}
		this.popupReq = 0;

		this.textarea = h("textarea.composer-input", {
			rows: 2,
			placeholder: PLACEHOLDER,
			spellcheck: false,
		});
		this.attachRow = h("div.attach-row.hidden");
		this.fileInput = h("input", { type: "file", multiple: true, style: { display: "none" } });
		this.sendBtn = h("button.btn.contrast.send-btn", { type: "button", title: "보내기 (Enter)" }, icon("arrowUp"));
		this.stopBtn = h("button.btn.contrast.stop-btn", { type: "button", title: "중지 (Esc)" }, icon("stopFill"));
		this.modelBtn = h("button.cb-select.model-btn", { type: "button", title: "모델 선택", onclick: () => this.o.onModelClick?.() }, h("span", "…"), icon("chevronDown"));
		this.thinkingBtn = h("button.cb-select.muted-select.thinking-select", { type: "button", title: "생각 수준", onclick: (e) => this.o.onThinkingClick?.(e.currentTarget) }, h("span", ""), icon("chevronDown"));
		this.modeHint = h("span.composer-hint");
		this.popupEl = h("div.popup.hidden");
		this.dockEl = h("div.dock.hidden");
		this.queueEl = h("div.queue-bar.hidden");
		this.aboveEl = h("div.widgets.above");
		this.belowEl = h("div.status-line");
		this.box = h(
			"div.composer-box",
			this.attachRow,
			this.textarea,
			h(
				"div.composer-bar",
				this.modelBtn,
				this.thinkingBtn,
				this.modeHint,
				h("span.spacer"),
				h("button.icon-btn", { type: "button", title: "파일 첨부 (이미지 포함, 끌어다 놓기·붙여넣기도 가능)", onclick: () => this.fileInput.click() }, icon("clip")),
				this.stopBtn,
				this.sendBtn,
			),
		);
		this.root = h("div.composer", this.dockEl, h("div.dock", this.queueEl, this.aboveEl), h("div.composer-wrap", this.popupEl, this.box), this.belowEl, this.fileInput);
		host.append(this.root);

		this.textarea.addEventListener("input", () => {
			this.autosize();
			this.updatePopup();
			if (this.running) this.syncRunning(true);
		});
		this.textarea.addEventListener("keydown", (e) => this.onKey(e));
		this.textarea.addEventListener("click", () => this.updatePopup());
		this.textarea.addEventListener("blur", () => setTimeout(() => this.closePopup(), 150));
		this.textarea.addEventListener("paste", (e) => this.onPaste(e));
		this.sendBtn.addEventListener("click", () => this.submit(this.o.getContext().running ? "steer" : "prompt"));
		this.stopBtn.addEventListener("click", () => this.o.onAbort());
		this.fileInput.addEventListener("change", async () => {
			const picked = [...this.fileInput.files];
			this.fileInput.value = "";
			for (const f of picked) await this.addAttachment(f);
		});
		this.root.addEventListener("dragover", (e) => {
			if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === "file")) {
				e.preventDefault();
				this.box.classList.add("drag");
			}
		});
		this.root.addEventListener("dragleave", () => this.box.classList.remove("drag"));
		this.root.addEventListener("drop", async (e) => {
			this.box.classList.remove("drag");
			const files = [...(e.dataTransfer?.files || [])];
			if (files.length) {
				e.preventDefault();
				for (const f of files) await this.addAttachment(f);
			}
		});
		this.fetchFiles = debounce((q, start, end, reqId) => this.loadFiles(q, start, end, reqId), 120);
		this.syncRunning(false);
	}

	focus() {
		this.textarea.focus();
	}

	get value() {
		return this.textarea.value;
	}

	set value(v) {
		this.textarea.value = v;
		this.autosize();
	}

	setDraft(d) {
		this.value = d?.text ?? "";
		this.images = d?.images ? [...d.images] : [];
		this.files = d?.files ? d.files.filter((f) => f.path) : [];
		this.drawAttachments();
	}

	getDraft() {
		return { text: this.textarea.value, images: [...this.images], files: this.files.filter((f) => f.path) };
	}

	autosize() {
		const ta = this.textarea;
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
	}

	syncRunning(running) {
		this.stopBtn.classList.toggle("hidden", !running);
		this.sendBtn.classList.toggle("hidden", running && !this.textarea.value.trim() && !this.images.length && !this.files.length);
		this.sendBtn.title = running ? "조향 메시지로 보내기 (Enter)" : "보내기 (Enter)";
		this.modeHint.textContent = running ? "Enter 지금 끼어들기 · Ctrl+Enter 끝난 뒤 보내기" : "";
		this.textarea.placeholder = running ? "다음 지시를 미리 입력하세요…" : PLACEHOLDER;
		this.running = running;
	}

	/** Model / thinking labels in the bottom bar. */
	setControls({ model, thinking, showThinking }) {
		this.modelBtn.firstChild.textContent = model;
		this.thinkingBtn.classList.toggle("hidden", !showThinking);
		this.thinkingBtn.firstChild.textContent = thinking;
	}

	/** Queue chips, extension widgets and status texts from the view. */
	setMeta(view) {
		const q = view?.queue || { steering: [], followUp: [] };
		const total = q.steering.length + q.followUp.length;
		this.queueEl.classList.toggle("hidden", total === 0);
		if (total) {
			this.queueEl.replaceChildren(
				h("div.queue-head", h("span", `대기 중 ${total}개`), h("span.spacer"), h("button.link-btn", { type: "button", onclick: () => this.o.onClearQueue() }, "입력창으로 되돌리기")),
				...q.steering.map((t) => h("div.queue-item.steer", { title: t }, h("span.q-kind", "조향"), h("span.q-text", truncate(t, 200)))),
				...q.followUp.map((t) => h("div.queue-item.follow", { title: t }, h("span.q-kind", "후속"), h("span.q-text", truncate(t, 200)))),
			);
		}
		const widgets = Object.entries(view?.widgets || {});
		const draw = (placement) =>
			widgets.filter(([, w]) => w.placement === placement).map(([k, w]) => h("div.widget", { dataset: { key: k } }, h("pre", stripAnsi(w.lines.join("\n")))));
		this.aboveEl.replaceChildren(...draw("aboveEditor"));
		const statuses = Object.entries(view?.statuses || {}).map(([k, t]) => h("span.status-item", { title: k }, stripAnsi(t)));
		this.belowEl.replaceChildren(...draw("belowEditor"), ...statuses);
	}

	// ---------- attachments ----------
	/** Images go to the model as image content; everything else (and oversized images) is uploaded and passed by path. */
	async addAttachment(file) {
		if (file.type.startsWith("image/") && file.size <= 20 * 1024 * 1024) return this.addImageFile(file);
		if (!file.size && !file.type) {
			this.o.onToast?.(`폴더이거나 읽을 수 없는 항목입니다: ${file.name}`, "warn");
			return;
		}
		const item = { name: file.name || "file", size: file.size, path: null, uploading: true, error: null };
		this.files.push(item);
		this.drawAttachments();
		try {
			const saved = await api.upload(file);
			item.path = saved.path;
			item.name = saved.name;
			item.size = saved.size;
		} catch (err) {
			this.files = this.files.filter((f) => f !== item);
			this.o.onToast?.(`${item.name}: ${err.message}`, "error");
		} finally {
			item.uploading = false;
			this.drawAttachments();
		}
	}

	async addImageFile(file) {
		if (!file.type.startsWith("image/")) return;
		const img = await fileToImageContent(file);
		this.images.push(img);
		this.drawAttachments();
		const input = this.o.getContext().modelInput;
		if (input && !input.includes("image")) this.o.onToast?.("현재 모델은 이미지 입력을 지원하지 않을 수 있습니다", "warn");
	}

	drawAttachments() {
		if (this.running !== undefined) queueMicrotask(() => this.syncRunning(this.running));
		this.attachRow.replaceChildren(
			...this.files.map((f) =>
				h(
					`div.attach.file${f.uploading ? ".uploading" : ""}`,
					{ title: f.path || f.name },
					f.uploading ? h("span.spinner") : icon("file"),
					h("span.attach-name", f.name),
					h("span.attach-size", fmtBytes(f.size)),
					h(
						"button.attach-x",
						{
							type: "button",
							title: "제거",
							onclick: () => {
								this.files = this.files.filter((x) => x !== f);
								this.drawAttachments();
							},
						},
						icon("x"),
					),
				),
			),
			...this.images.map((img, i) =>
				h(
					"div.attach",
					h("img", { src: `data:${img.mimeType};base64,${img.data}`, alt: img.name }),
					h(
						"button.attach-x",
						{
							type: "button",
							title: "제거",
							onclick: () => {
								this.images.splice(i, 1);
								this.drawAttachments();
							},
						},
						icon("x"),
					),
				),
			),
		);
		this.attachRow.classList.toggle("hidden", this.images.length === 0 && this.files.length === 0);
	}

	/** Put attachments back after a failed send (the draft text is restored separately). */
	restoreAttachments({ images = [], files = [] } = {}) {
		if (images.length && !this.images.length) this.images = images.map((img, i) => ({ ...img, name: img.name || `image-${i + 1}` }));
		if (files.length && !this.files.length) this.files = files.map((f) => ({ ...f, uploading: false, error: null }));
		this.drawAttachments();
	}

	async onPaste(e) {
		const items = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file");
		if (!items.length) return;
		e.preventDefault();
		for (const it of items) {
			const f = it.getAsFile();
			if (f) await this.addAttachment(f);
		}
	}

	// ---------- submit / history ----------
	submit(mode) {
		const text = this.textarea.value;
		if (!text.trim() && !this.images.length && !this.files.length) return;
		if (this.files.some((f) => f.uploading)) {
			this.o.onToast?.("파일 업로드가 끝날 때까지 기다려 주세요", "warn");
			return;
		}
		const images = this.images.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
		const files = this.files.filter((f) => f.path).map(({ name, size, path }) => ({ name, size, path }));
		const accepted = this.o.onSubmit({ text, images, files, mode });
		if (accepted === false) return;
		if (text.trim()) {
			this.history = [text, ...this.history.filter((x) => x !== text)].slice(0, HISTORY_MAX);
			store("history", this.history);
		}
		this.histIdx = -1;
		this.textarea.value = "";
		this.images = [];
		this.files = [];
		this.drawAttachments();
		this.autosize();
		this.closePopup();
	}

	historyMove(dir) {
		if (!this.history.length) return false;
		if (this.histIdx === -1) this.histDraft = this.textarea.value;
		const next = this.histIdx + dir;
		if (next < -1 || next >= this.history.length) return false;
		this.histIdx = next;
		this.value = next === -1 ? this.histDraft : this.history[next];
		const pos = dir < 0 ? this.textarea.value.length : 0;
		this.textarea.setSelectionRange(pos, pos);
		return true;
	}

	onKey(e) {
		if (e.isComposing || e.keyCode === 229) return; // IME composition (Korean input)
		const p = this.popup;
		if (p && p.items.length) {
			if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
				p.sel = (p.sel + 1) % p.items.length;
				this.drawPopup();
				e.preventDefault();
				return;
			}
			if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
				p.sel = (p.sel - 1 + p.items.length) % p.items.length;
				this.drawPopup();
				e.preventDefault();
				return;
			}
			if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
				const item = p.items[p.sel];
				// Enter on an exact slash command with no args submits directly
				if (p.kind === "slash" && this.textarea.value.trim() === `/${item.name}`) {
					e.preventDefault();
					this.closePopup();
					this.submit(this.o.getContext().running ? "steer" : "prompt");
					return;
				}
				e.preventDefault();
				this.accept(item);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.closePopup();
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			const running = this.o.getContext().running;
			const followUp = e.altKey || e.ctrlKey || e.metaKey;
			this.submit(running ? (followUp ? "followUp" : "steer") : "prompt");
			return;
		}
		if (e.key === "ArrowUp" && !e.shiftKey && this.textarea.selectionStart === 0 && this.textarea.selectionEnd === 0) {
			if (this.historyMove(1)) e.preventDefault();
			return;
		}
		if (e.key === "ArrowDown" && !e.shiftKey && this.histIdx !== -1 && this.textarea.selectionStart === this.textarea.value.length) {
			if (this.historyMove(-1)) e.preventDefault();
		}
	}

	// ---------- autocomplete ----------
	updatePopup() {
		const ta = this.textarea;
		const text = ta.value;
		const caret = ta.selectionStart;
		if (ta.selectionEnd !== caret) return this.closePopup();
		// slash command: first token of the input
		if (text.startsWith("/") && !/\s/.test(text.slice(0, caret))) {
			const q = text.slice(1, caret).toLowerCase();
			const cmds = this.o.getContext().commands || [];
			const items = cmds
				.filter((c) => c.name.toLowerCase().includes(q))
				.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
				.slice(0, 40);
			const end = text.search(/\s|$/);
			this.popup = { kind: "slash", items, sel: 0, start: 0, end };
			return this.drawPopup();
		}
		// @file mention
		const before = text.slice(0, caret);
		const m = /(^|\s)@("?)([^\s"]*)$/.exec(before);
		if (m) {
			const start = caret - m[3].length - m[2].length - 1;
			const reqId = ++this.popupReq;
			this.fetchFiles(m[3], start, caret, reqId);
			return;
		}
		this.closePopup();
	}

	async loadFiles(q, start, end, reqId) {
		const cwd = this.o.getContext().cwd;
		if (!cwd) return;
		try {
			const files = await api.files(cwd, q);
			if (reqId !== this.popupReq) return;
			this.popup = { kind: "file", items: files.map((f) => ({ name: f, description: "" })), sel: 0, start, end };
			this.drawPopup();
		} catch {
			this.closePopup();
		}
	}

	accept(item) {
		const p = this.popup;
		const ta = this.textarea;
		const text = ta.value;
		let insert;
		if (p.kind === "slash") insert = `/${item.name} `;
		else insert = /\s/.test(item.name) ? `@"${item.name}" ` : `@${item.name}${item.name.endsWith("/") ? "" : " "}`;
		ta.value = text.slice(0, p.start) + insert + text.slice(p.end).replace(/^\s/, "");
		const pos = p.start + insert.length;
		ta.setSelectionRange(pos, pos);
		this.autosize();
		this.closePopup();
		if (p.kind === "file" && item.name.endsWith("/")) this.updatePopup();
		ta.focus();
	}

	drawPopup() {
		const p = this.popup;
		if (!p || !p.items.length) {
			this.popupEl.classList.add("hidden");
			return;
		}
		this.popupEl.classList.remove("hidden");
		this.popupEl.replaceChildren(
			h("div.popup-title", p.kind === "slash" ? "명령" : "파일"),
			...p.items.map((it, i) =>
				h(
					`button.popup-item${i === p.sel ? ".sel" : ""}`,
					{
						type: "button",
						onmousedown: (e) => {
							e.preventDefault();
							this.accept(it);
						},
					},
					p.kind === "slash" ? h("span.popup-name", `/${it.name}`) : h("span.popup-name.mono", it.name),
					it.description ? h("span.popup-desc", it.description) : null,
					it.source && it.source !== "builtin" ? h("span.badge", it.source === "extension" ? "확장" : it.source === "prompt" ? "프롬프트" : it.source === "skill" ? "스킬" : it.source) : null,
				),
			),
		);
		this.popupEl.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
	}

	closePopup() {
		this.popup = null;
		this.popupEl.classList.add("hidden");
	}
}
