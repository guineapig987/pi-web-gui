// Modal dialogs: generic modal, list picker, folder picker, extension UI dialogs, toasts.
import { api } from "./api.js";
import { h, icon } from "./dom.js";
import { basename, relTime, stripAnsi, truncate } from "./util.js";

const root = () => document.getElementById("modal-root");
let stack = [];

export function closeTopModal() {
	const top = stack.pop();
	if (top) {
		top.el.remove();
		top.onClose?.();
		return true;
	}
	return false;
}

export function modalOpen() {
	return stack.length > 0;
}

/** Open a modal. Returns {el, close}. */
export function openModal({ title, body, actions = [], wide = false, onClose, className = "", modalClass = "" }) {
	const opener = document.activeElement;
	const close = () => {
		const idx = stack.findIndex((s) => s.el === overlay);
		if (idx >= 0) {
			stack.splice(idx, 1);
			const hadFocus = overlay.contains(document.activeElement);
			overlay.remove();
			onClose?.();
			// give focus back to whatever opened the dialog (keyboard and screen-reader users keep their place)
			if (hadFocus && opener && opener !== document.body && opener.isConnected) opener.focus?.();
		}
	};
	const overlay = h(
		`div.modal-overlay${className ? `.${className}` : ""}`,
		{
			onmousedown: (e) => {
				if (e.target === overlay) close();
			},
		},
		h(
			`div.modal${wide ? ".wide" : ""}${modalClass ? `.${modalClass}` : ""}`,
			{ role: "dialog", "aria-modal": "true", "aria-label": title },
			h("div.modal-head", h("div.modal-title", title), h("button.icon-btn", { type: "button", title: "닫기 (Esc)", onclick: close }, icon("x"))),
			h("div.modal-body", body),
			actions.length ? h("div.modal-actions", actions) : null,
		),
	);
	root().append(overlay);
	stack.push({ el: overlay, onClose });
	setTimeout(() => {
		const f = overlay.querySelector("[autofocus], input, textarea, select, .list-item, button.primary");
		f?.focus();
	}, 0);
	return { el: overlay, close };
}

/**
 * Searchable list picker.
 * items: [{label, sub, badge, value, group, current}]
 */
export function pickFromList({ title, items, placeholder = "검색…", onPick, emptyText = "항목이 없습니다", renderExtra, palette = false }) {
	let filtered = items;
	let sel = Math.max(0, items.findIndex((i) => i.current));
	const listEl = h("div.list");
	const input = h(palette ? "input.input.search" : "input.input", {
		type: "text",
		placeholder,
		autofocus: true,
		oninput: () => {
			const q = input.value.trim().toLowerCase();
			filtered = q ? items.filter((i) => `${i.label} ${i.sub ?? ""} ${i.group ?? ""} ${i.search ?? ""}`.toLowerCase().includes(q)) : items;
			sel = 0;
			draw();
		},
		onkeydown: (e) => {
			if (e.key === "ArrowDown") {
				sel = Math.min(filtered.length - 1, sel + 1);
				draw();
				e.preventDefault();
			} else if (e.key === "ArrowUp") {
				sel = Math.max(0, sel - 1);
				draw();
				e.preventDefault();
			} else if (e.key === "Enter" && !e.isComposing && filtered[sel]) {
				e.preventDefault();
				choose(filtered[sel]);
			}
		},
	});
	let modal;
	const choose = (item) => {
		modal.close();
		onPick(item.value, item);
	};
	function draw() {
		listEl.replaceChildren();
		if (!filtered.length) {
			listEl.append(h("div.list-empty", emptyText));
			return;
		}
		let lastGroup = null;
		filtered.forEach((item, idx) => {
			if (item.group && item.group !== lastGroup) {
				listEl.append(h("div.list-group", item.group));
				lastGroup = item.group;
			}
			const row = h(
				`button.list-item${idx === sel ? ".sel" : ""}${item.current ? ".current" : ""}`,
				{ type: "button", onclick: () => choose(item), onmousemove: () => {
					if (sel !== idx) {
						sel = idx;
						for (const r of listEl.querySelectorAll(".list-item")) r.classList.toggle("sel", r === row);
					}
				} },
				h(
					"div.list-main",
					item.icon ? icon(item.icon) : null,
					item.avatar || null,
					h("span.list-label", item.label),
					item.current ? icon("check", "ok") : null,
					item.badge ? h("span.badge", item.badge) : null,
					item.kbd ? h("kbd", item.kbd) : null,
				),
				item.sub ? h("div.list-sub", item.sub) : null,
			);
			listEl.append(row);
			if (idx === sel) queueMicrotask(() => row.scrollIntoView({ block: "nearest" }));
		});
	}
	draw();
	modal = openModal({ title, body: [input, renderExtra?.() ?? null, listEl], wide: true, modalClass: palette ? "palette" : "" });
	return modal;
}

