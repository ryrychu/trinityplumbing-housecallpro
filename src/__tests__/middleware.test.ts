import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getUserMock, cookiesAdapterRef, clientArgsRef } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  // The url and key middleware actually constructs the client with. Recorded
  // because ignoring them is how a test passes while the browser-facing client
  // is handed the service-role key.
  clientArgsRef: { current: undefined as undefined | { url: string; key: string } },
  // Set by the mocked createServerClient on every call so tests can reach in
  // and invoke setAll() directly — simulating the token-refresh side effect
  // the real @supabase/ssr client performs from inside getUser().
  cookiesAdapterRef: {
    current: undefined as
      | undefined
      | { getAll: () => unknown; setAll: (cookies: unknown, headers?: unknown) => void },
  },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    url: string,
    key: string,
    config: { cookies: typeof cookiesAdapterRef.current }
  ) => {
    clientArgsRef.current = { url, key };
    cookiesAdapterRef.current = config.cookies;
    return { auth: { getUser: getUserMock } };
  },
}));

import { middleware, config } from "../middleware";

const req = (url: string) => new NextRequest(new Request(`https://ops.trinity.plumbing${url}`));

describe("middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientArgsRef.current = undefined;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    // Deliberately distinct and deliberately present: the assertion below is
    // only meaningful if the wrong key is actually available to be picked up.
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  });

  // Middleware's client is browser-facing -- it reads and writes the visitor's
  // session cookie. Handing it the service-role key would hand a request-shaped
  // path to a credential that bypasses every restriction in the database, and
  // no other test here would notice: the mock previously ignored both key
  // arguments entirely, so it passed identically either way.
  it("builds the session client with the anon key, never the service-role key", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    await middleware(req("/app/today"));

    expect(clientArgsRef.current?.key).toBe(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    expect(clientArgsRef.current?.key).not.toBe(process.env.SUPABASE_SERVICE_ROLE_KEY);
    expect(clientArgsRef.current?.url).toBe(process.env.NEXT_PUBLIC_SUPABASE_URL);
  });

  describe("signed out", () => {
    beforeEach(() => getUserMock.mockResolvedValue({ data: { user: null } }));

    it("redirects a page request to login", async () => {
      const res = await middleware(req("/app/today"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/app/login");
    });

    // Losing your place on session expiry is the difference between an app
    // that feels careful and one that feels careless.
    it("remembers where the user was going", async () => {
      const res = await middleware(req("/app/jobs/job_123"));
      expect(res.headers.get("location")).toContain("next=%2Fapp%2Fjobs%2Fjob_123");
    });

    // A fetch() must never receive an HTML login page — the client would try
    // to JSON.parse it and report a parse error instead of "signed out".
    it("returns 401 JSON for an API request, never a redirect", async () => {
      const res = await middleware(req("/api/app/today"));
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
    });

    it("lets the login page itself through", async () => {
      const res = await middleware(req("/app/login"));
      expect(res.status).toBe(200);
    });
  });

  // The matcher is the enforcement boundary -- middleware() itself never sees
  // a path the matcher excluded, so no behavioural test in this file can prove
  // coverage. Asserting the config directly is the only way to hold it.
  describe("matcher coverage", () => {
    it("guards the mobile app, its API, and the dispatch page and API", () => {
      expect(config.matcher).toEqual(
        expect.arrayContaining(["/app/:path*", "/api/app/:path*", "/dispatch", "/api/dispatch/:path*"])
      );
    });

    // These two must never be separated. Gating only the API leaves the
    // desktop page rendering while its fetch silently 401s; gating only the
    // page leaves the data open to anyone calling the route directly.
    it("keeps the dispatch page and its API gated together", () => {
      const page = config.matcher.includes("/dispatch");
      const api = config.matcher.includes("/api/dispatch/:path*");
      expect(page).toBe(api);
    });

    // /dashboard renders every one of today's jobs with the customer's full
    // name and street address. It sat outside the matcher while /app/* -- the
    // same data behind a different path -- was gated from the start, so this
    // pins the hole closed rather than trusting it to stay closed.
    it("guards the operations dashboard", () => {
      expect(config.matcher).toContain("/dashboard");
    });

    // Defence in depth: ADMIN_TRIGGER_TOKEN is still what authorizes the Slack
    // post, and this line is not a licence to drop it.
    it("guards the admin page", () => {
      expect(config.matcher).toContain("/admin");
    });

    // /api/slack/* must stay OUTSIDE the matcher. A slash command arrives from
    // Slack's servers with no Supabase session, so a gated route would answer
    // every command with a 302 to /app/login -- which Slack surfaces as a bare
    // "didn't work" with nothing in it to diagnose. The route authenticates
    // itself with SLACK_SIGNING_SECRET instead (src/lib/slack/verify.ts); this
    // assertion is what stops a later pattern -- an explicit "/api/slack*", the
    // literal "/api/:path*", or a broad catch-all such as "/api/(.*)" or
    // "/((?!_next).*)" that would gate the route without matching either
    // literal check below -- from quietly taking that away.
    it("leaves the Slack command route outside the session gate", () => {
      const gatesSlack = config.matcher.some(
        (p) => p.startsWith("/api/slack") || p === "/api/:path*"
      );
      expect(gatesSlack).toBe(false);

      // A regex-flavored catch-all (e.g. "/api/(.*)" or "/((?!_next).*)") would
      // pass the check above while still matching /api/slack/command at
      // runtime -- Next's matcher treats these entries as path-to-regexp
      // patterns, not literal strings. Neither of the literal checks above
      // would catch that, so this closes the gap directly.
      const hasCatchAll = config.matcher.some((p) => p.includes("(.*)") || p.includes("(?!"));
      expect(hasCatchAll).toBe(false);
    });
  });

  describe("dashboard and admin, signed out", () => {
    beforeEach(() => getUserMock.mockResolvedValue({ data: { user: null } }));

    it("redirects the operations dashboard to login", async () => {
      const res = await middleware(req("/dashboard"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/app/login");
    });

    it("sends the reader back to the dashboard after signing in", async () => {
      const res = await middleware(req("/dashboard"));
      expect(res.headers.get("location")).toContain("next=%2Fdashboard");
    });

    it("redirects the admin page to login", async () => {
      const res = await middleware(req("/admin"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/app/login");
    });
  });

  describe("dashboard, signed in", () => {
    it("lets the dashboard through", async () => {
      getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
      const res = await middleware(req("/dashboard"));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("dispatch, signed out", () => {
    beforeEach(() => getUserMock.mockResolvedValue({ data: { user: null } }));

    it("redirects the desktop dispatch page to login", async () => {
      const res = await middleware(req("/dispatch"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/app/login");
    });

    // Same reason as /api/app/*: NearbySearch.tsx calls this with fetch() and
    // would hand JSON.parse an HTML login page.
    it("returns 401 JSON for the nearby lookup, never a redirect", async () => {
      const res = await middleware(req("/api/dispatch/nearby?q=Averill+Park"));
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
    });
  });

  describe("signed in", () => {
    it("passes the request through", async () => {
      getUserMock.mockResolvedValue({ data: { user: { id: "u1", email: "info@trinity.plumbing" } } });
      const res = await middleware(req("/app/today"));
      expect(res.status).toBe(200);
    });
  });

  describe("refreshed session cookies", () => {
    const REFRESHED = [{ name: "sb-access-token", value: "new-token", options: { path: "/" } }];
    const CACHE_HEADERS = { "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0" };

    // getUser() can silently refresh an expired token; @supabase/ssr signals
    // that by calling setAll on the adapter mid-call. Simulated here since
    // the mocked client has no real refresh logic of its own.
    function refreshDuring(user: { id: string; email: string | null } | null) {
      getUserMock.mockImplementation(async () => {
        cookiesAdapterRef.current!.setAll(REFRESHED, CACHE_HEADERS);
        return { data: { user } };
      });
    }

    it("forwards a refreshed cookie onto the signed-in pass-through response", async () => {
      refreshDuring({ id: "u1", email: "info@trinity.plumbing" });
      const res = await middleware(req("/app/today"));
      expect(res.cookies.get("sb-access-token")?.value).toBe("new-token");
    });

    // This is the actual bug being fixed: building a *new* NextResponse for
    // the redirect must not mean it loses the Set-Cookie the adapter wrote —
    // a signed-out visitor whose session just failed to refresh would
    // otherwise keep carrying the dead cookie indefinitely.
    it("forwards a refreshed cookie onto the signed-out redirect response", async () => {
      refreshDuring(null);
      const res = await middleware(req("/app/today"));
      expect(res.cookies.get("sb-access-token")?.value).toBe("new-token");
    });

    it("forwards a refreshed cookie onto the signed-out 401 JSON response", async () => {
      refreshDuring(null);
      const res = await middleware(req("/api/app/today"));
      expect(res.cookies.get("sb-access-token")?.value).toBe("new-token");
    });

    // Required by @supabase/ssr's setAll contract: without this header, a
    // CDN or edge cache (this app deploys on Vercel) is free to cache a
    // Set-Cookie response and serve one visitor's session to the next.
    it("forwards the cache-control header setAll requires", async () => {
      refreshDuring(null);
      const res = await middleware(req("/app/today"));
      expect(res.headers.get("cache-control")).toBe(CACHE_HEADERS["cache-control"]);
    });
  });
});
