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
  notifyApprovedEstimatesMock,
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
    notifyApprovedEstimatesMock: vi.fn().mockResolvedValue(0),
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
  notifyApprovedEstimates: notifyApprovedEstimatesMock,
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
    process.env.SLACK_WEBHOOK_SCHEDULE = "https://hooks.slack.com/services/SCHED";
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset defaults explicitly every test: clearAllMocks() wipes call
    // history but not a previous test's non-Once mockResolvedValue override.
    claimMock.mockResolvedValue(true);
    notifyPaidInvoicesMock.mockResolvedValue(0);
    notifyApprovedEstimatesMock.mockResolvedValue(0);
    postSlackMock.mockResolvedValue(true);
    slackAlertsEnabledMock.mockReturnValue(true);
    getDashboardSnapshotMock.mockResolvedValue({ todaySchedule: [] });
    getWeekAheadScheduleMock.mockResolvedValue([]);
    listPaidInvoicesSinceMock.mockResolvedValue({ items: [], page: 1, totalPages: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.SLACK_WEBHOOK_SCHEDULE;
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

    // C1: the entire paid-invoice block (fetch AND watermark advance) must be
    // gated on the kill switch, not just the Slack post. The rollout runbook
    // explicitly deploys with alerts off for hours/days; if the fetch still
    // ran and the watermark still advanced during that window, every invoice
    // paid in it would be permanently skipped once alerts turn on.
    it("does not fetch or advance the invoices_paid watermark when the kill switch is off", async () => {
      slackAlertsEnabledMock.mockReturnValue(false);

      const res = await GET(authorizedRequest());

      expect(res.status).toBe(200);
      expect(listPaidInvoicesSinceMock).not.toHaveBeenCalled();
      const cursorCall = upsertMock.mock.calls.find(
        ([rows]) => Array.isArray(rows) && rows.some((r: { resource: string }) => r.resource === "invoices_paid")
      );
      expect(cursorCall).toBeUndefined();
    });

    // C1: a claim/DB failure inside notifyPaidInvoices (claimMany now throws
    // on a DB error instead of swallowing it) must propagate up into THIS
    // pass's catch, which must never reach `results.push` for
    // `invoices_paid`. Omitting it from `results` is what keeps the cursor
    // at its old value in sync_cursors, so the next run retries the same
    // invoices instead of skipping past them with nothing claimed or posted.
    it("omits the invoices_paid cursor update entirely when notifyPaidInvoices throws (claim failure)", async () => {
      listPaidInvoicesSinceMock.mockResolvedValue({
        items: [{ id: "inv_1", paid_at: "2026-07-28T12:00:00Z" }],
        page: 1,
        totalPages: 1,
      });
      notifyPaidInvoicesMock.mockRejectedValue(new Error("db down"));

      const res = await GET(authorizedRequest());

      expect(res.status).toBe(200);
      const cursorCall = upsertMock.mock.calls.find(
        ([rows]) => Array.isArray(rows) && rows.some((r: { resource: string }) => r.resource === "invoices_paid")
      );
      expect(cursorCall).toBeUndefined();
    });
  });

  describe("estimate-approval cron safety net", () => {
    // I2: the cron must ALSO detect approved estimates, as a safety net for a
    // missed webhook delivery (retries exhausted, deploy window, rotated
    // secret, a signature mismatch returning 401). It must feed exactly the
    // estimate records THIS run's incremental sync touched, per the "detect
    // only what sync just touched" design rule.
    it("feeds the estimates the incremental sync touched into notifyApprovedEstimates", async () => {
      const res = await GET(authorizedRequest());

      expect(res.status).toBe(200);
      expect(notifyApprovedEstimatesMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ id: "es1" })])
      );
    });

    it("does not run the estimate-approval pass when the kill switch is off", async () => {
      slackAlertsEnabledMock.mockReturnValue(false);

      await GET(authorizedRequest());

      expect(notifyApprovedEstimatesMock).not.toHaveBeenCalled();
    });

    it("does not fail the sync when the estimate-approval pass throws", async () => {
      notifyApprovedEstimatesMock.mockRejectedValue(new Error("db down"));

      const res = await GET(authorizedRequest());

      expect(res.status).toBe(200);
    });
  });

  describe("schedule digests", () => {
    it("posts the daily digest once inside the morning window, to the schedule webhook", async () => {
      vi.setSystemTime(new Date("2026-07-29T10:00:00Z")); // Wed 06:00 EDT

      await GET(authorizedRequest());

      expect(claimMock).toHaveBeenCalledWith(expect.anything(), "daily_digest", "2026-07-29");
      const dailyCall = postSlackMock.mock.calls.find(([, text]) => String(text).includes("Today —"));
      expect(dailyCall).toBeDefined();
      // Regression guard: a bug that sent schedule data to the wrong webhook
      // (e.g. the invoices channel) would pass every existing assertion here
      // if only the message text were checked.
      expect(dailyCall?.[0]).toBe(process.env.SLACK_WEBHOOK_SCHEDULE);
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

    it("posts the week-ahead before the daily digest on Monday, both to the schedule webhook", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z")); // Mon 06:00 EDT

      await GET(authorizedRequest());

      expect(claimMock).toHaveBeenCalledWith(expect.anything(), "weekly_lookahead", "2026-07-27");
      expect(claimMock).toHaveBeenCalledWith(expect.anything(), "daily_digest", "2026-07-27");

      const weeklyCallIndex = postSlackMock.mock.calls.findIndex(([, text]) => String(text).includes("Week ahead"));
      const dailyCallIndex = postSlackMock.mock.calls.findIndex(([, text]) => String(text).includes("Today —"));
      expect(weeklyCallIndex).toBeGreaterThanOrEqual(0);
      expect(dailyCallIndex).toBeGreaterThan(weeklyCallIndex);
      expect(postSlackMock.mock.calls[weeklyCallIndex][0]).toBe(process.env.SLACK_WEBHOOK_SCHEDULE);
      expect(postSlackMock.mock.calls[dailyCallIndex][0]).toBe(process.env.SLACK_WEBHOOK_SCHEDULE);
    });

    // Also fix (smaller): the weekly and daily passes must be independent.
    // Before this fix they shared one try/catch, so a throw from
    // getWeekAheadSchedule AFTER claim('weekly_lookahead', ...) already
    // succeeded would skip the daily branch too AND permanently lose that
    // week's look-ahead notification (the claim was already recorded, so a
    // retry on the next run would find it pre-claimed and post nothing).
    it("still posts the daily digest when the weekly look-ahead pass throws", async () => {
      vi.setSystemTime(new Date("2026-07-27T10:00:00Z")); // Mon 06:00 EDT
      getWeekAheadScheduleMock.mockRejectedValue(new Error("db down"));

      const res = await GET(authorizedRequest());

      expect(res.status).toBe(200);
      expect(claimMock).toHaveBeenCalledWith(expect.anything(), "daily_digest", "2026-07-27");
      expect(postSlackMock.mock.calls.some(([, text]) => String(text).includes("Today —"))).toBe(true);
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
