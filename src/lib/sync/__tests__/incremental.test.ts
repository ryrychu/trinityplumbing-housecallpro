import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncResourceIncremental } from "../incremental";

// Supabase mock: only upsert is exercised here (no geocodable addresses in these
// fixtures, so the geocode path short-circuits before touching the client).
const upsertMock = vi.fn().mockResolvedValue({ error: null });
const supabase = { from: vi.fn(() => ({ upsert: upsertMock })) } as unknown as SupabaseClient;

const identityMapper = (x: { id: string; updated_at?: string }) => ({ id: x.id, updated_at: x.updated_at });

function pager(pages: Array<Array<{ id: string; updated_at?: string }>>) {
  return async (page: number) => ({
    items: pages[page - 1] ?? [],
    page,
    totalPages: pages.length,
  });
}

describe("syncResourceIncremental", () => {
  beforeEach(() => vi.clearAllMocks());

  it("full backfill when the cursor is null: syncs every page, cursor = newest updated_at", async () => {
    const fetchPage = pager([
      [{ id: "j1", updated_at: "2026-07-23T00:00:00Z" }, { id: "j2", updated_at: "2026-07-22T00:00:00Z" }],
      [{ id: "j3", updated_at: "2026-07-21T00:00:00Z" }],
    ]);

    const result = await syncResourceIncremental(supabase, "jobs", fetchPage, identityMapper, { remaining: 0 }, null);

    expect(result.upserted).toBe(3);
    expect(result.pagesFetched).toBe(2);
    expect(result.newCursor).toBe("2026-07-23T00:00:00Z");
  });

  it("stops early at the first record older than the cursor", async () => {
    const fetchPage = pager([
      [
        { id: "j1", updated_at: "2026-07-23T00:00:00Z" }, // fresh
        { id: "j2", updated_at: "2026-07-22T00:00:00Z" }, // fresh
        { id: "j3", updated_at: "2026-07-20T00:00:00Z" }, // < cursor -> stop
      ],
      [{ id: "j4", updated_at: "2026-07-19T00:00:00Z" }], // never fetched
    ]);
    const cursor = "2026-07-21T00:00:00Z";

    const result = await syncResourceIncremental(supabase, "jobs", fetchPage, identityMapper, { remaining: 0 }, cursor);

    expect(result.pagesFetched).toBe(1); // stopped on page 1, page 2 never fetched
    expect(result.upserted).toBe(2); // j1, j2 only
    expect(result.newCursor).toBe("2026-07-23T00:00:00Z");
    const upsertedRows = upsertMock.mock.calls[0][0] as Array<{ id: string }>;
    expect(upsertedRows.map((r) => r.id)).toEqual(["j1", "j2"]);
  });

  it("re-syncs (does not skip) records whose updated_at equals the cursor", async () => {
    const fetchPage = pager([
      [
        { id: "j1", updated_at: "2026-07-21T00:00:00Z" }, // == cursor -> included (strict <)
        { id: "j2", updated_at: "2026-07-20T00:00:00Z" }, // < cursor -> stop
      ],
    ]);
    const cursor = "2026-07-21T00:00:00Z";

    const result = await syncResourceIncremental(supabase, "jobs", fetchPage, identityMapper, { remaining: 0 }, cursor);

    expect(result.upserted).toBe(1); // j1 re-synced, j2 excluded
    expect(result.newCursor).toBe("2026-07-21T00:00:00Z");
  });

  it("does nothing to upsert when the first record is already older than the cursor", async () => {
    const fetchPage = pager([[{ id: "j1", updated_at: "2026-07-01T00:00:00Z" }]]);
    const cursor = "2026-07-20T00:00:00Z";

    const result = await syncResourceIncremental(supabase, "jobs", fetchPage, identityMapper, { remaining: 0 }, cursor);

    expect(result.upserted).toBe(0);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(result.newCursor).toBe(cursor); // unchanged
  });
});
