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
        return makeQueryBuilder({ data: [{ id: "e1", status: "open" }], error: null });
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

  it("counts open estimates and pending invoices", async () => {
    const snapshot = await getDashboardSnapshot();
    expect(snapshot.openEstimates).toBe(1);
    expect(snapshot.pendingInvoices).toBe(1);
  });

  it("sums revenue from in_progress and scheduled jobs as revenue booked this week", async () => {
    const snapshot = await getDashboardSnapshot();
    expect(snapshot.revenueBookedThisWeekCents).toBe(35000);
  });
});
