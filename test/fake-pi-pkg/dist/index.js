// Stand-in for pi's library: just enough of ModelRuntime for the login tests.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const file = () => path.join(process.env.PI_CODING_AGENT_DIR, "auth.json");
const read = () => (existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {});
const write = (d) => {
	mkdirSync(path.dirname(file()), { recursive: true });
	writeFileSync(file(), JSON.stringify(d, null, 2));
};

const PROVIDERS = [
	{ id: "anthropic", name: "Anthropic", auth: { oauth: { isSubscription: true, loginLabel: "Claude Pro/Max" }, apiKey: { name: "API key" } } },
	{ id: "openai", name: "OpenAI", auth: { apiKey: { name: "API key" } } },
	{ id: "device-co", name: "Device Co", auth: { oauth: { isSubscription: false } } },
];

export class ModelRuntime {
	static async create() {
		return new ModelRuntime();
	}
	getProviders() {
		return PROVIDERS;
	}
	getProviderAuthStatus(id) {
		return read()[id] ? { configured: true, source: "stored" } : id === "openai" && process.env.OPENAI_API_KEY ? { configured: true, source: "environment", label: "OPENAI_API_KEY" } : { configured: false };
	}
	isUsingOAuth(id) {
		return read()[id]?.type === "oauth";
	}
	async listCredentials() {
		return Object.entries(read()).map(([providerId, c]) => ({ providerId, type: c.type }));
	}
	async login(id, type, interaction) {
		if (type === "api_key") {
			const key = await interaction.prompt({ type: "secret", message: `${id} API key` });
			if (!key.trim()) throw new Error("empty key");
			write({ ...read(), [id]: { type: "api_key", key } });
			return { type: "api_key", key };
		}
		if (id === "device-co") {
			interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device", expiresInSeconds: 600 });
			await new Promise((r, rej) => {
				const t = setTimeout(r, 400);
				interaction.signal?.addEventListener("abort", () => {
					clearTimeout(t);
					rej(new Error("Login cancelled"));
				});
			});
		} else {
			interaction.notify({ type: "info", message: "브라우저 창이 열립니다" });
			interaction.notify({ type: "auth_url", url: "https://example.com/oauth?state=1", instructions: "로그인 후 주소를 붙여넣으세요" });
			const code = await interaction.prompt({ type: "manual_code", message: "주소 또는 코드" });
			if (code === "bad") throw new Error("invalid code");
			interaction.notify({ type: "progress", message: "토큰 교환 중" });
		}
		const cred = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600_000 };
		write({ ...read(), [id]: cred });
		return cred;
	}
	async logout(id) {
		const d = read();
		delete d[id];
		write(d);
	}
}
