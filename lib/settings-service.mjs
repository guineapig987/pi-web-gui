// Settings panel backend: edits a curated set of pi settings in the global settings.json (agent dir).
// Unknown keys and everything not listed are left exactly as they are; the file is rewritten atomically.
// Project-level `.pi/settings.json` overrides are not edited here.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "./session-store.mjs";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/**
 * type: bool | enum | int | string | tools
 * live: RPC command that applies the value to a running session ({type, <field>: value})
 */
export const FIELDS = [
	{ key: "defaultThinkingLevel", group: "모델과 생각", label: "기본 생각 수준", type: "enum", options: THINKING, default: "medium", help: "새 세션의 시작 생각 수준" },
	{ key: "hideThinkingBlock", group: "모델과 생각", label: "생각 블록 숨기기", type: "bool", default: false, help: "pi의 생각 블록 표시 설정. 이 웹 화면은 생각을 항상 접어서 보여줍니다" },
	{ key: "showCacheMissNotices", group: "모델과 생각", label: "캐시 미스 알림", type: "bool", default: false, help: "프롬프트 캐시가 크게 빗나갔을 때 알립니다" },
	{ key: "cacheWarming", group: "모델과 생각", label: "캐시 유지", type: "enum", options: ["off", "streaming", "idle"], default: "streaming", help: "streaming: 작업 중에만, idle: 작업 사이에도 프롬프트 캐시를 유지" },

	{ key: "steeringMode", group: "대기열", label: "끼어들기 전달 방식", type: "enum", options: ["one-at-a-time", "all"], labels: { "one-at-a-time": "턴마다 하나씩", all: "한꺼번에" }, default: "one-at-a-time", live: "set_steering_mode", help: "작업 중 보낸 끼어들기 메시지를 어떻게 전달할지" },
	{ key: "followUpMode", group: "대기열", label: "끝난 뒤 전달 방식", type: "enum", options: ["one-at-a-time", "all"], labels: { "one-at-a-time": "하나씩", all: "한꺼번에" }, default: "one-at-a-time", live: "set_follow_up_mode", help: "작업이 끝난 뒤 보낼 메시지를 어떻게 전달할지" },

	{ key: "compaction.enabled", group: "컨텍스트 압축", label: "자동 압축", type: "bool", default: true, live: "set_auto_compaction", help: "컨텍스트가 가득 차면 자동으로 압축" },
	{ key: "compaction.reserveTokens", group: "컨텍스트 압축", label: "응답용 여유 토큰", type: "int", min: 0, default: 16384, help: "모델 응답을 위해 남겨 두는 토큰 수" },
	{ key: "compaction.keepRecentTokens", group: "컨텍스트 압축", label: "최근 유지 토큰", type: "int", min: 0, default: 20000, help: "요약하지 않고 그대로 남기는 최근 토큰 수" },

	{ key: "retry.enabled", group: "자동 재시도", label: "자동 재시도", type: "bool", default: true, live: "set_auto_retry", help: "일시적인 오류(과부하·네트워크)에서 자동으로 다시 시도" },
	{ key: "retry.maxRetries", group: "자동 재시도", label: "최대 재시도 횟수", type: "int", min: 0, max: 20, default: 3 },
	{ key: "retry.baseDelayMs", group: "자동 재시도", label: "첫 대기 시간 (ms)", type: "int", min: 0, default: 2000, help: "2배씩 늘어나며 다시 시도합니다" },

	{ key: "defaultTools", group: "도구", label: "기본 도구", type: "tools", options: TOOLS, help: "새 세션에서 켜 둘 도구. 선택하지 않으면 pi 기본값(read, bash, edit, write)" },
	{ key: "shellPath", group: "도구", label: "셸 경로", type: "string", help: "bash 도구가 쓸 셸 실행 파일 (비우면 자동)" },
	{ key: "enableSkillCommands", group: "도구", label: "스킬 명령 (/skill:이름)", type: "bool", default: true },

	{ key: "images.autoResize", group: "이미지", label: "이미지 자동 축소", type: "bool", default: true, help: "큰 이미지를 모델에 보내기 전에 줄입니다" },
	{ key: "images.blockImages", group: "이미지", label: "이미지 전송 차단", type: "bool", default: false },

	{ key: "defaultProjectTrust", group: "보안·네트워크", label: "프로젝트 신뢰 기본값", type: "enum", options: ["ask", "always", "never"], labels: { ask: "묻기", always: "항상 신뢰", never: "신뢰 안 함" }, default: "ask", help: "프로젝트의 .pi/ 확장·설정을 불러올지 정하는 기본 동작" },
	{ key: "httpProxy", group: "보안·네트워크", label: "HTTP 프록시", type: "string", help: "예: http://127.0.0.1:7890" },
	{ key: "warnings.anthropicExtraUsage", group: "보안·네트워크", label: "Anthropic 추가 사용량 경고", type: "bool", default: true },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

export function settingsPath() {
	return path.join(getAgentDir(), "settings.json");
}

function readFileObject() {
	const file = settingsPath();
	if (!existsSync(file)) return { exists: false, data: {} };
	const text = readFileSync(file, "utf8").replace(/^﻿/, "");
	if (!text.trim()) return { exists: true, data: {} };
	let data;
	try {
		data = JSON.parse(text);
	} catch (err) {
		throw Object.assign(new Error(`settings.json을 읽을 수 없습니다 (${err.message}). 파일을 직접 고친 뒤 다시 시도하세요.`), { status: 409 });
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw Object.assign(new Error("settings.json의 최상위가 객체가 아닙니다"), { status: 409 });
	return { exists: true, data };
}

function getPath(obj, key) {
	let cur = obj;
	for (const part of key.split(".")) {
		if (!cur || typeof cur !== "object" || !(part in cur)) return undefined;
		cur = cur[part];
	}
	return cur;
}

function setPath(obj, key, value) {
	const parts = key.split(".");
	let cur = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		if (!cur[parts[i]] || typeof cur[parts[i]] !== "object" || Array.isArray(cur[parts[i]])) cur[parts[i]] = {};
		cur = cur[parts[i]];
	}
	cur[parts[parts.length - 1]] = value;
}

function deletePath(obj, key) {
	const parts = key.split(".");
	const stack = [];
	let cur = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		if (!cur || typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) return;
		stack.push([cur, parts[i]]);
		cur = cur[parts[i]];
	}
	delete cur[parts[parts.length - 1]];
	// drop containers that became empty
	for (let i = stack.length - 1; i >= 0; i--) {
		const [parent, name] = stack[i];
		if (Object.keys(parent[name]).length === 0) delete parent[name];
		else break;
	}
}

