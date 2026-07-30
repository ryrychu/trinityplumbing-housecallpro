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

  it("preserves empty string as key component, does not use '0' fallback", () => {
    // SQL coalesce(o->>'id','0') only fires on NULL, not empty string.
    // Must use ?? not || to preserve this divergence.
    expect(estimateOptionKey("est_1", "")).toBe("est_1:");
  });
});

describe("detectPaidInvoices", () => {
  const customer = { id: "cus_1", first_name: "Mary", last_name: "Kolakowski" };

  it("picks out paid invoices", () => {
    const out = detectPaidInvoices([
      { id: "inv_1", status: "paid", amount: 428000, invoice_number: "1042", customer },
    ]);
    expect(out).toEqual([
      {
        id: "inv_1",
        customerName: "Mary Kolakowski",
        customerId: "cus_1",
        amountCents: 428000,
        invoiceNumber: "1042",
      },
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
      { id: "inv_2", customerName: null, customerId: null, amountCents: null, invoiceNumber: null },
    ]);
  });

  it("carries the customer id alongside the name, for a caller to fall back on", () => {
    // I4: the live customer sub-shape may be `{ id }` only, with no nested
    // name. detect.ts stays pure (no DB access), but must still surface the
    // id so dispatch.ts can resolve a name from the local customers table.
    const out = detectPaidInvoices([
      { id: "inv_10", status: "paid", customer: { id: "cus_only_id" } },
    ]);
    expect(out).toEqual([
      { id: "inv_10", customerName: null, customerId: "cus_only_id", amountCents: null, invoiceNumber: null },
    ]);
  });

  it("skips records with no id", () => {
    expect(detectPaidInvoices([{ status: "paid" }])).toEqual([]);
  });

  it("survives non-string status values without throwing", () => {
    // Guard against unvalidated unknown fields that may be numbers, booleans, etc.
    const out = detectPaidInvoices([
      { id: "inv_3", status: 123, customer }, // numeric status
      { id: "inv_4", status: true, customer }, // boolean status
      { id: "inv_5", status: "paid", customer }, // valid status follows
    ]);
    // Malformed statuses fail the match gracefully; valid invoice is detected.
    expect(out).toEqual([
      {
        id: "inv_5",
        customerName: "Mary Kolakowski",
        customerId: "cus_1",
        amountCents: null,
        invoiceNumber: null,
      },
    ]);
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
      {
        key: "est_1:opt_b",
        customerName: "R. Hoffman",
        customerId: "cus_1",
        amountCents: 250000,
        optionName: "Better",
      },
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

  it("survives options as an object and skips that estimate gracefully", () => {
    // Guard est.options with Array.isArray to match jsonb_typeof in migration 0006.
    // If options is an object (not an array), treat as empty.
    const out = detectApprovedEstimates([
      {
        id: "est_5",
        customer,
        options: { id: "opt_x", approval_status: "approved" }, // object, not array
      },
    ]);
    expect(out).toEqual([]);
  });

  it("survives options as a scalar and skips that estimate gracefully", () => {
    // If options is a scalar (number, string, boolean), treat as empty.
    const out = detectApprovedEstimates([
      { id: "est_6", customer, options: 5 },
    ]);
    expect(out).toEqual([]);
  });

  it("skips malformed estimate but detects valid estimates in same batch", () => {
    // Critical: a malformed estimate must not abort the entire batch.
    const out = detectApprovedEstimates([
      { id: "est_7", customer, options: {} }, // malformed (object, not array)
      { id: "est_8", customer, options: [{ id: "o1", approval_status: "approved", total_amount: 300 }] }, // valid
    ]);
    expect(out).toEqual([
      { key: "est_8:o1", customerName: "R. Hoffman", customerId: "cus_1", amountCents: 300, optionName: null },
    ]);
  });

  it("survives non-string approval_status values without throwing", () => {
    // Guard against unvalidated approval_status that may be numbers, booleans, etc.
    const out = detectApprovedEstimates([
      {
        id: "est_9",
        customer,
        options: [
          { id: "o1", approval_status: 123 }, // numeric status
          { id: "o2", approval_status: true }, // boolean status
          { id: "o3", approval_status: "approved" }, // valid status follows
        ],
      },
    ]);
    expect(out).toEqual([
      { key: "est_9:o3", customerName: "R. Hoffman", customerId: "cus_1", amountCents: null, optionName: null },
    ]);
  });
});
