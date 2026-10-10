// Provider login / logout for the GUI.
//   sdk mode:  pi's own ModelRuntime (OAuth subscription flows + API keys, same code as `/login` in the terminal)
//   file mode: pi library unavailable → API keys are written to auth.json directly; OAuth must be done in the terminal
// Login flows are step machines polled by the browser: the flow emits events (info / auth_url / device_code / prompt …)
// and waits for answers posted back by the browser. Secrets are never stored in events or returned by status().
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPiSdk, resetPiSdkCache } from "./pi-sdk.mjs";
import { openPiTerminal, terminalSupported } from "./terminal.mjs";
import { getAgentDir } from "./session-store.mjs";

const MAX_FLOWS = 4;
const FLOW_TTL_MS = 15 * 60_000;

// Common API-key providers for file mode (the sdk provides the real list).
const FALLBACK_PROVIDERS = [
	["anthropic", "Anthropic"],
	["openai", "OpenAI"],
	["openrouter", "OpenRouter"],
	["groq", "Groq"],
	["mistral", "Mistral"],
	["deepseek", "DeepSeek"],
	["xai", "xAI"],
	["cerebras", "Cerebras"],
];

function authFile() {
	return path.join(getAgentDir(), "auth.json");
}

function readAuthFile() {
	const file = authFile();
	if (!existsSync(file)) return {};
	const data = JSON.parse(readFileSync(file, "utf8"));
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("auth.json 형식이 올바르지 않습니다");
	return data;
}

function writeAuthFile(data) {
	const file = authFile();
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
	try {
		chmodSync(file, 0o600);
	} catch {}
}

function safeUrl(u) {
	try {
		const url = new URL(String(u));
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
	} catch {
		return null;
	}
}

export class AuthService {
	constructor({ launcher, onChanged } = {}) {
		this.launcher = launcher;
		this.onChanged = onChanged;
		this.flows = new Map();
		this.runtimePromise = null;
		this.mode = null; // "sdk" | "file"
		this.sdkError = null;
	}

