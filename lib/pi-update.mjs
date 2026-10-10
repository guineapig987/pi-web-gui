// pi version check (https://pi.dev) and a runner for `pi update`.
// The installed version comes from `pi --version`; the latest from pi's public version endpoint.
// Set PI_WEB_NO_UPDATE_CHECK=1 (or PI_OFFLINE / PI_SKIP_VERSION_CHECK) to turn the online check off.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSpawn } from "./pi-launcher.mjs";
import { findPiPackageDir } from "./pi-sdk.mjs";

const changelogUrl = () => process.env.PI_WEB_CHANGELOG_URL || "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md";
const MAX_ENTRIES = 15;
const MAX_ENTRY_CHARS = 12_000;

/** "## [1.1.0] - 2026-10-07" sections of a Keep-a-Changelog style file → [{version, date, markdown}] */
export function parseChangelog(text) {
	const entries = [];
	let cur = null;
	for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
		const m = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(line);
		if (m) {
			cur = parse(m[1]) ? { version: m[1], date: m[2] || null, lines: [] } : null;
			if (cur) entries.push(cur);
		} else if (/^## /.test(line)) cur = null;
		else if (cur) cur.lines.push(line);
	}
	return entries.map((e) => {
		const markdown = e.lines.join("\n").trim();
		return { version: e.version, date: e.date, markdown: markdown.length > MAX_ENTRY_CHARS ? `${markdown.slice(0, MAX_ENTRY_CHARS)}\n\n…` : markdown };
	});
}

const latestUrl = () => process.env.PI_WEB_LATEST_URL || "https://pi.dev/api/latest-version"; // override is for tests
const CHECK_TTL_MS = 6 * 60 * 60_000;
const LOG_LIMIT = 40_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
// biome-ignore lint: control characters are intentional
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const SEMVER = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

function parse(v) {
	const m = SEMVER.exec(String(v ?? ""));
	return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || "" } : null;
}

/** <0, 0, >0 like a - b, or null when either side is not a version. */
export function compareVersions(a, b) {
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
	if (x.pre === y.pre) return 0;
	if (!x.pre) return 1; // 1.0.0 is newer than 1.0.0-beta
	if (!y.pre) return -1;
	return x.pre < y.pre ? -1 : 1;
}

