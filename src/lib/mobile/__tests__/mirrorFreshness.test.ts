import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { supabaseMock, inMock } = vi.hoisted(() => ({
  supabaseMock: vi.fn(),
  inMock: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { mirrorSyncedAt, staleAfterMinutes } from "../mirrorFreshness";

// Mirrors the shape the module actually calls:
// from("sync_cursors").select(...).in("resource", [...])
function mockCursors(result: { data?: unknown; error?: unknown }) {
  inMock.mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  supabaseMock.mockReturnValue({ from: () => ({ select: () => ({ in: inMock }) }) });
}

describe("staleAfterMinutes", () => {
  const ORIGINAL = process.env.INVOICE_RECONCILE_HOURS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INVOICE_RECONCILE_HOURS;
    else process.env.INVOICE_RECONCILE_HOURS = ORIGINAL;
  });

  // Three 15-minute cron cycles. One missed run is normal operations; warning
  // on it would train the owner to ignore the warning.
  it("allows three missed cron runs for frequently-synced resources", () => {
    expect(staleAfterMinutes(["jobs"])).toBe(45);
    expect(staleAfterMinutes(["customers"])).toBe(45);
    expect(staleAfterMinutes(["estimates"])).toBe(45);
  });

  // Derived from the cron's own constant rather than hardcoded, so the two
  // cannot drift. The reconcile fires on the first tick AFTER the window
  // elapses, so a healthy mirror routinely exceeds the bare window.
  it("derives the invoice threshold from INVOICE_RECONCILE_HOURS with headroom", () => {
    process.env.INVOICE_RECONCILE_HOURS = "20";
    expect(staleAfterMinutes(["invoices"])).toBe((20 + 4) * 60);

    process.env.INVOICE_RECONCILE_HOURS = "6";
    expect(staleAfterMinutes(["invoices"])).toBe((6 + 4) * 60);
  });

  it("falls back to the default when the env var is malformed", () => {
    process.env.INVOICE_RECONCILE_HOURS = "not-a-number";
    // NaN would silently disable the warning entirely, which is worse than a
    // wrong-but-bounded threshold.
    expect(staleAfterMinutes(["invoices"])).toBe((20 + 4) * 60);
  });

  // A screen is only as fresh as its stalest input, so the longest window wins.
  it("takes the longest threshold across a route's resources", () => {
    process.env.INVOICE_RECONCILE_HOURS = "20";
    expect(staleAfterMinutes(["invoices", "estimates"])).toBe((20 + 4) * 60);
    expect(staleAfterMinutes(["jobs", "customers"])).toBe(45);
  });
});

describe("mirrorSyncedAt", () => {
  beforeEach(() => vi.clearAllMocks());

  // The OLDEST, deliberately. A maximum would let one healthy resource paper
  // over a dead one, which is the failure this whole change exists to expose.
  it("returns the oldest synced_at among the declared resources", async () => {
    mockCursors({
      data: [
        { resource: "jobs", synced_at: "2026-08-06T13:55:00Z" },
        { resource: "customers", synced_at: "2026-08-06T13:20:00Z" },
      ],
    });

    expect(await mirrorSyncedAt(["jobs", "customers"])).toBe("2026-08-06T13:20:00.000Z");
    expect(inMock).toHaveBeenCalledWith("resource", ["jobs", "customers"]);
  });

  // Ignored by design -- see the comment in the module. `technicians` is the
  // known case: the cron syncs employees via syncAllPages(), which never
  // records a cursor row.
  it("ignores a declared resource that has no cursor row", async () => {
    mockCursors({ data: [{ resource: "jobs", synced_at: "2026-08-06T13:55:00Z" }] });

    expect(await mirrorSyncedAt(["jobs", "customers"])).toBe("2026-08-06T13:55:00.000Z");
  });

  it("returns null when sync_cursors is empty", async () => {
    mockCursors({ data: [] });

    expect(await mirrorSyncedAt(["jobs"])).toBeNull();
  });

  it("returns null rather than throwing when the table is unreadable", async () => {
    mockCursors({ error: { message: "permission denied" } });

    expect(await mirrorSyncedAt(["jobs"])).toBeNull();
  });

  // An unreachable Supabase must not take down a screen that has perfectly
  // good data to show; the stamp degrades to the old request-time wording.
  it("returns null rather than throwing when the client itself throws", async () => {
    supabaseMock.mockImplementation(() => {
      throw new Error("Missing env var: SUPABASE_SERVICE_ROLE_KEY");
    });

    expect(await mirrorSyncedAt(["jobs"])).toBeNull();
  });

  it("ignores rows whose synced_at is null", async () => {
    mockCursors({
      data: [
        { resource: "jobs", synced_at: null },
        { resource: "customers", synced_at: "2026-08-06T13:20:00Z" },
      ],
    });

    expect(await mirrorSyncedAt(["jobs", "customers"])).toBe("2026-08-06T13:20:00.000Z");
  });
});
