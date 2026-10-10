// Account dialog: sign in to model providers (subscription OAuth or API key) and sign out.
// The gateway runs pi's own login code; this file renders its steps (links, device codes, prompts).
import { api } from "./api.js";
import { h, icon, setChildren } from "./dom.js";
import { openModal, toast } from "./modals.js";

const POLL_MS = 600;

function statusText(p) {
	if (!p.configured) return "연결 안 됨";
	if (p.usingOAuth) return "구독 계정으로 로그인됨";
	if (p.source === "stored") return "API 키 저장됨";
	if (p.source === "environment") return `환경 변수${p.label ? ` ${p.label}` : ""}`;
	if (p.source === "runtime") return "임시 키 사용 중";
	return p.label || "설정됨";
}

function linkEl(url, label) {
	return h("a.btn.primary.auth-link", { href: url, target: "_blank", rel: "noopener noreferrer" }, icon("key"), label);
}

/** Runs one login flow in its own modal. Resolves true when the provider was signed in. */
function runLoginFlow(provider, type) {
	return new Promise((resolve) => {
		let flowId = null;
		let since = 0;
		let finished = false;
		let polling = true;
		const body = h("div.auth-flow");
		const errEl = h("div.form-error");
		const cancelBtn = h("button.btn", { type: "button", onclick: () => modal.close() }, "취소");
		const promptEls = new Map();
		let result = false;

		const modal = openModal({
			title: `${provider.name} ${type === "oauth" ? "계정 로그인" : "API 키 입력"}`,
			body: [body, errEl],
			actions: [cancelBtn],
			onClose: () => {
				polling = false;
				if (flowId && !finished) api.authCancel(flowId).catch(() => {});
				resolve(result);
			},
		});

		const addStep = (el) => {
			body.append(el);
			el.scrollIntoView?.({ block: "nearest" });
		};

		function promptEl(ev) {
			const send = async (value) => {
				box.classList.add("busy");
				try {
					await api.authAnswer(flowId, ev.promptId, value);
				} catch (err) {
					errEl.textContent = err.message;
					box.classList.remove("busy");
				}
			};
			const box = h("div.auth-prompt");
			box.append(h("div.auth-prompt-msg", ev.message));
			if (ev.ptype === "select") {
				box.append(
					h(
						"div.auth-options",
						(ev.options || []).map((o) => h("button.btn", { type: "button", onclick: () => send(o.id) }, o.label, o.description ? h("span.opt-sub", ` ${o.description}`) : null)),
					),
				);
			} else {
				const input = h("input.input", {
					type: ev.ptype === "secret" ? "password" : "text",
					placeholder: ev.placeholder || (ev.ptype === "manual_code" ? "브라우저 주소창의 주소 또는 코드를 붙여넣기" : ""),
					autocomplete: "off",
					spellcheck: "false",
				});
				const ok = h("button.btn.primary", { type: "button", onclick: () => input.value.trim() && send(input.value.trim()) }, "확인");
				input.addEventListener("keydown", (e) => {
					if (e.key === "Enter" && !e.isComposing) {
						e.preventDefault();
						ok.click();
					}
				});
				box.append(h("div.row", input, ok));
				setTimeout(() => input.focus(), 0);
			}
			promptEls.set(ev.promptId, box);
			return box;
		}

		function apply(ev) {
			switch (ev.kind) {
				case "info":
					addStep(h("div.auth-info", h("div", ev.message), (ev.links || []).map((l) => h("div", h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label || l.url)))));
					break;
				case "progress":
					addStep(h("div.auth-progress", h("span.spinner"), h("span", ev.message)));
					break;
				case "auth_url":
					if (ev.url) addStep(h("div.auth-info", linkEl(ev.url, "브라우저에서 로그인 페이지 열기"), ev.instructions ? h("div.muted", ev.instructions) : null));
					break;
				case "device_code":
					addStep(
						h(
							"div.auth-device",
							h("div.muted", "아래 코드를 로그인 페이지에 입력하세요"),
							h("div.auth-code.mono", ev.userCode),
							ev.url ? linkEl(ev.url, "로그인 페이지 열기") : null,
							h("div.auth-progress", h("span.spinner"), h("span", "인증을 기다리는 중…")),
						),
					);
					break;
				case "prompt":
					addStep(promptEl(ev));
					break;
				case "prompt_done":
				case "prompt_cancel":
					promptEls.get(ev.promptId)?.remove();
					promptEls.delete(ev.promptId);
					break;
				case "done":
					addStep(h("div.auth-done", icon("check"), h("span", `${provider.name} 로그인이 완료되었습니다`)));
					break;
				case "cancelled":
					break;
				case "error":
					errEl.textContent = ev.message || "로그인에 실패했습니다";
					break;
			}
		}

		(async () => {
			try {
				const flow = await api.authLogin(provider.id, type);
				flowId = flow.id;
				for (const ev of flow.events) apply(ev);
				since = flow.last;
				let status = flow.status;
				let change = null;
				while (polling && status === "running") {
					await new Promise((r) => setTimeout(r, POLL_MS));
					if (!polling) return;
					const r = await api.authFlow(flowId, since);
					for (const ev of r.flow.events) apply(ev);
					since = r.flow.last;
					status = r.flow.status;
					change = r.authChange;
				}
				if (!polling) return;
				finished = true;
				if (status === "done") {
					result = true;
					cancelBtn.textContent = "닫기";
					if (change?.restarted) body.append(h("div.muted", `대기 중이던 세션 ${change.restarted}개를 다시 시작해 새 로그인을 적용했습니다.`));
					if (change?.skipped) body.append(h("div.muted", `작업 중인 세션 ${change.skipped}개는 작업이 끝난 뒤 pi를 다시 시작해야 적용됩니다.`));
					setTimeout(() => polling && modal.close(), change?.skipped ? 4000 : 1400);
				} else {
					cancelBtn.textContent = "닫기";
				}
			} catch (err) {
				finished = true;
				errEl.textContent = err.message;
				cancelBtn.textContent = "닫기";
			}
		})();
	});
}

