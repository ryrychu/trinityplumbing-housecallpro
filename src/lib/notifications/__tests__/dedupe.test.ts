import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claim, claimMany } from "../dedupe";

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

  it("claims nothing when the insert errors — never post on an unknown state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = stubSupabase([], { message: "db down" });
    expect(await claimMany(client, "invoice_paid", ["inv_1"])).toEqual([]);
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