/** Folder picker for choosing a project working directory. */
export async function pickFolder({ start, recent = [], onPick, shortcuts = [], title = "프로젝트 폴더 열기", okLabel = "이 폴더에서 열기", create = false }) {
	const pathInput = h("input.input.mono", { type: "text", placeholder: "폴더 경로를 입력하거나 아래에서 고르세요" });
	const listEl = h("div.list.dir-list");
	const errEl = h("div.form-error");
	const recentEl = h("div.recent");
	let current = null;
	let modal;
	async function load(p) {
		errEl.textContent = "";
		try {
			const d = await api.dirs(p);
			current = d;
			pathInput.value = d.path;
			listEl.replaceChildren();
			const rows = [];
			if (d.parent) rows.push(h("button.list-item.dir", { type: "button", onclick: () => load(d.parent) }, h("div.list-main", icon("folder"), h("span.list-label", ".. (상위 폴더)"))));
			for (const name of d.dirs) {
				const full = d.path.endsWith(d.sep) ? d.path + name : d.path + d.sep + name;
				rows.push(h("button.list-item.dir", { type: "button", ondblclick: () => finish(full), onclick: () => load(full) }, h("div.list-main", icon("folder"), h("span.list-label", name))));
			}
			if (!d.dirs.length) rows.push(h("div.list-empty", "하위 폴더가 없습니다"));
			listEl.append(...rows);
			if (d.drives?.length && !recentEl.dataset.drives) {
				recentEl.dataset.drives = "1";
				recentEl.append(h("div.chips", d.drives.map((dr) => h("button.chip", { type: "button", onclick: () => load(dr) }, dr))));
			}
		} catch (err) {
			errEl.textContent = err.message;
		}
	}
	function finish(p) {
		modal.close();
		onPick(p);
	}
	// Inline "new folder" form: creates a folder inside the folder currently shown, then enters it.
	const nameInput = h("input.input", { type: "text", placeholder: "새 폴더 이름", maxlength: "100", spellcheck: "false" });
	const createErr = h("div.form-error");
	const createBtn = h("button.btn.primary", { type: "button", onclick: () => doCreate() }, "만들기");
	const createRow = h("div.mkdir-row.hidden", h("div.row", icon("folder"), nameInput, createBtn, h("button.btn", { type: "button", onclick: () => toggleCreate(false) }, "취소")), createErr);
	function toggleCreate(on) {
		createRow.classList.toggle("hidden", !on);
		createErr.textContent = "";
		if (on) {
			nameInput.value = "";
			nameInput.focus();
		}
	}
	async function doCreate() {
		if (!current) return;
		createErr.textContent = "";
		createBtn.disabled = true;
		try {
			const made = await api.mkdir(current.path, nameInput.value);
			toggleCreate(false);
			toast(`폴더를 만들었습니다: ${basename(made)}`);
			await load(made);
		} catch (err) {
			createErr.textContent = err.message;
			nameInput.focus();
		} finally {
			createBtn.disabled = false;
		}
	}
	nameInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.isComposing) {
			e.preventDefault();
			doCreate();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			toggleCreate(false);
		}
	});
	pathInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.isComposing) {
			e.preventDefault();
			load(pathInput.value.trim());
		}
	});
	if (shortcuts.length) recentEl.append(h("div.chips", shortcuts.map((s) => h("button.chip.shortcut", { type: "button", title: s.path, onclick: () => load(s.path) }, icon("folder"), s.label))));
	if (recent.length) {
		recentEl.append(
			h("div.list-group", "최근 프로젝트"),
			h(
				"div.chips",
				recent.slice(0, 12).map((r) => h("button.chip", { type: "button", title: r.cwd, onclick: () => finish(r.cwd) }, basename(r.cwd), h("span.chip-sub", ` ${r.count}`))),
			),
		);
	}
	modal = openModal({
		title,
		wide: true,
		body: [
			recentEl,
			h("div.list-group", "폴더 탐색"),
			h("div.row", pathInput, h("button.btn", { type: "button", onclick: () => load(pathInput.value.trim()) }, "이동")),
			errEl,
			listEl,
			createRow,
		],
		actions: [
			h("button.btn.left", { type: "button", onclick: () => toggleCreate(true) }, icon("plus"), "새 폴더 만들기"),
			h("button.btn", { type: "button", onclick: () => modal.close() }, "취소"),
			h("button.btn.primary", { type: "button", onclick: () => current && finish(pathInput.value.trim() || current.path) }, okLabel),
		],
	});
	await load(start || "");
	if (create) toggleCreate(true);
}