/** Opens a terminal running pi and waits until its /login changed the stored credentials. Resolves true on success. */
function runTerminalLogin() {
	return new Promise((resolve) => {
		let polling = true;
		let result = false;
		const state = h("div.auth-progress", h("span.spinner"), h("span", "터미널을 여는 중…"));
		const errEl = h("div.form-error");
		const modal = openModal({
			title: "터미널에서 구독 로그인",
			body: [
				h("div", "열린 터미널(pi)에서 아래 순서로 진행하세요."),
				h("ol.auth-steps", h("li", h("code", "/login"), " 을 입력하고 Enter"), h("li", "공급자와 로그인 방식(구독 계정)을 선택"), h("li", "안내에 따라 브라우저에서 로그인")),
				state,
				errEl,
			],
			actions: [h("button.btn", { type: "button", onclick: () => modal.close() }, "닫기")],
			onClose: () => {
				polling = false;
				resolve(result);
			},
		});
		(async () => {
			try {
				await api.authTerminal();
				setChildren(state, h("span.spinner"), h("span", "로그인이 끝나기를 기다리는 중… (끝나면 자동으로 감지합니다)"));
				while (polling) {
					await new Promise((r) => setTimeout(r, 1500));
					if (!polling) return;
					const r = await api.authTerminalPoll();
					if (r.changed) {
						result = true;
						setChildren(state, h("div.auth-done", icon("check"), h("span", "로그인 정보가 바뀐 것을 확인했습니다")));
						if (r.restarted) state.append(h("div.muted", `대기 중이던 세션 ${r.restarted}개를 다시 시작했습니다.`));
						setTimeout(() => polling && modal.close(), 1800);
						return;
					}
				}
			} catch (err) {
				setChildren(state);
				errEl.textContent = err.message;
			}
		})();
	});
}

