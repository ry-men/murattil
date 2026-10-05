// Service worker : l'app fonctionne hors ligne après la première visite.
const CACHE = "murattil-v11";
const CORE = ["./", "./index.html", "./config.json", "./quran.json", "./zipformer_quran.json", "./models/zipformer_a0w_ep1_a05.io.json", "./audio-processor.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

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
// Isolation cross-origin (COOP + COEP credentialless) : permet le multi-thread WebAssembly
// (SharedArrayBuffer) pour le modèle mini, sans en-têtes côté hébergeur (GitHub Pages n'en permet pas).
function isolate(r) {
  if (!r || r.type === "opaque" || r.status === 0) return r;
  const h = new Headers(r.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "credentialless");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  if (req.url.endsWith(".onnx") || /\.part\d+$/.test(req.url)) return; // les modèles vivent dans IndexedDB
  // Réseau d'abord pour la page (mises à jour), cache d'abord pour le reste.
  if (req.mode === "navigate" || req.url.endsWith("/config.json") || req.url.endsWith("/muaalem_mini.parts.json")) {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; }).catch(() => caches.match(req.url, { ignoreVary: true }).then((r) => r || caches.match("./index.html", { ignoreVary: true }))).then(isolate));
    return;
  }
  e.respondWith(caches.match(req.url, { ignoreVary: true, ignoreSearch: false }).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return r;
  })).then(isolate));
});
