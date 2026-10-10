// Minimal service worker: makes the page installable. Nothing is cached, so the app is always live
// (it needs the pi-web server anyway).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
