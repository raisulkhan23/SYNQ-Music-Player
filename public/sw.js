/* eslint-disable */
/**
 * SYNQ service worker.
 *
 * Purpose: make the installed app OPEN and NAVIGATE with no network, and make
 * repeat launches fast. It deliberately does NOT try to make music work
 * offline — SYNQ streams from YouTube and has no offline-audio rights or
 * mechanism, so pretending otherwise would be the exact "fake feature" this
 * project avoids.
 *
 * ---------------------------------------------------------------------------
 * What is NEVER cached (and why)
 * ---------------------------------------------------------------------------
 * Anything that could leak one listener's data to another, or corrupt audio:
 *
 *  - Convex. The app's entire backend lives on *.convex.cloud over
 *    WebSockets + POST. Caching a query response would serve user A's
 *    playlists, history, likes or recommendations to user B on a shared
 *    device. Every non-GET and every cross-origin request is passed straight
 *    through, untouched.
 *  - Range requests. Audio/video streaming uses `Range`; a cached partial
 *    response replayed as a full one produces broken playback, so any request
 *    carrying a Range header bypasses the cache entirely.
 *  - /audio-proxy and anything under an API path.
 *
 * ---------------------------------------------------------------------------
 * Cache strategies
 * ---------------------------------------------------------------------------
 *  - Navigations      → network-first, falling back to the cached shell.
 *                       Fresh code wins, but a deep link opened offline still
 *                       renders the SPA instead of a browser error page.
 *  - Hashed assets    → cache-first. `/assets/*.js|css` are content-hashed by
 *                       the build, so a URL match is guaranteed to be the right
 *                       bytes. This is the fast-launch win.
 *  - Images           → cache-first, LRU-capped, so artwork the listener has
 *                       already seen stays visible offline without the cache
 *                       growing without bound.
 *  - Everything else  → network, no cache.
 */

const VERSION = "v1";
const SHELL_CACHE = `synq-shell-${VERSION}`;
const ASSET_CACHE = `synq-assets-${VERSION}`;
const IMAGE_CACHE = `synq-images-${VERSION}`;
const CACHE_NAMES = [SHELL_CACHE, ASSET_CACHE, IMAGE_CACHE];

/**
 * The precache list is deliberately tiny. SYNQ's JS bundle is large, and
 * eagerly downloading it on install is exactly how a PWA makes an app feel
 * slower. Instead only the entry document and the brand assets are precached;
 * the JS/CSS the browser asks for on first paint are cached on the way past by
 * the hashed-asset handler, which is the same work with none of the guessing.
 */
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/logo.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

/** Hostnames whose responses are never written to or read from a cache. */
const BYPASS_HOSTS = [
  "convex.cloud",
  "convex.site",
  "youtube.com",
  "youtu.be",
  "googlevideo.com",
  "ytimg.com",
  "ggpht.com",
  "googleapis.com",
  "gstatic.com",
];

/** Path fragments that must never be cached, even on our own origin. */
const BYPASS_PATHS = ["/api/", "/audio-proxy", "/.convex", "/socket"];

/** Cap the image cache so long sessions cannot grow it without bound. */
const MAX_IMAGE_ENTRIES = 220;

/** Cap the hashed-asset cache. */
const MAX_ASSET_ENTRIES = 160;

/** @param {string} hostname */
function isBypassedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return BYPASS_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

/** @param {string} pathname */
function isBypassedPath(pathname) {
  return BYPASS_PATHS.some((p) => pathname.startsWith(p));
}

/**
 * Decide whether a request may touch a cache at all.
 * Anything not on the same origin as the page is never ours to store, and
 * authenticated GETs are still left alone: SYNQ's identity lives in cookies
 * and WebSocket sessions, and a cached response is served to whoever opens the
 * app next. Same-origin app assets only — never an API payload.
 *
 * @param {Request} request
 * @param {string} origin
 */
function isCacheable(request, origin) {
  if (request.method !== "GET") return false;
  // Range requests are how audio/video streaming seeks; replaying a partial
  // response from cache yields broken playback.
  if (request.headers.has("range")) return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (isBypassedHost(url.hostname)) return false;
  if (isBypassedPath(url.pathname)) return false;
  // Anything that looks like a data call, not a file.
  if (url.pathname.startsWith("/api/") || url.searchParams.has("__data")) {
    return false;
  }
  return true;
}

/** @param {string} pathname */
function isHashedAsset(pathname) {
  return (
    pathname.startsWith("/assets/") ||
    /\.(?:js|css|woff2?|ttf|otf)$/.test(pathname)
  );
}

/** @param {string} pathname */
function isImage(pathname) {
  return /\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/.test(pathname);
}

