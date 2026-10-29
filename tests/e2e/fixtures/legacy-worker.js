// Reproduces the pre-fix worker: fresh HTML with mutable, cache-first JS/CSS.
const LEGACY_CACHE = "chronicle-shell-legacy-upgrade-test";
self.addEventListener("install", event => event.waitUntil((async () => {
  const cache = await caches.open(LEGACY_CACHE);
  await cache.put("/app.js", new Response('document.getElementById("readerMode").textContent = "Use card reader";', { headers: { "Content-Type": "text/javascript" } }));
  await cache.put("/app.css", new Response('#readerMode { width: auto; }', { headers: { "Content-Type": "text/css" } }));
  await self.skipWaiting();
})()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    if (event.request.mode === "navigate") return fetch(event.request);
    return (await (await caches.open(LEGACY_CACHE)).match(event.request, { ignoreSearch: true })) || fetch(event.request);
  })());
});
