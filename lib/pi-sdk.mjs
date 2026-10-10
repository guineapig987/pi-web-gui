// Loads pi's own library (the published package's dist/index.js) so the gateway can reuse pi's login flows.
// Everything here is best-effort: when the package cannot be found or imported, callers fall back to file-based handling.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PKG_NAME = "@earendil-works/pi-coding-agent";

function isFile(p) {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function readPkg(dir) {
	try {
		const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
		// accept renamed/forked builds of the same package (e.g. an older scope) as long as it is the coding-agent
		return typeof pkg?.name === "string" && /(^|\/)pi-coding-agent$/.test(pkg.name) ? pkg : null;
	} catch {
		return null;
	}
}

function npmGlobalRoot() {
	return new Promise((resolve) => {
		execFile("npm", ["root", "-g"], { shell: process.platform === "win32", timeout: 6000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim().split(/\r?\n/).pop() || null));
	});
}

/**
 * Directory of the installed pi package. Looks at PI_WEB_PI_PACKAGE, around the launcher entry,
 * common global install locations and `npm root -g`. `tried` lists every folder checked (for diagnostics).
 */
export async function findPiPackageDir(launcher, env = process.env) {
	const tried = [];
	const check = (dir) => {
		if (!dir) return null;
		const pkg = readPkg(dir);
		tried.push(pkg ? `${dir}  ✔ ${pkg.name} ${pkg.version || ""}` : existsSync(path.join(dir, "package.json")) ? `${dir}  (다른 패키지)` : dir);
		return pkg ? { dir, pkg, tried } : null;
	};
	const sub = (root) => path.join(root, "node_modules", ...PKG_NAME.split("/"));
	if (env.PI_WEB_PI_PACKAGE) {
		const hit = check(path.resolve(env.PI_WEB_PI_PACKAGE));
		if (hit) return hit;
	}
	if (launcher?.entry) {
		let dir = path.dirname(path.resolve(launcher.entry));
		for (let i = 0; i < 6; i++) {
			const hit = check(dir) || check(sub(dir));
			if (hit) return hit;
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	// PI_WEB_NO_GLOBAL_PI=1: only look at PI_WEB_PI_PACKAGE and the launcher's own folders (used by tests).
	if (env.PI_WEB_NO_GLOBAL_PI) return { tried };
	const roots = [];
	if (env.APPDATA) roots.push(path.join(env.APPDATA, "npm"));
	if (env.npm_config_prefix) roots.push(env.npm_config_prefix);
	if (env.PNPM_HOME) roots.push(path.join(env.PNPM_HOME, "global", "5"));
	if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, "pnpm", "global", "5"));
	for (const r of roots) {
		const hit = check(sub(r));
		if (hit) return hit;
	}
	const npmRoot = await npmGlobalRoot();
	if (npmRoot) {
		const hit = check(path.join(npmRoot, ...PKG_NAME.split("/")));
		if (hit) return hit;
	}
	return { tried };
}

function mainFile(dir, pkg) {
	const exp = pkg.exports?.["."];
	const rel = (typeof exp === "string" ? exp : exp?.import || exp?.default) || pkg.module || pkg.main || "dist/index.js";
	const file = path.join(dir, rel);
	return isFile(file) ? file : null;
}

let cached = null;

/** @returns {Promise<{sdk: object, dir: string, version: string} | {error: string}>} */
export function loadPiSdk(launcher) {
	if (cached) return cached;
	cached = (async () => {
		const found = await findPiPackageDir(launcher);
		if (!found.dir) return { error: "pi 패키지 폴더를 찾지 못했습니다 (환경 변수 PI_WEB_PI_PACKAGE로 지정할 수 있습니다)", tried: found.tried };
		const file = mainFile(found.dir, found.pkg);
		if (!file) return { error: `pi 패키지(${found.pkg.name} ${found.pkg.version || ""})에 라이브러리 진입점(dist/index.js)이 없습니다: ${found.dir}`, tried: found.tried };
		try {
			const sdk = await import(pathToFileURL(file).href);
			if (typeof sdk.ModelRuntime?.create !== "function") return { error: `이 pi(${found.pkg.name} ${found.pkg.version || "?"})는 로그인 라이브러리(ModelRuntime)를 제공하지 않습니다 — pi를 최신 버전으로 업데이트하면 해결될 수 있습니다`, tried: found.tried };
			return { sdk, dir: found.dir, version: String(found.pkg.version || "") };
		} catch (err) {
			return { error: `pi 라이브러리를 불러오지 못했습니다: ${err.message}`, tried: found.tried };
		}
	})();
	return cached;
}

export function resetPiSdkCache() {
	cached = null;
}

export { existsSync };
