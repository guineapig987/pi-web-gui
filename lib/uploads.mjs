// File attachments: the browser streams a file to the gateway, which stores it on this PC and returns the path.
// The path is then written into the prompt, so pi can open the file with its own read/bash tools.
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getAgentDir } from "./session-store.mjs";

export const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.PI_WEB_MAX_UPLOAD_MB || 100)) * 1024 * 1024;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function uploadsRoot() {
	return path.join(getAgentDir(), "web-uploads");
}

/** Keep only a safe file name: no folders, no characters Windows rejects, never empty. */
export function sanitizeFileName(raw) {
	let name = String(raw ?? "").split(/[\\/]/).pop() || "";
	name = name.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim();
	if (!name || name === "." || name === "..") name = "file";
	if (WIN_RESERVED.test(name)) name = `_${name}`;
	if (name.length > 120) {
		const ext = path.extname(name).slice(0, 20);
		name = name.slice(0, 120 - ext.length) + ext;
	}
	return name;
}

function stamp(d = new Date()) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Stream the request body into <agent dir>/web-uploads/<timestamp>-<id>/<name>.
 * @returns {{path: string, name: string, size: number}}
 */
export async function saveUpload(req, rawName, limit = MAX_UPLOAD_BYTES) {
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > limit) throw Object.assign(new Error(`파일이 너무 큽니다 (최대 ${Math.round(limit / 1024 / 1024)}MB)`), { status: 413 });
	const name = sanitizeFileName(rawName);
	const dir = path.join(uploadsRoot(), `${stamp()}-${randomBytes(3).toString("hex")}`);
	await mkdir(dir, { recursive: true });
	const target = path.join(dir, name);
	const tmp = `${target}.part`;
	let size = 0;
	const counter = new Transform({
		transform(chunk, _enc, cb) {
			size += chunk.length;
			if (size > limit) return cb(Object.assign(new Error(`파일이 너무 큽니다 (최대 ${Math.round(limit / 1024 / 1024)}MB)`), { status: 413 }));
			cb(null, chunk);
		},
	});
	try {
		await pipeline(req, counter, createWriteStream(tmp));
		await rename(tmp, target);
	} catch (err) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw err;
	}
	return { path: target, name, size };
}
