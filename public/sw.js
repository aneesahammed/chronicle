const CACHE_VERSION = "v1";
const CACHE_NAME = `chronicle-pwa-${CACHE_VERSION}`;
const APP_SHELL = [
  "/",
  "/index.html",
  "/daily/",
  "/daily/index.html",
  "/daily/index.json",
  "/feed.json",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];

function isCacheableResponse(response) {
  return Boolean(
    response &&
    response.ok &&
    response.status === 200 &&
    !response.redirected &&
    (response.type === "basic" || response.type === "default"),
  );
}

async function safeAdd(cache, url) {
  try {
    await cache.add(new Request(url, { cache: "reload" }));
  } catch (error) {
    console.warn("[chronicle-sw] precache skipped", url, error);
  }
}

async function putCache(request, response) {
  if (!isCacheableResponse(response)) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
}

async function remember(request, response) {
  try {
    await putCache(request, response);
  } catch (error) {
    console.warn("[chronicle-sw] cache write skipped", error);
  }
}

async function networkFirst(request, fallbackUrl = "/") {
  try {
    const response = await fetch(request);
    await remember(request, response);
    return response;
  } catch (_error) {
    const cached = await caches.match(request, { ignoreSearch: true });
    return cached || caches.match(fallbackUrl, { ignoreSearch: true });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;

  const response = await fetch(request);
  await remember(request, response);
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(APP_SHELL.map((url) => safeAdd(cache, url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("chronicle-pwa-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/index.html"));
    return;
  }

  if (url.pathname.endsWith(".json")) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