function runCapture(launcher, args, timeoutMs) {
	return new Promise((resolve) => {
		const spec = buildSpawn(launcher, args);
		let out = "";
		let done = false;
		const finish = (r) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(r);
		};
		let child;
		try {
			child = spawn(spec.command, spec.args, { shell: spec.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", PI_SKIP_VERSION_CHECK: "1" } });
		} catch (err) {
			return resolve({ code: null, out: "", error: err.message });
		}
		const timer = setTimeout(() => {
			child.kill();
			finish({ code: null, out, error: "시간 초과" });
		}, timeoutMs);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("error", (err) => finish({ code: null, out, error: err.message }));
		child.on("close", (code) => finish({ code, out }));
	});
}

export class PiUpdater {
	/**
	 * @param launcher result of resolvePi()
	 * @param isBusy () => boolean — true while any session is working (updating then is refused)
	 * @param onUpdated async () => {restarted, skipped} — called after a successful update
	 */
	constructor({ launcher, isBusy, onUpdated }) {
		this.launcher = launcher;
		this.isBusy = isBusy;
		this.onUpdated = onUpdated;
		this.current = null;
		this.latest = null;
		this.checkedAt = 0;
		this.checkError = null;
		this.checking = null;
		this.job = { state: "idle", log: "", code: null, startedAt: null, finishedAt: null, restarted: null, error: null };
	}

	get disabled() {
		return !!(process.env.PI_WEB_NO_UPDATE_CHECK || process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK);
	}

	async #readCurrent() {
		if (!this.launcher || this.launcher.error) return null;
		const r = await runCapture(this.launcher, ["--version"], 20_000);
		return parse(r.out) ? r.out.replace(ANSI, "").match(SEMVER)[0] : null;
	}

	/** Look up installed and latest version. Cached for a few hours unless force is set. */
	check({ force = false } = {}) {
		if (this.checking) return this.checking;
		const fresh = this.checkedAt && Date.now() - this.checkedAt < CHECK_TTL_MS;
		if (fresh && !force) return Promise.resolve(this.status());
		this.checking = (async () => {
			try {
				this.current = await this.#readCurrent();
				if (this.disabled) {
					this.checkError = null;
					return this.status();
				}
				const res = await fetch(latestUrl(), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
				if (!res.ok) throw new Error(`pi.dev 응답 오류 (${res.status})`);
				const data = await res.json();
				if (typeof data?.version !== "string" || !parse(data.version)) throw new Error("최신 버전 정보를 읽을 수 없습니다");
				this.latest = { version: data.version.trim(), note: typeof data.note === "string" ? data.note.trim() : null, packageName: data.packageName || null };
				this.checkError = null;
			} catch (err) {
				this.checkError = err?.name === "TimeoutError" ? "pi.dev에 연결하지 못했습니다 (시간 초과)" : `최신 버전을 확인하지 못했습니다: ${err.message}`;
			} finally {
				this.checkedAt = Date.now();
				this.checking = null;
			}
			return this.status();
		})();
		return this.checking;
	}

	async #loadChangelog() {
		if (this.changelogCache && Date.now() - this.changelogCache.at < CHECK_TTL_MS) return this.changelogCache;
		let result = null;
		let error = null;
		if (!this.disabled) {
			try {
				const res = await fetch(changelogUrl(), { signal: AbortSignal.timeout(8000) });
				if (!res.ok) throw new Error(`응답 오류 (${res.status})`);
				result = { source: "remote", entries: parseChangelog(await res.text()) };
			} catch (err) {
				error = `변경 내역을 불러오지 못했습니다: ${err.message}`;
			}
		}
		if (!result?.entries.length) {
			// fall back to the CHANGELOG.md shipped with an installed pi package (may be a different install than the one that runs)
			try {
				const found = await findPiPackageDir(this.launcher);
				if (found.dir) {
					const entries = parseChangelog(readFileSync(path.join(found.dir, "CHANGELOG.md"), "utf8"));
					if (entries.length) result = { source: "local", entries };
				}
			} catch {}
		}
		this.changelogCache = { at: Date.now(), error: result ? null : error, ...(result || { source: null, entries: [] }) };
		return this.changelogCache;
	}

	/** Release notes: versions newer than the installed one (up to the latest) when an update exists, else the installed version's notes. */
	async changelog() {
		await this.check();
		const st = this.status();
		const all = await this.#loadChangelog();
		let entries;
		let forCurrent = false;
		if (st.updateAvailable) {
			entries = all.entries.filter((e) => compareVersions(e.version, st.current) > 0 && compareVersions(e.version, st.latest) <= 0);
		} else {
			forCurrent = true;
			entries = all.entries.filter((e) => st.current && compareVersions(e.version, st.current) === 0);
		}
		entries.sort((a, b) => compareVersions(b.version, a.version));
		return { entries: entries.slice(0, MAX_ENTRIES), forCurrent, source: all.source, error: entries.length ? null : all.error };
	}

	status() {
		const cmp = this.current && this.latest ? compareVersions(this.latest.version, this.current) : null;
		return {
			current: this.current,
			latest: this.latest?.version || null,
			note: this.latest?.note || null,
			updateAvailable: cmp !== null && cmp > 0,
			checkedAt: this.checkedAt || null,
			error: this.checkError,
			disabled: this.disabled,
			canRun: !!this.launcher && !this.launcher.error,
			job: { ...this.job },
		};
	}

	/** Start `pi update` in the background; poll status() for progress. */
	start({ force = false } = {}) {
		if (!this.launcher || this.launcher.error) throw Object.assign(new Error(this.launcher?.error || "pi를 찾지 못했습니다"), { status: 400 });
		if (this.job.state === "running") throw Object.assign(new Error("이미 업데이트가 진행 중입니다"), { status: 409 });
		if (this.isBusy?.()) throw Object.assign(new Error("작업 중이거나 응답을 기다리는 세션이 있습니다. 끝낸 뒤 업데이트하세요"), { status: 409 });
		this.job = { state: "running", log: "", code: null, startedAt: Date.now(), finishedAt: null, restarted: null, error: null };
		const job = this.job;
		const args = force ? ["update", "--force"] : ["update"];
		job.log = `$ pi ${args.join(" ")}\n`;
		const spec = buildSpawn(this.launcher, args);
		const append = (d) => {
			job.log = (job.log + String(d).replace(ANSI, "").replace(/\r(?!\n)/g, "\n")).slice(-LOG_LIMIT);
		};
		let finishing = false;
		const finish = async (code, error) => {
			if (finishing || job.state !== "running") return;
			finishing = true;
			clearTimeout(timer);
			job.code = code;
			if (code === 0) {
				// stay "running" until the new version is read and idle sessions are restarted, so the UI never sees stale data
				this.checkedAt = 0;
				await this.check({ force: true }).catch(() => {});
				try {
					job.restarted = (await this.onUpdated?.()) ?? null;
				} catch {}
				job.finishedAt = Date.now();
				job.state = "done";
			} else {
				job.finishedAt = Date.now();
				job.state = "error";
				job.error = error || `업데이트가 실패했습니다 (코드 ${code ?? "?"})`;
			}
		};
		let child;
		try {
			child = spawn(spec.command, spec.args, { shell: spec.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", PI_SKIP_VERSION_CHECK: "1" } });
		} catch (err) {
			finish(null, err.message);
			return this.status();
		}
		const timer = setTimeout(() => {
			child.kill();
			finish(null, "업데이트 시간이 너무 오래 걸려 중단했습니다");
		}, UPDATE_TIMEOUT_MS);
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("error", (err) => finish(null, err.message));
		child.on("close", (code) => finish(code));
		return this.status();
	}
}
