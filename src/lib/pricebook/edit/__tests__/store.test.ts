import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabasePricebookEditStore } from "../store";

// fakeDb(...) — copied verbatim from src/lib/tasks/__tests__/store.test.ts
type Op = [string, unknown[]];
type Call = { table?: string; fn?: string; args?: unknown; ops: Op[] };

// A chainable stand-in for the Supabase query builder. Every method records
// itself and returns the chain; awaiting the chain resolves to `result`.
function fakeDb(result: { data?: unknown; error?: { message: string } | null } = {}) {
  const calls: Call[] = [];
  const chain = (call: Call): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null });
          }
          return (...args: unknown[]) => {
            call.ops.push([prop, args]);
            return chain(call);
          };
        },
      }
    );
  const db = {
    from(table: string) {
      const c: Call = { table, ops: [] };
      calls.push(c);
      return chain(c);
    },
    rpc(fn: string, args: unknown) {
      const c: Call = { fn, args, ops: [] };
      calls.push(c);
      return chain(c);
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const ROW = {
  id: 3, batch_id: "b1", kind: "material_update", item_uuid: "m1", item_name: "PEX tee", item_kind: "material",
  category_uuid: "c1", before: { priceCents: 250 }, after: { priceCents: 275 }, status: "applied",
  requested_by: "u-dave", resolved_by: null, error_code: null, slack_channel_id: null, slack_message_ts: null,
  created_at: "2026-11-21T15:00:00+00:00", resolved_at: null,
};

describe("supabasePricebookEditStore", () => {
  it("inserts snake_case rows and maps the result back", async () => {
    const { db, calls } = fakeDb({ data: [ROW] });
    const out = await supabasePricebookEditStore(db).insertChanges([
      { batchId: "b1", kind: "material_update", itemUuid: "m1", itemName: "PEX tee", itemKind: "material", categoryUuid: "c1",
        before: { priceCents: 250 }, after: { priceCents: 275 }, status: "applied", requestedBy: "u-dave", errorCode: null },
    ]);
    expect(calls[0].table).toBe("pricebook_changes");
    expect(calls[0].ops[0][0]).toBe("insert");
    expect((calls[0].ops[0][1][0] as Array<Record<string, unknown>>)[0]).toMatchObject({ batch_id: "b1", item_uuid: "m1", requested_by: "u-dave" });
    expect(out[0]).toMatchObject({ id: 3, batchId: "b1", itemKind: "material", before: { priceCents: 250 }, requestedBy: "u-dave" });
  });

  it("claims a preview only when unapplied, unexpired and owned by the caller", async () => {
    const { db, calls } = fakeDb({ data: [{ id: "p1", created_by_user_id: "u-dave", payload: [], expires_at: "2026-11-21T15:15:00Z", applied_at: "2026-11-21T15:01:00Z" }] });
    const row = await supabasePricebookEditStore(db).claimPreview("p1", "u-dave", "2026-11-21T15:01:00Z");
    expect(row).toMatchObject({ id: "p1", createdBy: "u-dave" });
    expect(calls[0].ops).toEqual(expect.arrayContaining([
      ["eq", ["id", "p1"]], ["is", ["applied_at", null]], ["eq", ["created_by_user_id", "u-dave"]], ["gt", ["expires_at", "2026-11-21T15:01:00Z"]],
    ]));
  });

  it("returns null when the claim matched nothing", async () => {
    const { db } = fakeDb({ data: [] });
    expect(await supabasePricebookEditStore(db).claimPreview("p1", "u-dave", "2026-11-21T15:01:00Z")).toBeNull();
  });

  it("lists pending service requests", async () => {
    const { db, calls } = fakeDb({ data: [] });
    await supabasePricebookEditStore(db).listPendingServices();
    expect(calls[0].ops).toEqual(expect.arrayContaining([["eq", ["kind", "service_request"]], ["eq", ["status", "pending"]]]));
  });

  it("throws with the operation name on error", async () => {
    const { db } = fakeDb({ error: { message: "denied" } });
    await expect(supabasePricebookEditStore(db).listBatch("b1")).rejects.toThrow("[pricebook] listBatch failed: denied");
  });
});
