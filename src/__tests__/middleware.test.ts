import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getUserMock } = vi.hoisted(() => ({ getUserMock: vi.fn() }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: getUserMock } }),
}));

import { middleware } from "../middleware";

const req = (url: string) => new NextRequest(new Request(`https://ops.trinity.plumbing${url}`));

describe("middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
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
});
