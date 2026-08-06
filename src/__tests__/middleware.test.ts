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

import { middleware } from "../middleware";

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
