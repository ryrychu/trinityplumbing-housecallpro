import { describe, it, expect, vi, beforeEach } from "vitest";

type QueryResult = { data: unknown[]; error: null };

function makeQueryBuilder(result: QueryResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lte: vi.fn(() => builder),
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
        return makeQueryBuilder({
          data: [
            { id: "j1", work_status: "in_progress", is_emergency: false, is_commercial: false, total_amount_cents: 20000 },
            { id: "j2", work_status: "scheduled", is_emergency: true, is_commercial: false, total_amount_cents: 15000 },
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
        return makeQueryBuilder({ data: [{ id: "i1", status: "pending", amount_cents: 30000 }], error: null });
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

  it("sums revenue from in_progress and scheduled jobs as revenue booked", async () => {
    const snapshot = await getDashboardSnapshot();
    expect(snapshot.revenueBookedCents).toBe(35000);
  });
});
