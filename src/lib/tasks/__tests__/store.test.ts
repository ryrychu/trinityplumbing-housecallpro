import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseChecklistStore } from "../store";

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
  id: 7,
  day: "2026-11-23",
  channel_id: "C1",
  message_ts: "171.1",
  built_by: "morning_ai",
  version: 3,
  rendered_version: 2,
  overflow: 0,
  finished_yesterday: 4,
};

describe("supabaseChecklistStore", () => {
  it("reads a day's checklist and maps it to camelCase", async () => {
    const { db, calls } = fakeDb({ data: ROW });
    const row = await supabaseChecklistStore(db).getByDay("2026-11-23");
    expect(row).toEqual({
      id: 7,
      day: "2026-11-23",
      channelId: "C1",
      messageTs: "171.1",
      builtBy: "morning_ai",
      version: 3,
      renderedVersion: 2,
      overflow: 0,
      finishedYesterday: 4,
    });
    expect(calls[0].table).toBe("task_checklists");
    expect(calls[0].ops).toContainEqual(["eq", ["day", "2026-11-23"]]);
  });

  it("returns null when there's no checklist that day", async () => {
    const { db } = fakeDb({ data: null });
    expect(await supabaseChecklistStore(db).getByDay("2026-11-23")).toBeNull();
  });

  it("bumps the version through task_checklist_touch and returns it", async () => {
    const { db, calls } = fakeDb({ data: 4 });
    expect(await supabaseChecklistStore(db).touch(7)).toBe(4);
    expect(calls[0]).toMatchObject({ fn: "task_checklist_touch", args: { p_id: 7 } });
  });

  it("replaces items in one call with snake_case rows", async () => {
    const { db, calls } = fakeDb();
    await supabaseChecklistStore(db).replaceItems(7, [
      { position: 1, groupName: "Troy job", text: "Order the boiler", fieldyTaskId: "t1", doneAt: null, doneVia: null },
    ]);
    expect(calls[0]).toMatchObject({
      fn: "task_checklist_replace_items",
      args: {
        p_id: 7,
        p_items: [{ position: 1, group_name: "Troy job", text: "Order the boiler", fieldy_task_id: "t1", done_at: null, done_via: null }],
      },
    });
  });

  it("makes no query when there is nothing to tick", async () => {
    const { db, calls } = fakeDb();
    await supabaseChecklistStore(db).setDone(7, [], "2026-11-23T13:00:00.000Z", "slack");
    expect(calls).toHaveLength(0);
  });

  it("ticks the given tasks on one checklist", async () => {
    const { db, calls } = fakeDb();
    await supabaseChecklistStore(db).setDone(7, ["t1", "t2"], "2026-11-23T13:00:00.000Z", "slack");
    expect(calls[0].table).toBe("task_checklist_items");
    expect(calls[0].ops).toEqual([
      ["update", [{ done_at: "2026-11-23T13:00:00.000Z", done_via: "slack" }]],
      ["eq", ["checklist_id", 7]],
      ["in", ["fieldy_task_id", ["t1", "t2"]]],
    ]);
  });

  it("lists checklists Slack is behind on, from a given day", async () => {
    const { db, calls } = fakeDb({ data: [ROW] });
    const rows = await supabaseChecklistStore(db).listBehind("2026-11-22");
    expect(rows.map((r) => r.id)).toEqual([7]);
    expect(calls[0].ops).toContainEqual(["eq", ["behind", true]]);
    expect(calls[0].ops).toContainEqual(["gte", ["day", "2026-11-22"]]);
  });

  it("throws with the operation name on a database error", async () => {
    const { db } = fakeDb({ error: { message: "permission denied" } });
    await expect(supabaseChecklistStore(db).listItems(7)).rejects.toThrow("[tasks] listItems failed: permission denied");
  });
});
