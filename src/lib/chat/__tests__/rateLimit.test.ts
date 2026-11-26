import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_LIMITS } from "../config";
import { checkRateLimit, hashIp, windowStart } from "../rateLimit";

// Stand-in for supabase.rpc("chat_rate_limit_hit", …): answers with the
// counts given, in order, as the database function would.
function fakeDb(counts: number[], error: { message: string } | null = null) {
  const rpc = vi.fn(async () => ({ data: counts.shift() ?? 0, error }));
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

const NOW = new Date("2026-11-26T15:04:00.000Z");
const INPUT = { site: "trinity", ipHash: "abc123", limits: DEFAULT_LIMITS, now: NOW };

describe("checkRateLimit", () => {
  it("lets a message through under both limits and counts it in both windows", async () => {
    const { db, rpc } = fakeDb([1, 1]);
    expect(await checkRateLimit(db, INPUT)).toEqual({ ok: true });
    expect(rpc.mock.calls).toEqual([
      ["chat_rate_limit_hit", { p_key: "ip:trinity:abc123", p_window_start: "2026-11-26T15:00:00.000Z" }],
      ["chat_rate_limit_hit", { p_key: "site:trinity", p_window_start: "2026-11-26T00:00:00.000Z" }],
    ]);
  });

  it("lets the 20th message from one IP through", async () => {
    const { db } = fakeDb([20, 7]);
    expect(await checkRateLimit(db, INPUT)).toEqual({ ok: true });
  });

  it("stops the 21st message from one IP without counting it against the site", async () => {
    const { db, rpc } = fakeDb([21]);
    expect(await checkRateLimit(db, INPUT)).toEqual({ ok: false, scope: "ip" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("lets the site's 500th message of the day through and stops the 501st", async () => {
    expect(await checkRateLimit(fakeDb([1, 500]).db, INPUT)).toEqual({ ok: true });
    expect(await checkRateLimit(fakeDb([1, 501]).db, INPUT)).toEqual({ ok: false, scope: "site" });
  });

  it("uses the limits it is given", async () => {
    const { db } = fakeDb([3]);
    expect(await checkRateLimit(db, { ...INPUT, limits: { ...DEFAULT_LIMITS, ipMax: 2 } })).toEqual({ ok: false, scope: "ip" });
  });

  it("throws when the counter can't be read", async () => {
    const { db } = fakeDb([], { message: "db down" });
    await expect(checkRateLimit(db, INPUT)).rejects.toThrow("[chat] rate limit check failed: db down");
  });
});

describe("windowStart", () => {
  it("rolls over to a new 10-minute window on the boundary", () => {
    expect(windowStart(new Date("2026-11-26T15:09:59.999Z"), 600_000)).toBe("2026-11-26T15:00:00.000Z");
    expect(windowStart(new Date("2026-11-26T15:10:00.000Z"), 600_000)).toBe("2026-11-26T15:10:00.000Z");
  });

  it("starts the site's day at midnight UTC", () => {
    expect(windowStart(new Date("2026-11-26T23:59:59.000Z"), 86_400_000)).toBe("2026-11-26T00:00:00.000Z");
    expect(windowStart(new Date("2026-11-27T00:00:00.000Z"), 86_400_000)).toBe("2026-11-27T00:00:00.000Z");
  });
});

describe("hashIp", () => {
  it("is stable for one salt, differs across salts, and never contains the IP", () => {
    const a = hashIp("203.0.113.7", "salt-a");
    expect(a).toBe(hashIp("203.0.113.7", "salt-a"));
    expect(a).not.toBe(hashIp("203.0.113.7", "salt-b"));
    expect(a).not.toBe(hashIp("203.0.113.8", "salt-a"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203.0.113.7");
  });
});
