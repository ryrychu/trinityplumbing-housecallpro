import { describe, it, expect } from "vitest";
import { detectPaidInvoices, detectApprovedEstimates, estimateOptionKey } from "../detect";

describe("estimateOptionKey", () => {
  it("joins estimate and option id", () => {
    expect(estimateOptionKey("est_1", "opt_a")).toBe("est_1:opt_a");
  });

  it("falls back to '0' — must match coalesce(o->>'id','0') in migration 0006", () => {
    expect(estimateOptionKey("est_1", null)).toBe("est_1:0");
    expect(estimateOptionKey("est_1", undefined)).toBe("est_1:0");
  });
});

describe("detectPaidInvoices", () => {
  const customer = { id: "cus_1", first_name: "Mary", last_name: "Kolakowski" };

  it("picks out paid invoices", () => {
    const out = detectPaidInvoices([
      { id: "inv_1", status: "paid", amount: 428000, invoice_number: "1042", customer },
    ]);
    expect(out).toEqual([
      { id: "inv_1", customerName: "Mary Kolakowski", amountCents: 428000, invoiceNumber: "1042" },
    ]);
  });

  it("ignores every non-paid live status", () => {
    // Live account census: paid 2217 | canceled 570 | voided 42 | open 25.
    const out = detectPaidInvoices([
      { id: "a", status: "open", customer },
      { id: "b", status: "canceled", customer },
      { id: "c", status: "voided", customer },
    ]);
    expect(out).toEqual([]);
  });

  it("survives a record with no customer and no amount", () => {
    const out = detectPaidInvoices([{ id: "inv_2", status: "paid" }]);
    expect(out).toEqual([
      { id: "inv_2", customerName: null, amountCents: null, invoiceNumber: null },
    ]);
  });

  it("skips records with no id", () => {
    expect(detectPaidInvoices([{ status: "paid" }])).toEqual([]);
  });
});

describe("detectApprovedEstimates", () => {
  const customer = { id: "cus_1", first_name: "R.", last_name: "Hoffman" };

  it("returns only the approved option of a multi-option estimate", () => {
    const out = detectApprovedEstimates([
      {
        id: "est_1",
        customer,
        options: [
          { id: "opt_a", name: "Good", approval_status: null, total_amount: 100000 },
          { id: "opt_b", name: "Better", approval_status: "approved", total_amount: 250000 },
        ],
      },
    ]);
    expect(out).toEqual([
      { key: "est_1:opt_b", customerName: "R. Hoffman", amountCents: 250000, optionName: "Better" },
    ]);
  });

  it("treats 'pro approved' as approved, case-insensitively", () => {
    const out = detectApprovedEstimates([
      { id: "est_2", customer, options: [{ id: "o", approval_status: "Pro Approved", total_amount: 500 }] },
    ]);
    expect(out.map((r) => r.key)).toEqual(["est_2:o"]);
  });

  it("ignores declined and pending options", () => {
    const out = detectApprovedEstimates([
      {
        id: "est_3",
        customer,
        options: [
          { id: "o1", approval_status: "declined" },
          { id: "o2", approval_status: null },
        ],
      },
    ]);
    expect(out).toEqual([]);
  });

  it("survives an estimate with no options array", () => {
    expect(detectApprovedEstimates([{ id: "est_4", customer }])).toEqual([]);
  });
});
