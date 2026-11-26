import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claim, claimMany, isClaimed } from "../dedupe";

// Minimal stub of the one chain dedupe uses:
//   supabase.from(table).upsert(rows, opts).select("entity_id")
function stubSupabase(returned: Array<{ entity_id: string }>, error: unknown = null) {
  const select = vi.fn().mockResolvedValue({ data: returned, error });
  const upsert = vi.fn().mockReturnValue({ select });
  const from = vi.fn().mockReturnValue({ upsert });
  return { client: { from } as unknown as SupabaseClient, from, upsert, select };
}

describe("claimMany", () => {
  it("returns only the ids Postgres actually inserted", async () => {
    const { client, upsert } = stubSupabase([{ entity_id: "inv_2" }]);

    const claimed = await claimMany(client, "invoice_paid", ["inv_1", "inv_2"]);

    expect(claimed).toEqual(["inv_2"]);
    const [rows, opts] = upsert.mock.calls[0];
    expect(rows).toEqual([
      { kind: "invoice_paid", entity_id: "inv_1" },
      { kind: "invoice_paid", entity_id: "inv_2" },
    ]);
    expect(opts).toEqual({ onConflict: "kind,entity_id", ignoreDuplicates: true });
  });

  it("makes no database call for an empty list", async () => {
    const { client, from } = stubSupabase([]);
    expect(await claimMany(client, "invoice_paid", [])).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("de-duplicates ids within a single call before inserting", async () => {
    const { client, upsert } = stubSupabase([{ entity_id: "inv_1" }]);
    await claimMany(client, "invoice_paid", ["inv_1", "inv_1"]);
    expect(upsert.mock.calls[0][0]).toEqual([{ kind: "invoice_paid", entity_id: "inv_1" }]);
  });

  // A DB error must THROW, not swallow-and-return-[]. The caller (route.ts's
  // paid-invoice pass) relies on this: a throw lands in that pass's own
  // catch, which skips pushing an `invoices_paid` cursor update entirely —
  // preserving the watermark so the next run retries these same invoices
  // instead of silently advancing past them with nothing claimed or posted.
  it("throws when the insert errors — never post on an unknown state, never let the caller advance a watermark", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = stubSupabase([], { message: "db down" });
    await expect(claimMany(client, "invoice_paid", ["inv_1"])).rejects.toThrow(/db down/);
  });
});

describe("claim", () => {
  it("is true when the single id was newly inserted", async () => {
    const { client } = stubSupabase([{ entity_id: "2026-07-29" }]);
    expect(await claim(client, "daily_digest", "2026-07-29")).toBe(true);
  });

  it("is false when the row already existed", async () => {
    const { client } = stubSupabase([]);
    expect(await claim(client, "daily_digest", "2026-07-29")).toBe(false);
  });
});

// A read, for passes whose report is costly to build: they look before they
// build, and still claim() before posting, which is the actual guard.
describe("isClaimed", () => {
  function stubRead(rows: unknown[], error: unknown = null) {
    const limit = vi.fn().mockResolvedValue({ data: rows, error });
    const eq2 = vi.fn().mockReturnValue({ limit });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    const from = vi.fn().mockReturnValue({ select });
    return { client: { from } as unknown as SupabaseClient, from, eq1, eq2 };
  }

  it("is true when the row exists", async () => {
    const s = stubRead([{ entity_id: "2026-11-16" }]);
    expect(await isClaimed(s.client, "analytics_weekly", "2026-11-16")).toBe(true);
    expect(s.from).toHaveBeenCalledWith("notifications_sent");
    expect(s.eq1).toHaveBeenCalledWith("kind", "analytics_weekly");
    expect(s.eq2).toHaveBeenCalledWith("entity_id", "2026-11-16");
  });

  it("is false when it doesn't", async () => {
    expect(await isClaimed(stubRead([]).client, "analytics_weekly", "2026-11-16")).toBe(false);
  });

  it("throws on a database error rather than guessing", async () => {
    await expect(isClaimed(stubRead([], { message: "db down" }).client, "analytics_weekly", "x")).rejects.toThrow(/db down/);
  });
});
