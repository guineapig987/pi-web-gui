// Finds how to start pi on this machine and builds spawn arguments.
// Order: PI_CLI env → `pi` on PATH (resolving npm/installer shims to the real JS entry) → null.
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const PKG_REL = ["node_modules", "@earendil-works", "pi-coding-agent"];
const ENTRY_CANDIDATES = [
	["dist", "bundle", "cli.js"],
	["dist", "cli.js"],
];

function isFile(p) {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function entryInPackageDir(pkgDir) {
	for (const parts of ENTRY_CANDIDATES) {
		const p = path.join(pkgDir, ...parts);
		if (isFile(p)) return p;
	}
	return null;
}

function classify(target) {
	const ext = path.extname(target).toLowerCase();
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { kind: "node", entry: target };
	if (IS_WIN && (ext === ".cmd" || ext === ".bat")) return fromShim(target) ?? { kind: "shell", entry: target };
	return { kind: "exe", entry: target };
}

/** Resolve a Windows .cmd shim (npm or the pi installer) to the JS entry or exe it launches. */
function fromShim(shimPath, depth = 0) {
	const dir = path.dirname(shimPath);
	const direct = entryInPackageDir(path.join(dir, ...PKG_REL));
	if (direct) return { kind: "node", entry: direct };
	const fromBin = entryInPackageDir(path.join(dir, "..", "@earendil-works", "pi-coding-agent"));
	if (fromBin) return { kind: "node", entry: fromBin };
	if (depth > 3) return null;
	let text;
	try {
		text = readFileSync(shimPath, "utf8");
	} catch {
		return null;
	}
	if (text.length > 50_000) return null;
	const re = /(?:%~dp0|%dp0%|\$basedir|\$dp0)[\\/]*([^"'\s%*]+?\.(?:js|mjs|cjs|cmd|bat|exe))/gi;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const target = path.resolve(dir, m[1].replace(/[\\/]/g, path.sep));
		if (!isFile(target) || target === shimPath) continue;
		const ext = path.extname(target).toLowerCase();
		if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { kind: "node", entry: target };
		if (ext === ".exe") return { kind: "exe", entry: target };
		const nested = fromShim(target, depth + 1);
		if (nested) return nested;
	}
	return null;
}

export function resolvePi(env = process.env) {
	const override = env.PI_CLI || env.PI_WEB_PI;
	if (override) {
		if (!isFile(override)) return { error: `PI_CLI 경로에 파일이 없습니다: ${override}` };
		return { ...classify(override), source: "PI_CLI" };
	}
	const names = IS_WIN ? ["pi.exe", "pi.cmd", "pi.bat"] : ["pi"];
	const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
	for (const dir of dirs) {
		for (const name of names) {
			const p = path.join(dir, name);
			if (!isFile(p)) continue;
			if (IS_WIN) return { ...classify(p), source: p };
			let real = p;
			try {
				real = realpathSync(p);
			} catch {}
			return { ...classify(real), source: p };
		}
	}
	return {
		error:
			"pi 실행 파일을 찾지 못했습니다. pi를 설치하거나(https://pi.dev) 환경 변수 PI_CLI에 pi의 cli.js 또는 실행 파일 경로를 지정하세요.",
	};
}

function quoteWin(arg) {
	if (arg === "") return '""';
	if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '""')}"`;
}

/** Turn a launcher into spawn() parameters. */
export function buildSpawn(launcher, args) {
	if (launcher.kind === "node") return { command: process.execPath, args: [launcher.entry, ...args], shell: false };
	if (launcher.kind === "exe") return { command: launcher.entry, args, shell: false };
	return { command: [quoteWin(launcher.entry), ...args.map(quoteWin)].join(" "), args: [], shell: true };
}
