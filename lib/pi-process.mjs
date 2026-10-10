// One `pi --mode rpc` child process: strict JSONL framing, request/response correlation, event emission.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { buildSpawn } from "./pi-launcher.mjs";

const STDERR_LIMIT = 20_000;

export class PiProcess extends EventEmitter {
	constructor({ launcher, cwd, args = [], env = {} }) {
		super();
		this.launcher = launcher;
		this.cwd = cwd;
		this.args = args;
		this.env = env;
		this.child = null;
		this.pending = new Map();
		this.counter = 0;
		this.stderr = "";
		this.exited = null;
	}

	start() {
		const spec = buildSpawn(this.launcher, ["--mode", "rpc", ...this.args]);
		const child = spawn(spec.command, spec.args, {
			cwd: this.cwd,
			env: { ...process.env, ...this.env },
			stdio: ["pipe", "pipe", "pipe"],
			shell: spec.shell,
			windowsHide: true,
		});
		this.child = child;
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		child.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				this.#handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
				nl = buffer.indexOf("\n");
			}
		});
		child.stdout.on("end", () => {
			buffer += decoder.end();
			if (buffer.trim()) this.#handleLine(buffer);
			buffer = "";
		});
		child.stderr.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT);
		});
		child.stdin.on("error", () => {});
		const onExit = (info) => {
			if (this.exited) return;
			this.exited = { ...info, stderr: this.stderr };
			const err = new Error(info.error ?? `pi 프로세스가 종료되었습니다 (code=${info.code ?? "?"})`);
			for (const p of this.pending.values()) p.reject(err);
			this.pending.clear();
			this.emit("exit", this.exited);
		};
		child.once("exit", (code, signal) => onExit({ code, signal }));
		child.once("error", (error) => onExit({ code: null, signal: null, error: error.message }));
	}

	#handleLine(line) {
		if (!line.trim()) return;
		let data;
		try {
			data = JSON.parse(line);
		} catch {
			this.emit("stray", line);
			return;
		}
		if (data?.type === "response" && data.id && this.pending.has(data.id)) {
			const p = this.pending.get(data.id);
			this.pending.delete(data.id);
			p.resolve(data);
			return;
		}
		this.emit("record", data);
	}

	nextId() {
		return `w${++this.counter}`;
	}

	/** Send a command and wait for its response record. timeoutMs = 0 disables the timeout. */
	request(command, { id = this.nextId(), timeoutMs = 30_000 } = {}) {
		if (this.exited || !this.child) return Promise.reject(new Error("pi 프로세스가 실행 중이 아닙니다"));
		return new Promise((resolve, reject) => {
			let timer = null;
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`${command.type} 응답 시간 초과`));
				}, timeoutMs);
			}
			this.pending.set(id, {
				resolve: (r) => {
					if (timer) clearTimeout(timer);
					resolve(r);
				},
				reject: (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				},
			});
			this.write({ ...command, id });
		});
	}

	write(obj) {
		if (!this.child || this.exited) return false;
		try {
			return this.child.stdin.write(`${JSON.stringify(obj)}\n`);
		} catch {
			return false;
		}
	}

	/** Orderly shutdown: close stdin, then kill if it does not exit. */
	stop(graceMs = 4000) {
		if (!this.child || this.exited) return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => resolve();
			this.once("exit", done);
			try {
				this.child.stdin.end();
			} catch {}
			setTimeout(() => {
				if (!this.exited) {
					try {
						this.child.kill();
					} catch {}
				}
			}, graceMs).unref();
		});
	}
}