/** Extension UI dialog (select / confirm / input / editor). */
export function showExtensionDialog(req, respond) {
	let done = false;
	const answer = (payload) => {
		if (done) return;
		done = true;
		modal.close();
		respond(payload);
	};
	let body;
	let actions;
	const deadline = req.timeout ? req.receivedAt + req.timeout : null;
	const timer = deadline ? h("div.dialog-timer") : null;
	if (req.method === "confirm") {
		body = [h("div.dialog-message", req.message ?? "")];
		actions = [
			h("button.btn", { type: "button", onclick: () => answer({ confirmed: false }) }, "아니요"),
			h("button.btn.primary", { type: "button", autofocus: true, onclick: () => answer({ confirmed: true }) }, "예"),
		];
	} else if (req.method === "select") {
		body = [
			h(
				"div.list",
				(req.options || []).map((opt, i) =>
					h("button.list-item", { type: "button", autofocus: i === 0, onclick: () => answer({ value: opt }) }, h("div.list-main", h("span.list-label", opt))),
				),
			),
		];
		actions = [h("button.btn", { type: "button", onclick: () => answer({ cancelled: true }) }, "취소")];
	} else if (req.method === "input") {
		const input = h("input.input", { type: "text", placeholder: req.placeholder ?? "", autofocus: true, onkeydown: (e) => e.key === "Enter" && !e.isComposing && answer({ value: input.value }) });
		body = [input];
		actions = [
			h("button.btn", { type: "button", onclick: () => answer({ cancelled: true }) }, "취소"),
			h("button.btn.primary", { type: "button", onclick: () => answer({ value: input.value }) }, "확인"),
		];
	} else {
		const ta = h("textarea.input.mono.editor-area", { rows: 14, autofocus: true });
		ta.value = req.prefill ?? "";
		body = [ta];
		actions = [
			h("button.btn", { type: "button", onclick: () => answer({ cancelled: true }) }, "취소"),
			h("button.btn.primary", { type: "button", onclick: () => answer({ value: ta.value }) }, "확인"),
		];
	}
	if (timer) body.push(timer);
	const modal = openModal({
		title: req.title || "확장 요청",
		body,
		actions,
		className: "ext-dialog",
		onClose: () => {
			clearInterval(tick);
			if (!done) {
				done = true;
				respond({ cancelled: true });
			}
		},
	});
	const tick = deadline
		? setInterval(() => {
				const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
				timer.textContent = `${left}초 후 자동으로 기본값이 적용됩니다`;
			}, 250)
		: null;
	return {
		dismiss: () => {
			if (done) return;
			done = true;
			clearInterval(tick);
			modal.close();
		},
	};
}

/** @param action optional {label, run} — shows a button in the toast (e.g. "되돌리기") */
export function toast(message, kind = "info", ms = 3500, action = null) {
	const host = document.getElementById("toasts");
	const dismiss = () => {
		el.classList.add("out");
		setTimeout(() => el.remove(), 300);
	};
	const el = h(
		`div.toast.${kind}`,
		{ role: kind === "error" ? "alert" : "status" },
		icon(kind === "error" ? "alert" : kind === "warn" ? "alert" : "check"),
		h("span", truncate(stripAnsi(message), 400)),
		action
			? h(
					"button.toast-action",
					{
						type: "button",
						onclick: () => {
							dismiss();
							action.run();
						},
					},
					action.label,
				)
			: null,
	);
	host.append(el);
	setTimeout(dismiss, ms);
}

export function sessionItems(sessions, currentFile) {
	return sessions.map((s) => ({
		label: s.name || s.firstMessage || "(빈 세션)",
		sub: `${relTime(s.modified)} · 메시지 ${s.messageCount}개${s.name && s.firstMessage ? ` · ${truncate(s.firstMessage, 60)}` : ""}`,
		value: s,
		current: currentFile && s.path === currentFile,
		search: s.firstMessage,
	}));
}
