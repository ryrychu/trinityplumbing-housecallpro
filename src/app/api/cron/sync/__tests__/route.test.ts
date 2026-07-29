import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted(): referenced from inside vi.mock() factories below, which are
// themselves hoisted above the module's top-level code. Plain top-level
// consts worked for the two pre-existing mocks only by accident of ordering;
// once route.ts imports enough additional mocked modules, plain consts throw
// "Cannot access before initialization". vi.hoisted() is the documented, safe
// way to share a mock reference with a vi.mock() factory regardless of
// declaration order.
const {
  upsertMock,
  selectMock,
  fromMock,
  listPaidInvoicesSinceMock,
  claimMock,
  notifyPaidInvoicesMock,
  postSlackMock,
  slackAlertsEnabledMock,
  getDashboardSnapshotMock,
  getWeekAheadScheduleMock,
} = vi.hoisted(() => {
  const upsertMock = vi.fn().mockResolvedValue({ error: null });
  // sync_cursors read: from("sync_cursors").select(...) resolves to no
  // cursors, so every resource does a full backfill in this test.
  const selectMock = vi.fn().mockResolvedValue({ data: [], error: null });
  const fromMock = vi.fn(() => ({ upsert: upsertMock, select: selectMock }));
  return {
    upsertMock,
    selectMock,
    fromMock,
    // Shared reference (rather than a fresh vi.fn() per `new HousecallClient()`
    // call) so tests can assert on call args/count directly.
    listPaidInvoicesSinceMock: vi.fn().mockResolvedValue({ items: [], page: 1, totalPages: 1 }),
    claimMock: vi.fn().mockResolvedValue(true),
    notifyPaidInvoicesMock: vi.fn().mockResolvedValue(0),
    postSlackMock: vi.fn().mockResolvedValue(true),
    slackAlertsEnabledMock: vi.fn().mockReturnValue(true),
    getDashboardSnapshotMock: vi.fn().mockResolvedValue({ todaySchedule: [] }),
    getWeekAheadScheduleMock: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseServerClient: () => ({ from: fromMock }),
}));

vi.mock("@/lib/housecall/client", () => ({
  HousecallClient: vi.fn().mockImplementation(function () {
    return {
      listCustomers: vi.fn().mockResolvedValue({ items: [{ id: "c1" }], page: 1, totalPages: 1 }),
      listEmployees: vi.fn().mockResolvedValue({ items: [{ id: "e1" }], page: 1, totalPages: 1 }),
      listJobs: vi.fn().mockResolvedValue({ items: [{ id: "j1", tags: [] }], page: 1, totalPages: 1 }),
      listEstimates: vi.fn().mockResolvedValue({ items: [{ id: "es1" }], page: 1, totalPages: 1 }),
      listInvoices: vi.fn().mockResolvedValue({ items: [{ id: "i1" }], page: 1, totalPages: 1 }),
      listLeads: vi.fn().mockResolvedValue({ items: [{ id: "lead_1" }], page: 1, totalPages: 1 }),
      listPaidInvoicesSince: listPaidInvoicesSinceMock,
    };
  }),
}));

vi.mock("@/lib/notifications/dedupe", () => ({
  claim: claimMock,
}));

vi.mock("@/lib/notifications/dispatch", () => ({
  notifyPaidInvoices: notifyPaidInvoicesMock,
}));

vi.mock("@/lib/slack/client", () => ({
  postSlack: postSlackMock,
  slackAlertsEnabled: slackAlertsEnabledMock,
}));

vi.mock("@/lib/dashboard/queries", () => ({
  getDashboardSnapshot: getDashboardSnapshotMock,
  getWeekAheadSchedule: getWeekAheadScheduleMock,
}));

import { GET } from "../route";

function authorizedRequest(): Request {
  return new Request("https://example.com/api/cron/sync", {
    headers: { Authorization: "Bearer test-cron-secret" },
  });
}