function coerce(field, value) {
	switch (field.type) {
		case "bool":
			if (typeof value !== "boolean") throw new Error(`${field.label}: true/false 값이 필요합니다`);
			return value;
		case "enum":
			if (!field.options.includes(value)) throw new Error(`${field.label}: 허용되지 않는 값입니다`);
			return value;
		case "int": {
			if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${field.label}: 정수가 필요합니다`);
			if (field.min !== undefined && value < field.min) throw new Error(`${field.label}: ${field.min} 이상이어야 합니다`);
			if (field.max !== undefined && value > field.max) throw new Error(`${field.label}: ${field.max} 이하여야 합니다`);
			return value;
		}
		case "string": {
			if (typeof value !== "string") throw new Error(`${field.label}: 문자열이 필요합니다`);
			const v = value.trim();
			if (v.length > 1000) throw new Error(`${field.label}: 너무 깁니다`);
			return v;
		}
		case "tools": {
			if (!Array.isArray(value) || value.some((t) => !field.options.includes(t))) throw new Error(`${field.label}: 알 수 없는 도구가 있습니다`);
			return [...new Set(value)];
		}
		default:
			throw new Error("알 수 없는 설정 형식");
	}
}

/** Current values of the curated keys that are explicitly set in settings.json. */
export function readSettings() {
	const { exists, data } = readFileObject();
	const values = {};
	for (const f of FIELDS) {
		const v = getPath(data, f.key);
		if (v !== undefined) values[f.key] = v;
	}
	return { path: settingsPath(), exists, fields: FIELDS, values };
}

/** changes: { key: value | null } — null removes the key (back to pi's default). */
export function writeSettings(changes) {
	if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw Object.assign(new Error("변경 내용이 올바르지 않습니다"), { status: 400 });
	const entries = Object.entries(changes);
	if (!entries.length) return readSettings();
	const prepared = [];
	for (const [key, value] of entries) {
		const field = BY_KEY.get(key);
		if (!field) throw Object.assign(new Error(`수정할 수 없는 설정입니다: ${key}`), { status: 400 });
		try {
			prepared.push([key, value === null || (field.type === "string" && value === "") || (field.type === "tools" && Array.isArray(value) && value.length === 0) ? null : coerce(field, value)]);
		} catch (err) {
			throw Object.assign(err, { status: 400 });
		}
	}
	const { data } = readFileObject();
	for (const [key, value] of prepared) {
		if (value === null) deletePath(data, key);
		else setPath(data, key, value);
	}
	const file = settingsPath();
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(tmp, file);
	return readSettings();
}
