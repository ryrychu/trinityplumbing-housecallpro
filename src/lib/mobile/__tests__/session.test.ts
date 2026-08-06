import { describe, it, expect, vi, beforeEach } from "vitest";

const { getUserMock, createServerClientMock, cookiesMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createServerClientMock: vi.fn(() => ({ auth: { getUser: getUserMock } })),
  cookiesMock: vi.fn(() => ({ get: vi.fn(), set: vi.fn() })),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

import { getSupabaseAuthClient, requireUser } from "../session";

describe("getSupabaseAuthClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  // A misconfigured deployment must fail loudly at the call site rather than
  // silently hand @supabase/ssr `undefined` and fail somewhere harder to trace.
  it("throws when NEXT_PUBLIC_SUPABASE_URL is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(() => getSupabaseAuthClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("throws when NEXT_PUBLIC_SUPABASE_ANON_KEY is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(() => getSupabaseAuthClient()).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });

  // The whole point of this client is that it is NOT the service-role client
  // in src/lib/supabase/client.ts — asserting the anon key is what's plumbed
  // through is what actually guards that separation.
  it("builds the client from the anon key, not a service key", () => {
    getSupabaseAuthClient();
    expect(createServerClientMock).toHaveBeenCalledWith(
      "https://project.supabase.co",
      "anon-key",
      expect.anything()
    );
  });
});

describe("requireUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  it("returns null when nobody is signed in", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    expect(await requireUser()).toBeNull();
  });

  it("returns the signed-in user's id and email", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1", email: "info@trinity.plumbing" } } });
    expect(await requireUser()).toEqual({ id: "u1", email: "info@trinity.plumbing" });
  });

  // Supabase allows a user with no email on file; `?? null` keeps the
  // documented return type honest instead of leaking `undefined` to callers.
  it("normalizes a missing email to null instead of undefined", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1", email: undefined } } });
    expect(await requireUser()).toEqual({ id: "u1", email: null });
  });
});
