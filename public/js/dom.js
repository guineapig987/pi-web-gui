// Tiny DOM helpers.

/**
 * h("div.cls#id", {attrs, onclick, style}, ...children)
 * Children may be strings, nodes, arrays, null/false (skipped).
 */
export function h(spec, props, ...children) {
	let tag = "div";
	const classes = [];
	let id = null;
	const re = /([.#]?)([^.#]+)/g;
	let m;
	let first = true;
	while ((m = re.exec(spec))) {
		if (m[1] === "") {
			if (first) tag = m[2];
		} else if (m[1] === ".") classes.push(m[2]);
		else id = m[2];
		first = false;
	}
	const el = document.createElement(tag);
	if (classes.length) el.className = classes.join(" ");
	if (id) el.id = id;
	if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
		children.unshift(props);
		props = null;
	}
	if (props) {
		for (const [k, v] of Object.entries(props)) {
			if (v === undefined || v === null || v === false) continue;
			if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
			else if (k === "class") el.className = el.className ? `${el.className} ${v}` : v;
			else if (k === "style" && typeof v === "object") {
				for (const [sk, sv] of Object.entries(v)) {
					if (sk.startsWith("--")) el.style.setProperty(sk, sv);
					else el.style[sk] = sv;
				}
			}
			else if (k === "html") el.innerHTML = v;
			else if (k === "dataset") Object.assign(el.dataset, v);
			else if (k in el && typeof v !== "string") el[k] = v;
			else el.setAttribute(k, v === true ? "" : String(v));
		}
	}
	append(el, children);
	// icon-only buttons: expose the tooltip text as the accessible name
	if (tag === "button" && !el.hasAttribute("aria-label") && el.title && !el.textContent.trim()) el.setAttribute("aria-label", el.title);
	return el;
}

export function append(el, children) {
	for (const c of children) {
		if (c === null || c === undefined || c === false || c === true) continue;
		if (Array.isArray(c)) append(el, c);
		else if (c instanceof Node) el.appendChild(c);
		else el.appendChild(document.createTextNode(String(c)));
	}
	return el;
}

export function setChildren(el, ...children) {
	clear(el);
	return append(el, children);
}

export function clear(el) {
	while (el.firstChild) el.removeChild(el.firstChild);
	return el;
}

const ICONS = {
	user: '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>',
	settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
	key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M16 7l3 3M14 9l2 2"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
	stopFill: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
	home: '<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/>',
	review: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
	command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
	git: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8M18 11c0 4-6 3-11 5"/>',
	clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
	send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
	stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
	clip: '<path d="m20 11-8.6 8.6a5 5 0 0 1-7.1-7.1L13 3.8a3.3 3.3 0 0 1 4.7 4.7l-8.7 8.6a1.7 1.7 0 0 1-2.4-2.4L14.5 7"/>',
	image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
	folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
	chevron: '<path d="m9 6 6 6-6 6"/>',
	chevronDown: '<path d="m6 9 6 6 6-6"/>',
	more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
	x: '<path d="M6 6l12 12M18 6 6 18"/>',
	check: '<path d="m5 12 5 5 9-10"/>',
	alert: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
	terminal: '<path d="m5 8 4 4-4 4M12 16h7"/>',
	file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
	edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
	search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
	copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
	brain: '<path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V4.5A2.5 2.5 0 0 0 9 4zM15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
	tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
	sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
	moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
	bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
	branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/>',
	refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
	sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
};

export function icon(name, cls = "") {
	const span = document.createElement("span");
	span.className = `icon ${cls}`.trim();
	span.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
	return span;
}
