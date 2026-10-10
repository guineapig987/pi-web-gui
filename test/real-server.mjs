// Starts pi-web against the REAL pi for manual / browser testing, without touching your own sessions or projects.
//   node test/real-server.mjs [--port 8791]
// Your pi login (~/.pi/agent) is used; test sessions and the work folder live in a temp folder that is removed on exit.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--port");
const port = i > 0 ? process.argv[i + 1] : process.env.PI_WEB_TEST_PORT || "8791";

const tmp = mkdtempSync(path.join(tmpdir(), "piweb-real-"));
const work = path.join(tmp, "work");
mkdirSync(work);
writeFileSync(path.join(work, "README.md"), "# 테스트 프로젝트\n\n진짜 pi 테스트용 임시 폴더입니다.\n");
writeFileSync(path.join(work, "hello.js"), 'console.log("hello");\n');

const env = { ...process.env, PI_CODING_AGENT_SESSION_DIR: path.join(tmp, "sessions"), PI_WEB_DEFAULT_DIR: work };
delete env.PI_CLI;
const child = spawn(process.execPath, [path.join(ROOT, "server.mjs"), "--port", port, "--cwd", work], { env, stdio: "inherit" });

let cleaned = false;
function cleanup() {
	if (cleaned) return;
	cleaned = true;
	child.kill();
	setTimeout(() => {
		rmSync(tmp, { recursive: true, force: true });
		process.exit(0);
	}, 500);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
child.on("exit", () => cleanup());
console.log(`[real-server] 테스트 폴더: ${work} (종료하면 삭제됩니다)`);
