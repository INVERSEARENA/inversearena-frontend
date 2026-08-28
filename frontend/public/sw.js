/* Inverse Arena service worker (#691).
 *
 * Minimal, dependency-free worker that:
 *  - precaches the app shell + offline fallback on install,
 *  - serves a custom /offline page when a navigation request fails (network
 *    drop mid-game) instead of the browser's default error,
 *  - uses cache-first for same-origin static assets so the shell loads fast.
 */
const CACHE = "inverse-arena-v1";
const OFFLINE_URL = "/offline";
const PRECACHE = ["/", OFFLINE_URL, "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Navigations: network-first, fall back to the offline page on failure.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error()))
    );
    return;
  }

  // Same-origin static assets only: cache-first, then network (and cache the result).
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    const isStaticAsset =
      url.pathname.startsWith("/_next/static/") ||
      url.pathname.startsWith("/icons/") ||
      url.pathname.startsWith("/images/") ||
      url.pathname.endsWith(".js") ||
      url.pathname.endsWith(".css") ||
      url.pathname.endsWith(".png") ||
      url.pathname.endsWith(".jpg") ||
      url.pathname.endsWith(".svg") ||
      url.pathname.endsWith(".ico") ||
      url.pathname.endsWith(".woff") ||
      url.pathname.endsWith(".woff2");

    if (isStaticAsset) {
      event.respondWith(
        caches.match(request).then(
          (cached) =>
            cached ||
            fetch(request).then((response) => {
              if (response.ok) {
                const copy = response.clone();
                caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
              }
              return response;
            })
        )
      );
    }
  }
});
