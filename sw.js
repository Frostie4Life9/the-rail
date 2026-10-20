// The Rail service worker: app shell + tiles offline. GitHub API calls always go to the network.
const VERSION = "2.1.1";
const SHELL = `rail-shell-${VERSION}`;
const ASSETS = ["./", "index.html", "manifest.webmanifest", "icons/rail-192.png", "icons/rail-512.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("rail-shell-") && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.hostname === "api.github.com") return;
  if (u.origin === location.origin && u.pathname.includes("/tiles/")) {           // tiles: cache first, they never change
    e.respondWith(caches.open("rail-tiles").then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (u.origin === location.origin || u.hostname.endsWith("gstatic.com") || u.hostname.endsWith("googleapis.com")) {
    // shell: network first so updates land, cache when offline
    e.respondWith(fetch(e.request).then(r => { if (r.ok) caches.open(SHELL).then(c => c.put(e.request, r.clone())); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
  }
});
