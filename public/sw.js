// Scoped to /app/ — the desktop dashboard at /dashboard is deliberately NOT
// controlled by this worker and keeps its normal server-rendered behaviour.
//
// This is intentionally NARROWER than the manifest's "scope": "/", and the two
// are not the same knob. Manifest scope decides which pages Chrome will offer
// to install and which URLs stay inside the installed window; worker scope
// decides which requests this file gets to answer. Widening the manifest so
// the dashboard is installable does not put the dashboard offline, and it must
// not — none of the caching below is written for it.
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
  // The shell HTML precached above is inert without its JavaScript. Without
  // this branch every /_next/static/chunks/*.js fell through to the network,
  // so offline the app depended entirely on the browser's HTTP cache to supply
  // its own code -- uncontrolled storage that iOS evicts under pressure, with
  // no signal to us when it does. It usually works, which is exactly why
  // manual testing looks fine and why this had to be closed deliberately
  // rather than observed.
  //
  // Cache-first is safe here specifically because these paths are
  // content-hashed: a changed chunk is a different URL, never a stale hit at
  // the same one. A deploy simply asks for URLs this cache has never seen.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirstImmutable(request));
    return;
  }
  if (url.pathname.startsWith("/app/")) {
    event.respondWith(networkFirstShell(request));
  }
});

async function cacheFirstImmutable(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  // Not caught: a miss here with no network is a genuinely unavailable asset,
  // and letting it reject surfaces as a failed subresource load rather than a
  // fabricated empty response the browser would try to execute as JavaScript.
  const fresh = await fetch(request);
  if (fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

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
