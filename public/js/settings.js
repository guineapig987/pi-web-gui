// Settings dialog: a curated set of pi settings, saved straight into the global settings.json.
// Options that pi can change on a running session (queue modes, auto compaction, auto retry) are applied live too.
import { api } from "./api.js";
import { h, setChildren } from "./dom.js";
import { openModal, toast } from "./modals.js";

const LIVE_PARAM = { set_steering_mode: "mode", set_follow_up_mode: "mode", set_auto_compaction: "enabled", set_auto_retry: "enabled" };

/**
 * @param ctx {
 *   sessionId(): string|null,                // active live session, if any
 *   command(cmd): Promise,                   // send an RPC command to it
 *   restart(): Promise                       // restart the active session's pi process
 * }
 */
export async function openSettingsModal(ctx = {}) {
	const body = h("div.settings-body");
	const footer = h("div.settings-foot");
	const errEl = h("div.form-error");
	let data = null;
	let needsRestart = false;

	const modal = openModal({
		title: "설정",
		wide: true,
		modalClass: "settings",
		body: [errEl, body],
		actions: [footer, h("button.btn", { type: "button", onclick: () => modal.close() }, "닫기")],
	});

	async function save(field, value) {
		errEl.textContent = "";
		try {
			data = await api.saveSettings({ [field.key]: value });
		} catch (err) {
			errEl.textContent = err.message;
			render();
			return;
		}
		// apply to the running session when pi supports it
		let live = false;
		if (field.live && ctx.sessionId?.()) {
			const effective = value === null ? field.default : value;
			try {
				await ctx.command({ type: field.live, [LIVE_PARAM[field.live]]: effective });
				live = true;
			} catch (err) {
				toast(`저장은 됐지만 현재 세션에는 적용하지 못했습니다: ${err.message}`, "warn");
			}
		}
		if (!live) needsRestart = true;
		toast(live ? "저장하고 현재 세션에 적용했습니다" : "저장했습니다 · 새 세션부터 적용됩니다");
		render();
	}

	function control(field) {
		const set = data.values[field.key];
		const value = set === undefined ? field.default : set;
		switch (field.type) {
			case "bool": {
				const box = h("input", { type: "checkbox", checked: !!value, onchange: () => save(field, box.checked) });
				return h("label.switch", box, h("span.switch-track"));
			}
			case "enum": {
				const sel = h(
					"select.input.select",
					{ onchange: () => save(field, sel.value) },
					field.options.map((o) => h("option", { value: o, selected: o === value }, field.labels?.[o] || o)),
				);
				return sel;
			}
			case "int": {
				const input = h("input.input.num", { type: "number", value: value ?? "", min: field.min, max: field.max, step: "1" });
				const commit = () => {
					const raw = input.value.trim();
					if (raw === "") return save(field, null);
					const n = Number(raw);
					if (n !== value) save(field, n);
				};
				input.addEventListener("change", commit);
				input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && commit());
				return input;
			}
			case "string": {
				const input = h("input.input", { type: "text", value: set ?? "", placeholder: "(기본값)", spellcheck: "false" });
				input.addEventListener("change", () => save(field, input.value.trim()));
				return input;
			}
			case "tools": {
				const chosen = new Set(Array.isArray(set) ? set : []);
				return h(
					"div.tool-chips",
					field.options.map((t) => {
						const box = h("input", {
							type: "checkbox",
							checked: chosen.has(t),
							onchange: () => {
								if (box.checked) chosen.add(t);
								else chosen.delete(t);
								save(field, [...chosen]);
							},
						});
						return h("label.tool-chip", box, h("span", t));
					}),
				);
			}
			default:
				return null;
		}
	}

	function render() {
		const groups = new Map();
		for (const f of data.fields) {
			if (!groups.has(f.group)) groups.set(f.group, []);
			groups.get(f.group).push(f);
		}
		const sections = [];
		for (const [name, fields] of groups) {
			sections.push(
				h(
					"section.set-group",
					h("h4", name),
					fields.map((f) => {
						const isSet = data.values[f.key] !== undefined;
						return h(
							"div.set-row",
							h("div.set-text", h("div.set-label", f.label), f.help ? h("div.list-sub.wrap", f.help) : null),
							h(
								"div.set-ctl",
								control(f),
								isSet ? h("button.link-btn", { type: "button", title: "pi 기본값으로 되돌리기", onclick: () => save(f, null) }, "기본값") : null,
							),
						);
					}),
				),
			);
		}
		setChildren(body, sections);
		setChildren(
			footer,
			h("span.muted.mono", { title: data.path }, data.path),
			needsRestart && ctx.sessionId?.()
				? h("button.btn", { type: "button", onclick: async () => (await ctx.restart?.(), (needsRestart = false), render()) }, "현재 세션 pi 다시 시작")
				: null,
		);
	}

	try {
		data = await api.settings();
		render();
	} catch (err) {
		errEl.textContent = err.message;
	}
}
