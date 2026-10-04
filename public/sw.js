// Service worker : l'app fonctionne hors ligne après la première visite.
const CACHE = "murattil-v2";
const CORE = ["./", "./index.html", "./quran.json", "./zipformer_quran.json", "./models/zipformer_a0w_ep1_a05.io.json", "./audio-processor.js", "./manifest.webmanifest", "./icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => undefined).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", (e) => {
  if (e.data?.type === "cache") {
    e.waitUntil(caches.open(CACHE).then((c) => Promise.all(e.data.urls.map((u) => c.add(u).catch(() => undefined)))));
  }
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  if (req.url.endsWith(".onnx")) return; // le modèle vit dans IndexedDB
  // Réseau d'abord pour la page (mises à jour), cache d'abord pour le reste.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; }).catch(() => caches.match(req.url, { ignoreVary: true }).then((r) => r || caches.match("./index.html", { ignoreVary: true }))));
    return;
  }
  e.respondWith(caches.match(req.url, { ignoreVary: true, ignoreSearch: false }).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return r;
  })));
});