describe("GET /api/cron/sync", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset defaults explicitly every test: clearAllMocks() wipes call
    // history but not a previous test's non-Once mockResolvedValue override.
    claimMock.mockResolvedValue(true);
    notifyPaidInvoicesMock.mockResolvedValue(0);
    postSlackMock.mockResolvedValue(true);
    slackAlertsEnabledMock.mockReturnValue(true);
    getDashboardSnapshotMock.mockResolvedValue({ todaySchedule: [] });
    getWeekAheadScheduleMock.mockResolvedValue([]);
    listPaidInvoicesSinceMock.mockResolvedValue({ items: [], page: 1, totalPages: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects requests without the correct cron secret", async () => {
    const req = new Request("https://example.com/api/cron/sync");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("upserts every resource type when authorized", async () => {
    const req = new Request("https://example.com/api/cron/sync", {
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(fromMock).toHaveBeenCalledWith("customers");
    expect(fromMock).toHaveBeenCalledWith("technicians");
    expect(fromMock).toHaveBeenCalledWith("jobs");
    expect(fromMock).toHaveBeenCalledWith("estimates");
    expect(fromMock).toHaveBeenCalledWith("invoices");
    expect(fromMock).toHaveBeenCalledWith("leads");
  });

  // Invoices have no `updated_at` in the HCP payload, so their cursor can never
  // advance and every run would otherwise re-page all ~2.9k of them. The
  // reconcile is gated on elapsed time instead.
  it("skips the invoice reconcile when one ran within the window", async () => {
    selectMock.mockResolvedValueOnce({
      data: [{ resource: "invoices", last_updated_at: null, synced_at: new Date().toISOString() }],
      error: null,
    });

    const req = new Request("https://example.com/api/cron/sync", {
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ invoicesReconciled: false });
    expect(fromMock).toHaveBeenCalledWith("jobs");
    expect(fromMock).not.toHaveBeenCalledWith("invoices");
  });

  it("reconciles invoices when the last run is older than the window", async () => {
    const stale = new Date(Date.now() - 48 * 3_600_000).toISOString();
    selectMock.mockResolvedValueOnce({
      data: [{ resource: "invoices", last_updated_at: null, synced_at: stale }],
      error: null,
    });

    const req = new Request("https://example.com/api/cron/sync", {
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ invoicesReconciled: true });
    expect(fromMock).toHaveBeenCalledWith("invoices");
  });

  describe("targeted paid-invoice pass", () => {
    it("runs once per invocation and advances the invoices_paid watermark", async () => {
      listPaidInvoicesSinceMock.mockResolvedValue({
        items: [{ id: "inv_1", paid_at: "2026-07-28T12:00:00Z" }],
        page: 1,
        totalPages: 1,
      });

      const res = await GET(authorizedRequest());

      expect(res.status).toBe(200);
      expect(listPaidInvoicesSinceMock).toHaveBeenCalledTimes(1);
      expect(listPaidInvoicesSinceMock).toHaveBeenCalledWith(null);
      expect(notifyPaidInvoicesMock).toHaveBeenCalledWith(expect.anything(), [
        { id: "inv_1", paid_at: "2026-07-28T12:00:00Z" },
      ]);

      const cursorCall = upsertMock.mock.calls.find(
        ([rows]) => Array.isArray(rows) && rows.some((r: { resource: string }) => r.resource === "invoices_paid")
      );
      expect(cursorCall).toBeDefined();
      const invoicesPaidRow = (cursorCall as [Array<{ resource: string; last_updated_at: string | null }>])[0].find(
        (r) => r.resource === "invoices_paid"
      );
      expect(invoicesPaidRow?.last_updated_at).toBe("2026-07-28T12:00:00Z");
    });

    // notifications_sent (claim, mocked away inside notifyPaidInvoices) is the
    // correctness guarantee against duplicates; this watermark is only a fetch
    // optimization, so a failure here must never take down the sync.
    it("does not fail the sync when the paid-invoice pass throws", async () => {
      listPaidInvoicesSinceMock.mockRejectedValue(new Error("HCP down"));

      const res = await GET(authorizedRequest());

      expect(res.status).toBe(200);
    });
  });

  describe("schedule digests", () => {
    it("posts the daily digest once inside the morning window", async () => {
      vi.setSystemTime(new Date("2026-07-29T10:00:00Z")); // Wed 06:00 EDT

      await GET(authorizedRequest());

      expect(claimMock).toHaveBeenCalledWith(expect.anything(), "daily_digest", "2026-07-29");
      expect(postSlackMock.mock.calls.some(([, text]) => String(text).includes("Today —"))).toBe(true);
    });

    it("does not post the digest when the day is already claimed", async () => {
      claimMock.mockResolvedValue(false);
      vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));

      await GET(authorizedRequest());

      expect(postSlackMock.mock.calls.some(([, text]) => String(text).includes("Today —"))).toBe(false);
    });

    it("does not post the digest outside the morning window", async () => {
      vi.setSystemTime(new Date("2026-07-29T20:00:00Z")); // 16:00 EDT

      await GET(authorizedRequest());

      expect(claimMock).not.toHaveBeenCalledWith(expect.anything(), "daily_digest", expect.anything());
    });

    it("posts the week-ahead before the daily digest on Monday", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z")); // Mon 06:00 EDT

      await GET(authorizedRequest());

      expect(claimMock).toHaveBeenCalledWith(expect.anything(), "weekly_lookahead", "2026-07-27");
      expect(claimMock).toHaveBeenCalledWith(expect.anything(), "daily_digest", "2026-07-27");

      const weeklyCallIndex = postSlackMock.mock.calls.findIndex(([, text]) => String(text).includes("Week ahead"));
      const dailyCallIndex = postSlackMock.mock.calls.findIndex(([, text]) => String(text).includes("Today —"));
      expect(weeklyCallIndex).toBeGreaterThanOrEqual(0);
      expect(dailyCallIndex).toBeGreaterThan(weeklyCallIndex);
    });

    // The kill switch must gate BEFORE claim(): claiming while alerts are off
    // would permanently suppress that day's digest once alerts are turned on.
    it("never calls claim for digests when Slack alerts are disabled", async () => {
      slackAlertsEnabledMock.mockReturnValue(false);
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z")); // Monday morning: both would fire

      await GET(authorizedRequest());

      expect(claimMock).not.toHaveBeenCalled();
      expect(postSlackMock).not.toHaveBeenCalled();
    });

    it("does not fail the sync when the digest pass throws", async () => {
      vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));
      claimMock.mockRejectedValue(new Error("db down"));

      const res = await GET(authorizedRequest());

      expect(res.status).toBe(200);
    });
  });
});