/**
 * Delete the oldest entries once a cache exceeds its cap.
 * @param {string} cacheName
 * @param {number} max
 */
async function trimCache(cacheName, max) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= max) return;
    // Cache keys preserve insertion order, so the front is the oldest.
    const excess = keys.slice(0, keys.length - max);
    await Promise.all(excess.map((k) => cache.delete(k)));
  } catch {
    /* a full disk must never break navigation */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll is atomic: one 404 would reject the whole install and leave the
      // worker permanently uninstalled. Add individually so a single missing
      // icon cannot disable offline support entirely.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "reload" });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* offline at install time is fine */
          }
        }),
      );
      // NOTE: deliberately NOT calling skipWaiting() here. Activating a new
      // worker mid-session would swap the code under a listener who is playing
      // music. The page asks for it explicitly, and only at a safe moment.
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older versions so the app shell can never be served
      // stale, and so storage does not grow without bound.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("synq-") && !CACHE_NAMES.includes(n))
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

/** @param {Request} request */
async function cacheFirst(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) {
    return hit;
  }
  const res = await fetch(request);
  // Only store complete, successful, same-origin responses. `opaque` responses
  // (no CORS) are deliberately skipped: their size is unknowable, so they
  // cannot be trimmed and would grow the cache silently.
  if (res.ok && res.type === "basic") {
    await cache.put(request, res.clone());
    if (max) void trimCache(cacheName, max);
  }
  return res;
}

/** @param {Request} request */
async function staleWhileRevalidate(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok && res.type === "basic") {
        void cache.put(request, res.clone());
        if (max) void trimCache(cacheName, max);
      }
      return res;
    })
    .catch(() => null);
  if (hit) {
    // Refresh in the background; answer immediately from cache.
    void network;
    return hit;
  }
  const res = await network;
  if (res) return res;
  return new Response("", { status: 504, statusText: "Offline" });
}

/**
 * Navigations are network-first so a deployed change is picked up immediately,
 * with the cached shell as the offline fallback. Without this, refreshing
 * /playlist/123 in the installed app would show a browser error page.
 * @param {Request} request
 */
async function handleNavigation(request) {
  const shell = async () => {
    const cache = await caches.open(SHELL_CACHE);
    return (
      (await cache.match("/")) || (await cache.match("/index.html")) || null
    );
  };

  const offlinePage = () =>
    new Response(
      "<!doctype html><meta charset=utf-8><title>SYNQ</title>" +
        "<body style='font-family:system-ui;background:#12141c;color:#f4f5f7;" +
        "display:grid;place-items:center;height:100vh;margin:0;text-align:center'>" +
        "<div><h1 style='font-size:20px;margin:0 0 8px'>You're offline</h1>" +
        "<p style='color:#8a90a6;margin:0'>SYNQ needs a connection the first " +
        "time it opens. Reconnect and try again.</p></div>",
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );

  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      // Cache the document, not the request URL: /home and /playlist/1 both
      // serve the same index.html, and caching each path separately would fill
      // the cache with near-identical copies of the shell.
      void cache.put("/", res.clone());
      return res;
    }
    // A 404 on a deep link means the host has no SPA rewrite, not that the
    // route is gone — SYNQ routes entirely client-side. Serving the cached
    // shell is what stops `refresh` on /playlist/123 from showing a browser
    // error page in the installed app.
    if (res.status === 404 || res.status >= 500) {
      const cached = await shell();
      if (cached) return cached;
    }
    return res;
  } catch {
    return (await shell()) ?? offlinePage();
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  const origin = self.location.origin;

  // Cross-origin traffic (Convex, YouTube, artwork CDNs, fonts) is never
  // cached. SYNQ's whole backend is cross-origin, so this is what keeps one
  // listener's private data out of a shared cache.
  if (url.origin !== origin || isBypassedHost(url.hostname)) return;
  if (isBypassedPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (!isCacheable(request, origin)) return;

  if (isHashedAsset(url.pathname)) {
    event.respondWith(
      cacheFirst(request, ASSET_CACHE, MAX_ASSET_ENTRIES).catch(
        () => fetch(request),
      ),
    );
    return;
  }

  if (isImage(url.pathname)) {
    event.respondWith(
      staleWhileRevalidate(request, IMAGE_CACHE, MAX_IMAGE_ENTRIES).catch(
        () => fetch(request),
      ),
    );
  }
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "SKIP_WAITING") {
    // Asked for by the page, which only does so when the listener is not
    // mid-song. Never triggered automatically.
    void self.skipWaiting();
    return;
  }

  if (data.type === "GET_VERSION") {
    event.ports &&
      event.ports[0] &&
      event.ports[0].postMessage({ type: "VERSION", version: VERSION });
  }
});