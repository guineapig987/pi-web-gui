// File search for @-mentions and a directory browser for choosing a project folder.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	".hg",
	".svn",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".cache",
	".idea",
	".gradle",
	"coverage",
]);
const MAX_FILES = 20_000;
const CACHE_MS = 15_000;
const fileCache = new Map();

function gitFiles(cwd) {
	return new Promise((resolve) => {
		execFile(
			"git",
			["ls-files", "--cached", "--others", "--exclude-standard"],
			{ cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 8000 },
			(err, stdout) => {
				if (err) return resolve(null);
				resolve(stdout.split("\n").filter(Boolean).slice(0, MAX_FILES));
			},
		);
	});
}

async function walkFiles(root) {
	const out = [];
	const queue = [""];
	while (queue.length && out.length < MAX_FILES) {
		const rel = queue.shift();
		let entries;
		try {
			entries = await readdir(path.join(root, rel), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) queue.push(r);
			} else if (e.isFile()) {
				out.push(r);
				if (out.length >= MAX_FILES) break;
			}
		}
	}
	return out;
}

async function allFiles(cwd) {
	const hit = fileCache.get(cwd);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
	let files = existsSync(path.join(cwd, ".git")) ? await gitFiles(cwd) : null;
	if (!files) files = await walkFiles(cwd);
	// Also offer directories (derived from file paths).
	const dirs = new Set();
	for (const f of files) {
		let i = f.indexOf("/");
		while (i !== -1) {
			dirs.add(`${f.slice(0, i)}/`);
			i = f.indexOf("/", i + 1);
		}
	}
	const all = [...dirs, ...files];
	fileCache.set(cwd, { at: Date.now(), files: all });
	return all;
}

function score(file, q) {
	if (!q) return file.split("/").length * 10 + file.length / 100;
	const lf = file.toLowerCase();
	const base = lf.slice(lf.lastIndexOf("/", lf.length - 2) + 1);
	if (base.startsWith(q)) return 0 + file.length / 1000;
	if (base.includes(q)) return 1 + file.length / 1000;
	if (lf.includes(q)) return 2 + file.length / 1000;
	// subsequence match
	let j = 0;
	for (let i = 0; i < lf.length && j < q.length; i++) if (lf[i] === q[j]) j++;
	if (j === q.length) return 3 + file.length / 1000;
	return null;
}

export async function searchFiles(cwd, query, limit = 50) {
	const files = await allFiles(cwd);
	const q = (query || "").toLowerCase().replace(/\\/g, "/");
	const scored = [];
	for (const f of files) {
		const s = score(f, q);
		if (s !== null) scored.push([s, f]);
	}
	scored.sort((a, b) => a[0] - b[0]);
	return scored.slice(0, limit).map(([, f]) => f);
}

async function windowsDrives() {
	const drives = [];
	for (let c = 67; c <= 90; c++) {
		const d = `${String.fromCharCode(c)}:\\`;
		if (existsSync(d)) drives.push(d);
	}
	return drives;
}

/** List subdirectories for the folder picker. Empty path → home (and drives on Windows). */
export async function listDirs(p) {
	const target = p ? path.resolve(p) : homedir();
	const st = await stat(target);
	if (!st.isDirectory()) throw new Error("폴더가 아닙니다");
	const entries = await readdir(target, { withFileTypes: true });
	const dirs = entries
		.filter((e) => e.isDirectory() && !e.name.startsWith("$") && e.name !== "System Volume Information")
		.map((e) => e.name)
		.sort((a, b) => {
			const ah = a.startsWith(".");
			const bh = b.startsWith(".");
			if (ah !== bh) return ah ? 1 : -1;
			return a.localeCompare(b);
		});
	const parent = path.dirname(target);
	return {
		path: target,
		parent: parent !== target ? parent : null,
		dirs,
		home: homedir(),
		drives: IS_WIN ? await windowsDrives() : [],
		sep: path.sep,
	};
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Validate a single folder-name segment. Returns the cleaned name or throws. */
export function validateDirName(raw) {
	const name = String(raw ?? "").trim();
	if (!name) throw new Error("폴더 이름을 입력하세요");
	if (name.length > 100) throw new Error("폴더 이름이 너무 깁니다 (100자 이하)");
	if (name === "." || name === "..") throw new Error("사용할 수 없는 이름입니다");
	if (/[\\/:*?"<>|\0-\x1f]/.test(name)) throw new Error('이름에 \\ / : * ? " < > | 문자는 쓸 수 없습니다');
	if (/[. ]$/.test(name)) throw new Error("이름은 점이나 공백으로 끝날 수 없습니다");
	if (WIN_RESERVED.test(name)) throw new Error("Windows 예약어는 폴더 이름으로 쓸 수 없습니다");
	return name;
}

/** Create a new folder `name` inside the existing folder `parent`. Returns the absolute path. */
export async function createDir(parent, name) {
	const clean = validateDirName(name);
	if (!parent) throw new Error("상위 폴더가 지정되지 않았습니다");
	const base = path.resolve(parent);
	let st;
	try {
		st = await stat(base);
	} catch {
		throw new Error("상위 폴더가 존재하지 않습니다");
	}
	if (!st.isDirectory()) throw new Error("상위 경로가 폴더가 아닙니다");
	const target = path.join(base, clean);
	try {
		await mkdir(target);
	} catch (err) {
		if (err.code === "EEXIST") throw new Error("같은 이름의 파일이나 폴더가 이미 있습니다");
		if (err.code === "EACCES" || err.code === "EPERM") throw new Error("이 위치에 폴더를 만들 권한이 없습니다");
		throw new Error(err.message);
	}
	return target;
}

/** Current git branch (or short commit) for a folder, walking up to the repository root. */
export async function gitBranch(cwd) {
	let dir = path.resolve(cwd);
	for (let i = 0; i < 40; i++) {
		const dotgit = path.join(dir, ".git");
		try {
			const st = await stat(dotgit);
			let gitDir = dotgit;
			if (st.isFile()) {
				const m = /gitdir:\s*(.+)/.exec(await readFile(dotgit, "utf8"));
				if (!m) return null;
				gitDir = path.resolve(dir, m[1].trim());
			}
			const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
			const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
			return ref ? ref[1] : head.slice(0, 8);
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}