/** The account dialog. onChanged() runs after any sign-in / sign-out. */
export async function openAccountModal({ onChanged } = {}) {
	const listEl = h("div.list.provider-list");
	const noteEl = h("div.auth-note");
	const search = h("input.input", { type: "text", placeholder: "공급자 검색", autocomplete: "off" });
	const customRow = h("div.auth-custom.hidden");
	const toolbar = h("div.auth-toolbar");
	let data = null;

	async function reload() {
		try {
			data = await api.authStatus();
		} catch (err) {
			setChildren(listEl, h("div.list-empty", err.message));
			return;
		}
		render();
	}

	async function terminalLogin() {
		const ok = await runTerminalLogin();
		await reload();
		if (ok) onChanged?.();
	}

	async function recheck() {
		try {
			data = await api.authRecheck();
			render();
			toast(data.mode === "sdk" ? "pi 로그인 라이브러리를 찾았습니다" : "아직 찾지 못했습니다", data.mode === "sdk" ? "info" : "warn");
		} catch (err) {
			toast(err.message, "error");
		}
	}

	async function signIn(p, type) {
		const ok = await runLoginFlow(p, type);
		await reload();
		if (ok) onChanged?.();
	}

	async function signOut(p) {
		try {
			const r = await api.authLogout(p.id);
			toast(`${p.name} 로그아웃했습니다${r.restarted ? ` · 세션 ${r.restarted}개 다시 시작` : ""}`);
			await reload();
			onChanged?.();
		} catch (err) {
			toast(err.message, "error");
		}
	}

	function row(p) {
		const actions = [];
		if (p.methods.includes("oauth")) actions.push(h("button.btn", { type: "button", onclick: () => signIn(p, "oauth") }, p.subscription ? "구독 로그인" : "로그인"));
		if (p.methods.includes("api_key")) actions.push(h("button.btn", { type: "button", onclick: () => signIn(p, "api_key") }, icon("key"), "API 키"));
		if (p.stored) actions.push(h("button.btn.danger-ghost", { type: "button", onclick: () => signOut(p) }, "로그아웃"));
		return h(
			"div.provider-row",
			h("span.provider-dot", { class: p.configured ? "on" : "" }),
			h("div.provider-main", h("div.provider-name", p.name, p.subscription ? h("span.badge", "구독") : null), h("div.list-sub", `${statusText(p)}${p.id !== p.name ? ` · ${p.id}` : ""}`)),
			h("div.provider-actions", actions),
		);
	}

	function render() {
		const q = search.value.trim().toLowerCase();
		const items = (data.providers || []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
		const notes = [];
		if (data.mode === "file") {
			notes.push(h("div", "pi의 로그인 라이브러리를 찾지 못해 이 창에서는 API 키만 저장할 수 있습니다. 구독 로그인은 아래 버튼으로 터미널의 pi에서 진행하세요."));
			if (data.sdkError) notes.push(h("div.muted", data.sdkError));
			if (data.sdkTried?.length) notes.push(h("details.auth-tried", h("summary", `확인한 폴더 ${data.sdkTried.length}곳`), data.sdkTried.map((d) => h("div.mono", d)), h("div", "pi 패키지 폴더를 환경 변수 PI_WEB_PI_PACKAGE로 지정하면 찾을 수 있습니다.")));
		}
		if (data.error) notes.push(h("div.form-error", data.error));
		notes.push(h("div.muted", `로그인 정보는 ${data.authFile} 에 저장됩니다. 환경 변수나 models.json으로 설정한 인증은 로그아웃으로 지워지지 않습니다.`));
		setChildren(noteEl, notes);
		setChildren(listEl, items.length ? items.map(row) : h("div.list-empty", "일치하는 공급자가 없습니다"));
		customRow.classList.toggle("hidden", data.mode !== "file");
		const bar = [];
		if (data.terminal) bar.push(h("button.btn", { type: "button", onclick: terminalLogin }, icon("user"), "터미널에서 구독 로그인"));
		if (data.mode === "file") bar.push(h("button.btn", { type: "button", onclick: recheck }, "pi 다시 찾기"));
		setChildren(toolbar, bar);
	}

	{
		const idInput = h("input.input", { type: "text", placeholder: "공급자 ID (예: anthropic)", autocomplete: "off", spellcheck: "false" });
		const go = h("button.btn.primary", { type: "button", onclick: () => idInput.value.trim() && signIn({ id: idInput.value.trim(), name: idInput.value.trim() }, "api_key") }, "API 키 입력");
		customRow.append(h("div.list-group", "다른 공급자"), h("div.row", idInput, go));
	}

	search.addEventListener("input", () => data && render());
	openModal({ title: "계정 · 로그인", wide: true, body: [search, noteEl, toolbar, listEl, customRow] });
	await reload();
}
