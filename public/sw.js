// Scoped to /app/ — the desktop dashboard at /dashboard is deliberately NOT
// controlled by this worker and keeps its normal server-rendered behaviour.
const VERSION = "v1";
const SHELL_CACHE = `trinity-shell-${VERSION}`;
const DATA_CACHE = `trinity-data-${VERSION}`;

const SHELL = ["/app/today", "/app/schedule", "/app/customers", "/app/money", "/app/dispatch"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Individually, not addAll: addAll rejects the whole install if any one
      // request fails, which would leave the app with no worker at all.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/app/")) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (url.pathname.startsWith("/app/")) {
    event.respondWith(networkFirstShell(request));
  }
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(DATA_CACHE);

  try {
    const fresh = await fetch(request);
    // Never cache a 401 — a signed-out reply must not become the screen's
    // permanent "data".
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (!cached) throw new Error("offline and uncached");

    // Tell the UI this is stale so FreshnessStamp can say "Offline — showing
    // data from 8:42a" instead of implying the data is current.
    const headers = new Headers(cached.headers);
    headers.set("X-Trinity-Cache", "hit");
    return new Response(await cached.blob(), {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Last resort: any cached tab beats a browser error page.
    return (await cache.match("/app/today")) ?? Response.error();
  }
}
