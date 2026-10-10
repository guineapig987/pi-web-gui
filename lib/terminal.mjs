// Opens a visible terminal window running pi (used for subscription login when pi's library is not reachable).
// The window belongs to the user's own desktop, so this only works when the gateway runs on that computer.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSpawn } from "./pi-launcher.mjs";

function winQuote(s) {
	return `"${String(s).replace(/"/g, '""')}"`;
}

export function terminalSupported() {
	return process.platform === "win32" || process.platform === "darwin";
}

/** @returns {Promise<void>} resolves once the terminal process was started */
export function openPiTerminal(launcher, cwd) {
	return new Promise((resolve, reject) => {
		if (!launcher || launcher.error) return reject(new Error(launcher?.error || "pi를 찾지 못했습니다"));
		const sp = buildSpawn(launcher, []);
		const dir = path.join(tmpdir(), "pi-web");
		mkdirSync(dir, { recursive: true });
		let child;
		if (process.platform === "win32") {
			const command = sp.shell ? sp.command : [sp.command, ...sp.args].map(winQuote).join(" ");
			const bat = path.join(dir, "pi-login.cmd");
			writeFileSync(bat, `@echo off\r\nchcp 65001 >nul\r\ncd /d ${winQuote(cwd)}\r\necho pi 에서 /login 을 입력하고 공급자를 선택하세요. 끝나면 이 창을 닫아도 됩니다.\r\n${command}\r\n`);
			child = spawn("cmd.exe", ["/c", "start", "pi login", "cmd.exe", "/k", bat], { cwd, detached: true, stdio: "ignore", windowsHide: false });
		} else if (process.platform === "darwin") {
			const sh = path.join(dir, "pi-login.command");
			const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
			writeFileSync(sh, `#!/bin/bash\ncd ${q(cwd)}\necho 'pi 에서 /login 을 입력하고 공급자를 선택하세요.'\n${[sp.command, ...sp.args].map(q).join(" ")}\n`, { mode: 0o755 });
			child = spawn("open", ["-a", "Terminal", sh], { detached: true, stdio: "ignore" });
		} else {
			return reject(Object.assign(new Error("이 운영체제에서는 터미널 창을 자동으로 열 수 없습니다. 터미널에서 pi를 실행해 /login 을 입력하세요."), { code: "UNSUPPORTED" }));
		}
		child.on("error", reject);
		child.unref();
		setTimeout(resolve, 300);
	});
}
