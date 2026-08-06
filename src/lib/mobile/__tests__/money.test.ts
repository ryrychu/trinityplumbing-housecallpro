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
