import { describe, it, expect, vi, beforeEach } from "vitest";

type QueryResult = { data: unknown[]; error: null };

function makeQueryBuilder(result: QueryResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    // The real client pages with .range(); every fixture here is smaller than a
    // full page, so the first call returns everything and the loop terminates.
    range: vi.fn(() => builder),
    then: (resolve: (value: QueryResult) => unknown) => resolve(result),
  };
  return builder;
}

const fromMock = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseServerClient: () => ({ from: fromMock }),
}));

import { getDashboardSnapshot } from "../queries";

describe("getDashboardSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockImplementation((table: string) => {
      if (table === "jobs") {
        // Status strings are the LIVE HCP values (go-live Step 2 census), not
        // invented ones — "in progress" with a space, never "in_progress".
        // Fixtures using the underscored form let the old bug pass tests while
        // the dashboard reported 0 against the real account.
        return makeQueryBuilder({
          data: [
            { id: "j1", work_status: "in progress", is_emergency: false, is_commercial: false, total_amount_cents: 20000 },
            { id: "j2", work_status: "scheduled", is_emergency: true, is_commercial: false, total_amount_cents: 15000 },
            // Completed work must NOT count toward in-progress or booked revenue.
            { id: "j3", work_status: "complete rated", is_emergency: false, is_commercial: false, total_amount_cents: 99000 },
            { id: "j4", work_status: "pro canceled", is_emergency: false, is_commercial: false, total_amount_cents: 77000 },
          ],
          error: null,
        });
      }
      if (table === "estimates") {
        // `status` stores the live HCP `work_status`; option approval state lives
        // in raw.options[].approval_status (Task 0). Open = not won/canceled, no
        // option approved, and at least one option still awaiting a response.
        return makeQueryBuilder({
          data: [
            // OPEN: awaiting a response, not won/canceled.
            { id: "e1", status: "needs scheduling", raw: { options: [{ approval_status: null }] } },
            // won -> not open (converted to a job).
            { id: "e2", status: "created job from estimate", raw: { options: [{ approval_status: null }] } },
            // dead -> not open (only expired options, none awaiting).
            { id: "e3", status: "complete rated", raw: { options: [{ approval_status: "expired" }] } },
            // accepted -> not open (an option is approved).
            { id: "e4", status: "scheduled", raw: { options: [{ approval_status: "approved" }, { approval_status: null }] } },
            // OPEN: one option awaiting, none approved (the other is declined).
            { id: "e5", status: "in progress", raw: { options: [{ approval_status: null }, { approval_status: "declined" }] } },
          ],
          error: null,
        });
      }
      if (table === "invoices") {
        // Live HCP invoice statuses are paid/canceled/voided/open. There is no
        // "pending" — "open" is the unpaid state the card counts.
        return makeQueryBuilder({
          data: [
            { id: "i1", status: "open", amount_cents: 30000 },
            { id: "i2", status: "paid", amount_cents: 40000 },
            { id: "i3", status: "voided", amount_cents: 50000 },
          ],
          error: null,
        });
      }
      return makeQueryBuilder({ data: [], error: null });
    });
  });

  it("counts jobs in progress and emergency calls", async () => {
    const snapshot = await getDashboardSnapshot();
    expect(snapshot.jobsInProgress).toBe(1);
    expect(snapshot.emergencyCalls).toBe(1);
  });

  it("counts open estimates (awaiting a response, not won/canceled) and pending invoices", async () => {
    const snapshot = await getDashboardSnapshot();
    expect(snapshot.openEstimates).toBe(2); // e1 + e5
    expect(snapshot.pendingInvoices).toBe(1);
  });

  // Regression guard: PostgREST returns at most 1000 rows per request. Before
  // pagination the dashboard read only the first page and under-reported every
  // count (19 jobs in progress instead of 91 against the live account).
  it("pages past the 1000-row cap instead of truncating", async () => {
    const job = (id: string) => ({
      id,
      work_status: "in progress",
      is_emergency: false,
      is_commercial: false,
      total_amount_cents: 100,
    });
    const fullPage = Array.from({ length: 1000 }, (_, i) => job(`p${i}`));
    const lastPage = [job("p1000")];

    let jobsCall = 0;
    fromMock.mockImplementation((table: string) => {
      if (table === "jobs") {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          gte: vi.fn(() => builder),
          lte: vi.fn(() => builder),
          range: vi.fn(() => builder),
          then: (resolve: (value: QueryResult) => unknown) =>
            resolve({ data: jobsCall++ === 0 ? fullPage : lastPage, error: null }),
        };
        return builder;
      }
      return makeQueryBuilder({ data: [], error: null });
    });

    const snapshot = await getDashboardSnapshot();
    expect(jobsCall).toBe(2); // a second page was actually requested
    expect(snapshot.jobsInProgress).toBe(1001);
    expect(snapshot.revenueBookedCents).toBe(100100);
  });

  it("sums revenue from 'in progress' and scheduled jobs only", async () => {
    const snapshot = await getDashboardSnapshot();
    // j1 (20000, in progress) + j2 (15000, scheduled). j3/j4 are completed and
    // canceled work and must be excluded.
    expect(snapshot.revenueBookedCents).toBe(35000);
  });
});
