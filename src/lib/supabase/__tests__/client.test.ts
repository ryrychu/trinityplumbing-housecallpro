import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: vi.fn() })),
}));

import { getSupabaseServerClient } from "../client";
import { createClient } from "@supabase/supabase-js";

describe("getSupabaseServerClient", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    vi.clearAllMocks();
  });

  it("creates a client with the service role key, not the anon key", () => {
    getSupabaseServerClient();
    expect(createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-key",
      expect.any(Object)
    );
  });

  it("throws a clear error if env vars are missing", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => getSupabaseServerClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
