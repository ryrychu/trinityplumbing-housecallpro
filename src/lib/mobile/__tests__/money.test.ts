import { describe, it, expect, vi, beforeEach } from "vitest";

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { listOpenEstimates, listUnpaidInvoices } from "../money";

function mockRows(rows: Record<string, unknown[]>) {
  supabaseMock.mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        range: () => Promise.resolve({ data: rows[table] ?? [], error: null }),
      }),
    }),
  });
}

const CUSTOMERS = [{ id: "cus_1", first_name: "R.", last_name: "Whitfield", company: null }];

// mockRows' range() ignores its (from, to) args and always hands back the
// whole fixture, so it can't tell a paged fetch apart from an unpaged one --
// deleting fetchAll's loop entirely would still pass every test above. This
// helper actually slices by the requested range, the same technique
// src/lib/dashboard/__tests__/queries.test.ts uses to guard the identical
// "PostgREST truncates at 1000 rows" bug (19 jobs in progress reported
// instead of 91, in that table, before paging was added).
function mockPagedTable(table: string, allRows: unknown[], otherTables: Record<string, unknown[]> = {}) {
  let calls = 0;
  supabaseMock.mockReturnValue({
    from: (t: string) => {
      if (t !== table) {
        return { select: () => ({ range: () => Promise.resolve({ data: otherTables[t] ?? [], error: null }) }) };
      }
      return {
        select: () => ({
          range: (from: number, to: number) => {
            calls += 1;
            return Promise.resolve({ data: allRows.slice(from, to + 1), error: null });
          },
        }),
      };
    },
  });
  return () => calls;
}

describe("listOpenEstimates", () => {
  beforeEach(() => vi.clearAllMocks());

  // isOpenEstimate() is the shipped definition — an estimate with an approved
  // option is not open, and neither is one in a terminal work_status.
  it("keeps only estimates isOpenEstimate accepts", async () => {
    mockRows({
      customers: CUSTOMERS,
      estimates: [
        { id: "csr_1", customer_id: "cus_1", status: "scheduled", amount_cents: 894_000, raw: { options: [{ approval_status: null }] } },
        { id: "csr_2", customer_id: "cus_1", status: "scheduled", amount_cents: 100_000, raw: { options: [{ approval_status: "pro approved" }] } },
        { id: "csr_3", customer_id: "cus_1", status: "created job from estimate", amount_cents: 50_000, raw: { options: [{ approval_status: null }] } },
      ],
    });

    const open = await listOpenEstimates();
    expect(open.map((e) => e.id)).toEqual(["csr_1"]);
  });

  it("resolves the customer name from the local table", async () => {
    mockRows({
      customers: CUSTOMERS,
      estimates: [{ id: "csr_1", customer_id: "cus_1", status: "scheduled", amount_cents: 1, raw: { options: [{ approval_status: null }] } }],
    });
    expect((await listOpenEstimates())[0].customerName).toBe("R. Whitfield");
  });

  const openEstimateRow = (id: string) => ({
    id,
    customer_id: "cus_1",
    status: "scheduled",
    amount_cents: 1,
    raw: { options: [{ approval_status: null }] },
  });

  // Regression guard: PostgREST returns at most 1000 rows per request. A bare
  // select silently truncates rather than erroring, so without this test a
  // deleted paging loop would just make the total quietly wrong -- exactly the
  // production incident (19 jobs reported instead of 91) this pattern exists
  // to prevent. ~930 live estimates make this a real risk, not a hypothetical.
  it("pages past the 1000-row cap instead of truncating", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => openEstimateRow(`csr_${i}`));
    const getCalls = mockPagedTable("estimates", rows, { customers: CUSTOMERS });

    const open = await listOpenEstimates();

    expect(getCalls()).toBe(2); // the 1001st row required a second .range() call
    expect(open).toHaveLength(1001);
  });

  // A page landing on exactly 1000 rows is the boundary a length check can get
  // wrong in either direction: stopping because the page "looks full" would
  // silently drop a 1001st row that never gets fetched on a future run, and
  // this asserts the loop instead always fetches one page past a full one to
  // find out whether it truly was the end.
  it("requests a second page even when the first page is exactly 1000 rows", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => openEstimateRow(`csr_${i}`));
    const getCalls = mockPagedTable("estimates", rows, { customers: CUSTOMERS });

    const open = await listOpenEstimates();

    expect(getCalls()).toBe(2);
    expect(open).toHaveLength(1000);
  });
});

