const CACHE_VERSION = "v7";
const CACHE_PREFIX = "chronicle-";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${CACHE_VERSION}`;
const MAX_RUNTIME_ENTRIES = 160;
const APP_SHELL = [
  "/",
  "/index.html",
  "/daily/",
  "/daily/index.html",
  "/daily/index.json",
  "/feed.json",
  "/rss.xml",
  "/atom.xml",
  "/feed.schema.json",
  "/manifest.webmanifest",
  "/mobile-reader-state.js",
  "/sw-register.js",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
  "/fonts/fonts.css",
  "/fonts/atkinson-hyperlegible-next-latin.woff2",
  "/fonts/public-sans-400-latin.woff2",
  "/fonts/ibm-plex-mono-400-latin.woff2",
  "/fonts/ibm-plex-mono-500-latin.woff2",
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

async function trimRuntimeCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_RUNTIME_ENTRIES) return;
  await Promise.all(keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES).map((request) => cache.delete(request)));
}

async function rememberRuntime(request, response) {
  try {
    if (!isCacheableResponse(response)) return;
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(request, response.clone());
    await trimRuntimeCache(cache);
  } catch (error) {
    console.warn("[chronicle-sw] cache write skipped", error);
  }
}

async function matchRuntimeThenShell(request, fallbackUrl) {
  const runtime = await caches.open(RUNTIME_CACHE);
  const runtimeHit = await runtime.match(request, { ignoreSearch: true });
  if (runtimeHit) return runtimeHit;

  const shell = await caches.open(SHELL_CACHE);
  const shellHit = await shell.match(request, { ignoreSearch: true });
  if (shellHit) return shellHit;
  return fallbackUrl ? shell.match(fallbackUrl, { ignoreSearch: true }) : undefined;
}

async function matchShellThenRuntime(request) {
  const shell = await caches.open(SHELL_CACHE);
  const shellHit = await shell.match(request, { ignoreSearch: true });
  if (shellHit) return shellHit;

  const runtime = await caches.open(RUNTIME_CACHE);
  return runtime.match(request, { ignoreSearch: true });
}

async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    await rememberRuntime(request, response);
    return response;
  } catch (_error) {
    const cached = await matchRuntimeThenShell(request, fallbackUrl);
    return cached || new Response("Offline", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function cacheFirst(request) {
  const cached = await matchShellThenRuntime(request);
  if (cached) return cached;

  const response = await fetch(request);
  await rememberRuntime(request, response);
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(APP_SHELL.map((url) => safeAdd(cache, url)));
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
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

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
