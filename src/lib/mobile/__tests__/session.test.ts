import { describe, it, expect, vi, beforeEach } from "vitest";

const { getUserMock, createServerClientMock, cookieStoreMock, cookiesAdapterRef } = vi.hoisted(() => {
  const cookieStoreMock = { getAll: vi.fn(() => []), set: vi.fn() };
  // Set by the mocked createServerClient on every call so tests can reach in
  // and invoke setAll() directly, the same way @supabase/ssr does internally
  // on a token refresh.
  const cookiesAdapterRef: {
    current?: { getAll: () => unknown; setAll: (cookies: unknown, headers?: unknown) => void };
  } = {};
  return {
    getUserMock: vi.fn(),
    createServerClientMock: vi.fn((_url: string, _key: string, config: { cookies: typeof cookiesAdapterRef.current }) => {
      cookiesAdapterRef.current = config.cookies;
      return { auth: { getUser: getUserMock } };
    }),
    cookieStoreMock,
    cookiesAdapterRef,
  };
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: createServerClientMock,
}));

vi.mock("next/headers", () => ({
  cookies: () => cookieStoreMock,
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

describe("cookie adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  // Confirms the migration off the deprecated get/set/remove shim: the
  // adapter exposes getAll/setAll, and setAll writes every cookie
  // @supabase/ssr hands it onto the Next.js cookie store.
  it("writes every cookie setAll receives onto the cookie store", () => {
    getSupabaseAuthClient();
    cookiesAdapterRef.current!.setAll([
      { name: "sb-access-token", value: "new-token", options: { path: "/", httpOnly: true } },
    ]);
    expect(cookieStoreMock.set).toHaveBeenCalledWith({
      name: "sb-access-token",
      value: "new-token",
      path: "/",
      httpOnly: true,
    });
  });

  // Server Component rendering is read-only; next/headers throws if code
  // tries to write a cookie from one. Middleware performs the real refresh,
  // so this throw is expected here and must not bubble up as an unhandled
  // error that would break the page render.
  it("swallows the 'cannot set cookies outside a Server Action' throw", () => {
    getSupabaseAuthClient();
    cookieStoreMock.set.mockImplementationOnce(() => {
      throw new Error("Cookies can only be modified in a Server Action or Route Handler");
    });
    expect(() =>
      cookiesAdapterRef.current!.setAll([{ name: "sb-access-token", value: "x", options: {} }])
    ).not.toThrow();
  });
});