describe("listUnpaidInvoices", () => {
  beforeEach(() => vi.clearAllMocks());

  // Live invoice statuses are paid/canceled/voided/open. "open" is the unpaid
  // state; there is no "pending". Canceled and voided are not debts.
  it("keeps only open invoices", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [
        { id: "inv_1", customer_id: "cus_1", status: "open", amount_cents: 187_500, due_date: "2026-06-06" },
        { id: "inv_2", customer_id: "cus_1", status: "paid", amount_cents: 10_000, due_date: "2026-06-06" },
        { id: "inv_3", customer_id: "cus_1", status: "voided", amount_cents: 10_000, due_date: "2026-06-06" },
        { id: "inv_4", customer_id: "cus_1", status: "canceled", amount_cents: 10_000, due_date: "2026-06-06" },
      ],
    });
    expect((await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z"))).map((i) => i.id)).toEqual(["inv_1"]);
  });

  it("counts overdue days from the due date", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [{ id: "inv_1", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: "2026-06-06" }],
    });
    const [invoice] = await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z"));
    expect(invoice.overdueDays).toBe(61);
  });

  it("reports null overdue days for an invoice not yet due", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [{ id: "inv_1", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: "2026-09-01" }],
    });
    expect((await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z")))[0].overdueDays).toBeNull();
  });

  it("reports null overdue days for an invoice due today", async () => {
    // "Now" is 12:00 UTC = 08:00 America/New_York on the same calendar day --
    // due today is not overdue, and must render as "Due", never as 0 days.
    mockRows({
      customers: CUSTOMERS,
      invoices: [{ id: "inv_1", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: "2026-08-06" }],
    });
    expect((await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z")))[0].overdueDays).toBeNull();
  });

  it("counts an invoice due yesterday as 1 day overdue", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [{ id: "inv_1", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: "2026-08-05" }],
    });
    expect((await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z")))[0].overdueDays).toBe(1);
  });

  it("reports null overdue days when due_date is null", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [{ id: "inv_1", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: null }],
    });
    expect((await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z")))[0].overdueDays).toBeNull();
  });

  // America/New_York springs forward at 02:00 EST -> 03:00 EDT on 2026-03-08.
  // "now" here is 2026-03-09T03:30:00Z, which is EDT (UTC-4) by then, so the
  // local wall clock reads 2026-03-08 23:30 -- still March 8 locally, even
  // though the UTC calendar date has already turned over to March 9.
  //
  // The old implementation diffed raw UTC instants (due_date's UTC midnight
  // vs. `now`'s UTC milliseconds) and would have counted this as 8 days
  // overdue -- one too many, because it measured against the UTC date instead
  // of the business's local date. Comparing calendar dates only (both sides
  // reduced to a UTC-midnight-of-date-only timestamp) gives the correct 7.
  it("counts calendar days correctly across the March DST transition", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [{ id: "inv_1", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: "2026-03-01" }],
    });
    const [invoice] = await listUnpaidInvoices(new Date("2026-03-09T03:30:00Z"));
    expect(invoice.overdueDays).toBe(7);
  });

  it("sorts the most overdue first", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [
        { id: "inv_new", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: "2026-08-01" },
        { id: "inv_old", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: "2026-05-01" },
      ],
    });
    expect((await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z"))).map((i) => i.id)).toEqual([
      "inv_old",
      "inv_new",
    ]);
  });
});

// The Money rows link to /app/customers/<id>, so the id has to reach the
// payload -- and it must be null rather than a bad id when the customer is not
// in the mirror, or the row becomes a link that 404s.
describe("customerId on money rows", () => {
  beforeEach(() => vi.clearAllMocks());

  it("carries the customer id on an estimate whose customer resolves", async () => {
    mockRows({
      customers: CUSTOMERS,
      estimates: [
        { id: "csr_1", customer_id: "cus_1", status: "scheduled", amount_cents: 1, raw: { options: [{ approval_status: null }] } },
      ],
    });
    const [estimate] = await listOpenEstimates();
    expect(estimate.customerId).toBe("cus_1");
  });

  it("nulls the id when the estimate's customer is not in the mirror", async () => {
    mockRows({
      customers: CUSTOMERS,
      estimates: [
        { id: "csr_1", customer_id: "cus_missing", status: "scheduled", amount_cents: 1, raw: { options: [{ approval_status: null }] } },
      ],
    });
    const [estimate] = await listOpenEstimates();
    expect(estimate.customerId).toBeNull();
    // The name is null too, so the row still renders -- just without a link.
    expect(estimate.customerName).toBeNull();
  });

  it("carries the customer id on an invoice whose customer resolves", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [{ id: "inv_1", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: null }],
    });
    const [invoice] = await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z"));
    expect(invoice.customerId).toBe("cus_1");
  });

  it("nulls the id when the invoice carries no customer at all", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [{ id: "inv_1", customer_id: null, status: "open", amount_cents: 1, due_date: null }],
    });
    const [invoice] = await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z"));
    expect(invoice.customerId).toBeNull();
  });
});

// The screen was rendering HCP's raw enum -- "in progress", "complete unrated"
// -- among title-cased labels everywhere else in the app. queries.ts already
// warned that an unmapped status would read as lowercase noise; the fix routes
// these through the same scheduleStatus() the run sheet and job screen use, so
// one estimate cannot describe itself two ways on two screens.
describe("estimate status labels", () => {
  beforeEach(() => vi.clearAllMocks());

  function withStatus(status: string) {
    mockRows({
      customers: CUSTOMERS,
      estimates: [
        {
          id: "csr_1",
          customer_id: "cus_1",
          status,
          amount_cents: 1,
          raw: { options: [{ approval_status: null }] },
        },
      ],
    });
    return listOpenEstimates();
  }

  it.each([
    ["scheduled", "Scheduled"],
    ["in progress", "In Progress"],
    ["needs scheduling", "Needs Scheduling"],
    ["complete rated", "Completed"],
    ["complete unrated", "Completed"],
  ])("renders HCP's %s as %s", async (raw, label) => {
    const [estimate] = await withStatus(raw);
    expect(estimate.status).toBe(label);
  });

  // scheduleStatus() returns null rather than echoing something it does not
  // recognise; the screen shows "Awaiting a response" for that instead of
  // inventing a label.
  it("reports null for a work_status it does not recognise", async () => {
    const [estimate] = await withStatus("some future hcp state");
    expect(estimate.status).toBeNull();
  });
});
