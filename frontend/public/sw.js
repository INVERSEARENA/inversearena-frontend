/* Inverse Arena service worker (#691, #1571).
 *
 * Minimal, dependency-free worker that:
 *  - precaches the app shell + offline fallback on install,
 *  - serves a custom /offline page when a navigation request fails (network
 *    drop mid-game) instead of the browser's default error,
 *  - uses cache-first for same-origin static assets so the shell loads fast,
 *  - receives Web Push round-phase alerts (#1571) with click-through deep
 *    links to the arena.
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

// ── Web Push round-phase alerts (#1571) ──────────────────────────────
// Payloads are RFC 8291 `aes128gcm` encrypted by the backend push service and
// decrypted by the browser before delivery, so `event.data` is already the
// JSON `{ title, body, url, tag }` scheduled per round phase.
const PUSH_DEFAULT_URL = "/arena";
const PUSH_ICON = "/icons/icon-192.png";

function readPushPayload(event) {
  if (!event.data) return null;
  try {
    return event.data.json();
  } catch {
    return { title: "Inverse Arena", body: event.data.text(), url: PUSH_DEFAULT_URL };
  }
}

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event) || {};
  const title = payload.title || "Inverse Arena";
  const url = typeof payload.url === "string" ? payload.url : PUSH_DEFAULT_URL;
  const tag = typeof payload.tag === "string" ? payload.tag : "inverse-arena";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "A round phase just changed.",
      icon: PUSH_ICON,
      badge: PUSH_ICON,
      tag,
      renotify: true,
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl = event.notification.data && event.notification.data.url;
  const url = typeof rawUrl === "string" ? rawUrl : PUSH_DEFAULT_URL;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            try {
              const target = new URL(url, self.location.origin).href;
              if (client.url === target) return client.focus();
            } catch {
              // Fall through to opening a fresh window below.
            }
          }
        }
        return self.clients.openWindow(url);
      })
  );
});