	async #init() {
		if (this.mode) return;
		const loaded = this.launcher && !this.launcher.error ? await loadPiSdk(this.launcher) : { error: "pi를 찾지 못했습니다" };
		if (loaded.sdk) {
			this.sdk = loaded;
			this.mode = "sdk";
		} else {
			this.mode = "file";
			this.sdkError = loaded.error;
			this.sdkTried = loaded.tried || [];
		}
	}

	/** Forget the library lookup (after the user installed/updated pi or set PI_WEB_PI_PACKAGE). */
	recheck() {
		resetPiSdkCache();
		this.mode = null;
		this.sdkError = null;
		this.sdkTried = [];
		this.runtimePromise = null;
	}

	/** Opens a terminal running pi so the user can `/login`; credentials changes are detected by pollTerminalLogin(). */
	async openTerminalLogin(cwd) {
		await openPiTerminal(this.launcher, cwd);
		this.terminalBaseline = this.#credentialFingerprint();
		return { opened: true };
	}

	#credentialFingerprint() {
		try {
			return JSON.stringify(Object.entries(readAuthFile()).map(([k, v]) => [k, v?.type, v?.access ? "o" : v?.key ? String(v.key).length : 0]).sort());
		} catch {
			return "";
		}
	}

	/** True once auth.json differs from when the terminal was opened (then idle sessions are restarted once). */
	async pollTerminalLogin() {
		if (this.terminalBaseline === undefined) return { watching: false, changed: false };
		const now = this.#credentialFingerprint();
		if (now === this.terminalBaseline) return { watching: true, changed: false };
		this.terminalBaseline = undefined;
		try {
			await this.onChanged?.();
		} catch {}
		return { watching: false, changed: true };
	}

	async #runtime() {
		await this.#init();
		if (this.mode !== "sdk") throw new Error(this.sdkError || "pi 라이브러리를 사용할 수 없습니다");
		if (!this.runtimePromise) {
			this.runtimePromise = this.sdk.sdk.ModelRuntime.create({ refreshOnCreate: false }).catch((err) => {
				this.runtimePromise = null;
				throw err;
			});
		}
		return this.runtimePromise;
	}

	/** Provider list with sign-in state. No secrets. */
	async status() {
		await this.#init();
		if (this.mode === "file") return this.#fileStatus();
		try {
			const rt = await this.#runtime();
			const stored = new Map((await rt.listCredentials()).map((c) => [c.providerId, c.type]));
			const providers = [];
			for (const p of rt.getProviders()) {
				const st = rt.getProviderAuthStatus(p.id) || { configured: false };
				providers.push({
					id: p.id,
					name: p.name || p.id,
					methods: [p.auth?.oauth ? "oauth" : null, p.auth?.apiKey ? "api_key" : null].filter(Boolean),
					subscription: p.auth?.oauth?.isSubscription === true,
					oauthLabel: p.auth?.oauth?.loginLabel || null,
					configured: !!st.configured,
					source: st.source || null,
					label: st.label || null,
					usingOAuth: !!rt.isUsingOAuth?.(p.id),
					stored: stored.get(p.id) || null,
				});
			}
			for (const [id, type] of stored) {
				if (!providers.some((p) => p.id === id)) providers.push({ id, name: id, methods: [], subscription: false, configured: true, source: "stored", label: null, usingOAuth: type === "oauth", stored: type });
			}
			providers.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
			return { mode: "sdk", version: this.sdk.version, terminal: terminalSupported(), authFile: authFile(), providers };
		} catch (err) {
			return { mode: "sdk", error: err.message, authFile: authFile(), providers: [] };
		}
	}

	#fileStatus() {
		let stored = {};
		let error = null;
		try {
			stored = readAuthFile();
		} catch (err) {
			error = err.message;
		}
		const ids = new Set([...FALLBACK_PROVIDERS.map(([id]) => id), ...Object.keys(stored)]);
		const providers = [...ids].map((id) => ({
			id,
			name: FALLBACK_PROVIDERS.find(([i]) => i === id)?.[1] || id,
			methods: ["api_key"],
			subscription: false,
			configured: !!stored[id],
			source: stored[id] ? "stored" : null,
			label: null,
			usingOAuth: stored[id]?.type === "oauth",
			stored: stored[id]?.type || null,
		}));
		providers.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
		return { mode: "file", sdkError: this.sdkError, sdkTried: this.sdkTried || [], terminal: terminalSupported(), error, authFile: authFile(), providers };
	}

	// ---------------------------------------------------------------- login flows

	#prune() {
		const now = Date.now();
		for (const [id, f] of this.flows) if (f.status !== "running" && now - f.updated > FLOW_TTL_MS) this.flows.delete(id);
	}

	async startLogin({ providerId, type }) {
		await this.#init();
		this.#prune();
		providerId = String(providerId || "").trim();
		if (!providerId || !/^[\w.@:/-]{1,100}$/.test(providerId)) throw Object.assign(new Error("공급자 이름이 올바르지 않습니다"), { status: 400 });
		if (type !== "oauth" && type !== "api_key") throw Object.assign(new Error("로그인 방식이 올바르지 않습니다"), { status: 400 });
		for (const f of this.flows.values()) if (f.status === "running" && f.providerId === providerId) throw Object.assign(new Error("이미 이 공급자의 로그인이 진행 중입니다"), { status: 409 });
		if ([...this.flows.values()].filter((f) => f.status === "running").length >= MAX_FLOWS) throw Object.assign(new Error("진행 중인 로그인이 너무 많습니다"), { status: 429 });

		const flow = {
			id: randomUUID().slice(0, 12),
			providerId,
			type,
			status: "running",
			events: [],
			pending: new Map(),
			abort: new AbortController(),
			updated: Date.now(),
		};
		this.flows.set(flow.id, flow);
		const push = (ev) => {
			flow.events.push({ n: flow.events.length + 1, ...ev });
			flow.updated = Date.now();
		};
		flow.push = push;

		const finish = async (err) => {
			for (const p of flow.pending.values()) p.reject(new Error("Login cancelled"));
			flow.pending.clear();
			if (err) {
				const cancelled = flow.abort.signal.aborted || /cancel/i.test(err.message);
				flow.status = cancelled ? "cancelled" : "error";
				push({ kind: flow.status, message: cancelled ? "로그인을 취소했습니다" : err.message });
			} else {
				flow.status = "done";
				push({ kind: "done" });
				try {
					await this.onChanged?.();
				} catch {}
			}
		};

		if (this.mode === "file") {
			if (type !== "api_key") {
				await finish(new Error("이 환경에서는 구독 로그인을 지원하지 않습니다. 터미널에서 pi를 실행해 /login 을 사용하세요."));
				return this.flowView(flow, 0);
			}
			// Without pi's library the only supported step is "enter the API key".
			(async () => {
				const key = await this.#prompt(flow, { type: "secret", message: `${providerId} API 키`, placeholder: "sk-..." });
				const data = readAuthFile();
				data[providerId] = { type: "api_key", key: String(key).trim() };
				if (!data[providerId].key) throw new Error("API 키가 비어 있습니다");
				writeAuthFile(data);
			})().then(() => finish(null), (err) => finish(err));
			return this.flowView(flow, 0);
		}

		const interaction = {
			signal: flow.abort.signal,
			prompt: (p) => this.#prompt(flow, p),
			notify: (ev) => {
				if (!ev || typeof ev !== "object") return;
				if (ev.type === "auth_url") push({ kind: "auth_url", url: safeUrl(ev.url), instructions: ev.instructions ? String(ev.instructions) : null });
				else if (ev.type === "device_code") push({ kind: "device_code", userCode: String(ev.userCode ?? ""), url: safeUrl(ev.verificationUri), expiresInSeconds: ev.expiresInSeconds ?? null });
				else if (ev.type === "info") push({ kind: "info", message: String(ev.message ?? ""), links: (ev.links || []).map((l) => ({ url: safeUrl(l.url), label: l.label ? String(l.label) : null })).filter((l) => l.url) });
				else push({ kind: "progress", message: String(ev.message ?? "") });
			},
		};
		this.#runtime()
			.then((rt) => rt.login(providerId, type, interaction, { getDeviceId: () => this.#deviceId() }))
			.then(() => finish(null), (err) => finish(err));
		return this.flowView(flow, 0);
	}

	#deviceId() {
		// Stable per installation; pi keeps its own in settings.json — reuse it when present, else a local file.
		try {
			const s = JSON.parse(readFileSync(path.join(getAgentDir(), "settings.json"), "utf8"));
			if (s.deviceId) return String(s.deviceId);
		} catch {}
		const file = path.join(getAgentDir(), "pi-web-device-id");
		try {
			return readFileSync(file, "utf8").trim();
		} catch {}
		const id = randomUUID();
		try {
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, id);
		} catch {}
		return id;
	}

	#prompt(flow, p) {
		return new Promise((resolve, reject) => {
			if (flow.status !== "running" || flow.abort.signal.aborted) return reject(new Error("Login cancelled"));
			const promptId = randomUUID().slice(0, 8);
			const entry = { resolve, reject, type: p.type, options: p.type === "select" ? new Set((p.options || []).map((o) => o.id)) : null };
			flow.pending.set(promptId, entry);
			flow.push({
				kind: "prompt",
				promptId,
				ptype: p.type,
				message: String(p.message ?? ""),
				placeholder: p.placeholder ? String(p.placeholder) : null,
				options: p.type === "select" ? (p.options || []).map((o) => ({ id: String(o.id), label: String(o.label ?? o.id), description: o.description ? String(o.description) : null })) : null,
			});
			p.signal?.addEventListener(
				"abort",
				() => {
					if (flow.pending.delete(promptId)) {
						flow.push({ kind: "prompt_cancel", promptId });
						reject(new Error("Login cancelled"));
					}
				},
				{ once: true },
			);
		});
	}

	getFlow(id) {
		return this.flows.get(id) || null;
	}

	flowView(flow, since = 0) {
		return {
			id: flow.id,
			providerId: flow.providerId,
			type: flow.type,
			status: flow.status,
			events: flow.events.filter((e) => e.n > since),
			last: flow.events.length,
		};
	}

	answer(flowId, promptId, value) {
		const flow = this.flows.get(flowId);
		if (!flow) throw Object.assign(new Error("로그인 진행 정보를 찾을 수 없습니다"), { status: 404 });
		const entry = flow.pending.get(promptId);
		if (!entry) throw Object.assign(new Error("이미 처리된 입력입니다"), { status: 409 });
		if (typeof value !== "string") throw Object.assign(new Error("입력값이 올바르지 않습니다"), { status: 400 });
		if (entry.options && !entry.options.has(value)) throw Object.assign(new Error("선택값이 올바르지 않습니다"), { status: 400 });
		if (value.length > 20_000) throw Object.assign(new Error("입력이 너무 깁니다"), { status: 400 });
		flow.pending.delete(promptId);
		flow.push({ kind: "prompt_done", promptId });
		entry.resolve(value);
	}

	cancel(flowId) {
		const flow = this.flows.get(flowId);
		if (!flow) return false;
		if (flow.status === "running") flow.abort.abort();
		for (const p of flow.pending.values()) p.reject(new Error("Login cancelled"));
		flow.pending.clear();
		return true;
	}

	// ---------------------------------------------------------------- logout

	async logout(providerId) {
		await this.#init();
		providerId = String(providerId || "").trim();
		if (!providerId) throw Object.assign(new Error("공급자 이름이 필요합니다"), { status: 400 });
		if (this.mode === "sdk") {
			const rt = await this.#runtime();
			await rt.logout(providerId);
		} else {
			const data = readAuthFile();
			if (!(providerId in data)) throw Object.assign(new Error("저장된 로그인 정보가 없습니다"), { status: 404 });
			delete data[providerId];
			writeAuthFile(data);
		}
		await this.onChanged?.();
	}
}
