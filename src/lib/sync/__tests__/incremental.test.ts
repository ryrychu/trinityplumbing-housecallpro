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

  // The incremental cron backfills attachment METADATA for fresh customer/job
  // rows. Re-hosting is opt-in via a run-scoped budget: with no budget supplied
  // this stays metadata-only (no fetch/storage), which is the safe default.
  it("backfills attachment metadata without fetching when no rehost budget is supplied", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("blocked")));
    vi.stubGlobal("fetch", fetchSpy);

    const jobsUpsert = vi.fn().mockResolvedValue({ error: null });
    const attachmentsUpsert = vi.fn().mockResolvedValue({ error: null });
    const storageFrom = vi.fn();
    const localSupabase = {
      from: vi.fn((table: string) => ({
        upsert: table === "attachments" ? attachmentsUpsert : jobsUpsert,
      })),
      storage: { from: storageFrom },
    } as unknown as SupabaseClient;

    const jobMapper = (x: { id: string; updated_at?: string }) => ({ id: x.id, updated_at: x.updated_at });
    const fetchPage = async (page: number) => ({
      items: page === 1
        ? [{ id: "j1", updated_at: "2026-07-23T00:00:00Z", attachments: [{ id: "a1", url: "https://hcp/f.pdf" }] }]
        : [],
      page,
      totalPages: 1,
    });

    const result = await syncResourceIncremental(localSupabase, "jobs", fetchPage, jobMapper, { remaining: 0 }, null);

    expect(result.upserted).toBe(1);
    expect(attachmentsUpsert).toHaveBeenCalledOnce();
    const rows = attachmentsUpsert.mock.calls[0][0] as Array<{ id: string; parent_type: string; storage_path: string | null }>;
    expect(rows[0].id).toBe("a1");
    expect(rows[0].parent_type).toBe("job");
    expect(rows[0].storage_path).toBeNull();
    // Metadata-only: never re-hosts, so neither fetch nor storage is touched.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageFrom).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  // With a budget supplied, re-hosting runs but is capped across the whole run
  // (not per parent record), so a first backfill over ~3000 records stays inside
  // the 300s serverless limit. hcp_url expires in 1h, so this is how files last.
  it("re-hosts attachments when a run budget is supplied, and stops at the cap", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("blocked")));
    vi.stubGlobal("fetch", fetchSpy);

    const jobsUpsert = vi.fn().mockResolvedValue({ error: null });
    const attachmentsUpsert = vi.fn().mockResolvedValue({ error: null });
    const localSupabase = {
      from: vi.fn((table: string) => ({
        upsert: table === "attachments" ? attachmentsUpsert : jobsUpsert,
      })),
    } as unknown as SupabaseClient;

    const jobMapper = (x: { id: string; updated_at?: string }) => ({ id: x.id, updated_at: x.updated_at });
    const fetchPage = async (page: number) => ({
      items:
        page === 1
          ? [
              { id: "j1", updated_at: "2026-07-23T00:00:00Z", attachments: [{ id: "a1", url: "https://hcp/1" }] },
              { id: "j2", updated_at: "2026-07-22T00:00:00Z", attachments: [{ id: "a2", url: "https://hcp/2" }] },
            ]
          : [],
      page,
      totalPages: 1,
    });

    const rehostBudget = { remaining: 1 };
    await syncResourceIncremental(
      localSupabase,
      "jobs",
      fetchPage,
      jobMapper,
      { remaining: 0 },
      null,
      rehostBudget
    );

    expect(fetchSpy).toHaveBeenCalledOnce(); // capped: j2's attachment not fetched
    expect(rehostBudget.remaining).toBe(0);
    expect(attachmentsUpsert).toHaveBeenCalledTimes(2); // metadata for both jobs

    vi.unstubAllGlobals();
  });

  // I2: the cron route needs to know exactly which raw records this run
  // touched, to feed estimates into the approved-estimate safety-net
  // notifier without a second query. Additive/optional so no existing caller
  // (customers, jobs, leads) needs to change.
  it("calls onTouched with the raw fresh records, once per page, only after a successful upsert", async () => {
    const fetchPage = pager([
      [{ id: "j1", updated_at: "2026-07-23T00:00:00Z" }, { id: "j2", updated_at: "2026-07-22T00:00:00Z" }],
      [{ id: "j3", updated_at: "2026-07-21T00:00:00Z" }],
    ]);
    const onTouched = vi.fn();

    await syncResourceIncremental(supabase, "jobs", fetchPage, identityMapper, { remaining: 0 }, null, undefined, onTouched);

    expect(onTouched).toHaveBeenCalledTimes(2);
    expect(onTouched.mock.calls[0][0]).toEqual([
      { id: "j1", updated_at: "2026-07-23T00:00:00Z" },
      { id: "j2", updated_at: "2026-07-22T00:00:00Z" },
    ]);
    expect(onTouched.mock.calls[1][0]).toEqual([{ id: "j3", updated_at: "2026-07-21T00:00:00Z" }]);
  });

  it("never calls onTouched when a page has nothing fresh (already older than the cursor)", async () => {
    const fetchPage = pager([[{ id: "j1", updated_at: "2026-07-01T00:00:00Z" }]]);
    const onTouched = vi.fn();

    await syncResourceIncremental(
      supabase,
      "jobs",
      fetchPage,
      identityMapper,
      { remaining: 0 },
      "2026-07-20T00:00:00Z",
      undefined,
      onTouched
    );

    expect(onTouched).not.toHaveBeenCalled();
  });

  it("does not call onTouched when the upsert fails", async () => {
    const failingUpsert = vi.fn().mockResolvedValue({ error: { message: "db down" } });
    const localSupabase = { from: vi.fn(() => ({ upsert: failingUpsert })) } as unknown as SupabaseClient;
    const fetchPage = pager([[{ id: "j1", updated_at: "2026-07-23T00:00:00Z" }]]);
    const onTouched = vi.fn();

    await expect(
      syncResourceIncremental(localSupabase, "jobs", fetchPage, identityMapper, { remaining: 0 }, null, undefined, onTouched)
    ).rejects.toThrow();

    expect(onTouched).not.toHaveBeenCalled();
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
