// Scoped to /app/ — the desktop dashboard at /dashboard is deliberately NOT
// controlled by this worker and keeps its normal server-rendered behaviour.
const VERSION = "v1";
const SHELL_CACHE = `trinity-shell-${VERSION}`;
const DATA_CACHE = `trinity-data-${VERSION}`;

const SHELL = ["/app/today", "/app/schedule", "/app/customers", "/app/money", "/app/dispatch"];
// Not under /app/, so src/middleware.ts's matcher ("/app/:path*") never
// intercepts it — the one shell URL that's safe to precache unconditionally.
const OFFLINE_URL = "/app-offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Individually, not addAll: addAll rejects the whole install if any one
      // request fails, which would leave the app with no worker at all.
      .then((cache) =>
        Promise.allSettled([...SHELL, OFFLINE_URL].map((url) => precache(cache, url)))
      )
      .then(() => self.skipWaiting())
  );
});

// A signed-out visitor's install runs against a browser that middleware 307s
// to /app/login for every /app/* path except login itself. fetch()'s default
// redirect mode is "follow", so a naive cache.add() would silently store the
// login page's HTML keyed under e.g. "/app/schedule" -- every offline tap on
// that tab would then show the login screen forever, with no way for a
// non-technical user to clear it. A response is only the page that was asked
// for if the browser did not have to follow a redirect to get it.
async function precache(cache, url) {
  const response = await fetch(url);
  if (response.ok && !response.redirected) await cache.put(url, response);
}

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
    // Same redirect trap as precache(), reachable here too: a session that
    // expires mid-use gets this exact request 307'd to /app/login by
    // middleware.ts, and fetch() follows it -- fresh.ok would be true, but
    // it would be the login page's HTML, not this shell URL's.
    if (fresh.ok && !fresh.redirected) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // This route was never cached, so there is nothing of its own to show.
    // Falling back to another tab's cached page (e.g. Today) would silently
    // present that tab's data as if it were this screen's -- TabBar and
    // FreshnessStamp would both describe the wrong thing. An honest "not
    // saved for offline use yet" screen beats a wrong one.
    return (await cache.match(OFFLINE_URL)) ?? Response.error();
  }
}
