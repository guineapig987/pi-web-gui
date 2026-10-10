// HTTP + SSE client for the pi-web gateway.

async function request(method, url, body) {
	const res = await fetch(url, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	let data = null;
	try {
		data = await res.json();
	} catch {}
	if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
	return data;
}

export const api = {
	info: () => request("GET", "/api/info"),
	projects: () => request("GET", "/api/projects").then((d) => d.projects),
	sessions: (cwd) => request("GET", `/api/sessions${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`).then((d) => d.sessions),
	allSessions: () => request("GET", "/api/sessions?limit=2000").then((d) => d.sessions),
	live: () => request("GET", "/api/live").then((d) => d.live),
	open: (cwd, sessionFile) => request("POST", "/api/live", { cwd, sessionFile }).then((d) => d.live),
	close: (id) => request("DELETE", `/api/live/${id}`),
	restart: (id) => request("POST", `/api/live/${id}/restart`).then((d) => d.live),
	files: (cwd, q) => request("GET", `/api/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`).then((d) => d.files),
	project: (cwd) => request("GET", `/api/project?cwd=${encodeURIComponent(cwd)}`),
	dirs: (path) => request("GET", `/api/dirs?path=${encodeURIComponent(path || "")}`),
	/** Native OS folder dialog on the gateway machine. → {path} | {cancelled:true}; throws Error with .unsupported when unavailable. */
	async pickNative(start, title) {
		const res = await fetch("/api/pick-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ start, title }) });
		let data = null;
		try {
			data = await res.json();
		} catch {}
		if (!res.ok) {
			const err = new Error(data?.error || `${res.status} ${res.statusText}`);
			err.unsupported = !!data?.unsupported || res.status === 403;
			throw err;
		}
		return data;
	},
	authStatus: () => request("GET", "/api/auth/status"),
	authLogin: (provider, type) => request("POST", "/api/auth/login", { provider, type }).then((d) => d.flow),
	authFlow: (id, since) => request("GET", `/api/auth/flows/${id}?since=${since || 0}`),
	authAnswer: (id, promptId, value) => request("POST", `/api/auth/flows/${id}/answer`, { promptId, value }),
	authCancel: (id) => request("DELETE", `/api/auth/flows/${id}`),
	authRecheck: () => request("POST", "/api/auth/recheck"),
	authTerminal: () => request("POST", "/api/auth/terminal"),
	authTerminalPoll: () => request("GET", "/api/auth/terminal"),
	authLogout: (provider) => request("POST", "/api/auth/logout", { provider }),
	piUpdate: (refresh = false) => request("GET", `/api/pi/update${refresh ? "?refresh=1" : ""}`),
	piChangelog: () => request("GET", "/api/pi/changelog"),
	piUpdateStart: (force = false) => request("POST", "/api/pi/update", { force }),
	settings: () => request("GET", "/api/settings"),
	saveSettings: (changes) => request("POST", "/api/settings", { changes }),
	/** Upload a file to the gateway machine → {path, name, size}. */
	async upload(file) {
		const res = await fetch("/api/upload", { method: "POST", headers: { "X-File-Name": encodeURIComponent(file.name || "file"), "Content-Type": "application/octet-stream" }, body: file });
		let data = null;
		try {
			data = await res.json();
		} catch {}
		if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
		return data;
	},
	mkdir: (parent, name) => request("POST", "/api/mkdir", { parent, name }).then((d) => d.path),
	ui: (id, payload) => request("POST", `/api/live/${id}/ui`, payload),
	/** Send an RPC command; resolves with data, rejects with the pi error message. */
	async command(id, cmd) {
		const res = await request("POST", `/api/live/${id}/command`, cmd);
		if (!res?.success) throw new Error(res?.error || `${cmd.type} 실패`);
		return res.data;
	},
};

/** Global stream: live session list + "sessions changed" pings. */
export function openGlobalStream({ onLive, onSessions, onState }) {
	const es = new EventSource("/api/stream");
	es.addEventListener("live", (e) => onLive(JSON.parse(e.data)));
	es.addEventListener("sessions", () => onSessions());
	es.onopen = () => onState?.(true);
	es.onerror = () => onState?.(false);
	return es;
}

/** Per-session stream. EventSource resends Last-Event-ID on reconnect, so the server can replay. */
export function openSessionStream(id, { onSnapshot, onEvent, onState }) {
	const es = new EventSource(`/api/live/${id}/stream`);
	es.addEventListener("snapshot", (e) => onSnapshot(JSON.parse(e.data)));
	es.addEventListener("ev", (e) => onEvent(JSON.parse(e.data)));
	es.onopen = () => onState?.(true);
	es.onerror = () => onState?.(false);
	return es;
}
