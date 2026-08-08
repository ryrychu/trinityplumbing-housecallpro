import { describe, it, expect } from "vitest";
import {
  matchesQuery,
  filterEstimates,
  filterInvoices,
  sumCents,
  statusOptions,
  countOverdue,
} from "../moneyFilters";
import type { EstimateHit, InvoiceHit } from "../money";

function estimate(over: Partial<EstimateHit> = {}): EstimateHit {
  return {
    id: "est_1",
    customerId: "cus_1",
    customerName: "Margaret Kowalski",
    amountCents: 145_000,
    status: "Scheduled",
    ...over,
  };
}

function invoice(over: Partial<InvoiceHit> = {}): InvoiceHit {
  return {
    id: "inv_1",
    customerId: "cus_1",
    customerName: "Margaret Kowalski",
    amountCents: 124_000,
    status: "open",
    dueDate: "2026-07-01",
    overdueDays: 37,
    ...over,
  };
}

describe("matchesQuery", () => {
  it("matches any part of the name, not just the start", () => {
    expect(matchesQuery("Margaret Kowalski", "kowal")).toBe(true);
  });

  it("ignores case and punctuation, so a typed name finds an apostrophed one", () => {
    expect(matchesQuery("Sean O'Connor", "oconnor")).toBe(true);
    expect(matchesQuery("Ruiz-Delgado Property", "ruizdelgado")).toBe(true);
  });

  it("matches everything when nothing has been typed", () => {
    expect(matchesQuery("Anyone", "")).toBe(true);
    expect(matchesQuery(null, "   ".trim())).toBe(true);
  });

  // Someone typing a name is asking to see that name. A row with no name is
  // not an answer to it, so it drops out rather than sitting there always.
  it("excludes a row with no customer name once a search is typed", () => {
    expect(matchesQuery(null, "kowal")).toBe(false);
  });
});

describe("filterEstimates", () => {
  const rows = [
    estimate({ id: "a", customerName: "Margaret Kowalski", status: "Scheduled" }),
    estimate({ id: "b", customerName: "Peter Nowak", status: "In Progress" }),
    estimate({ id: "c", customerName: "Ruiz Property Group", status: "Scheduled" }),
  ];

  it("returns everything when nothing is filtered", () => {
    expect(filterEstimates(rows, { query: "", status: "all" })).toHaveLength(3);
  });

  it("narrows by customer", () => {
    expect(filterEstimates(rows, { query: "ruiz", status: "all" }).map((r) => r.id)).toEqual(["c"]);
  });

  it("narrows by status", () => {
    expect(
      filterEstimates(rows, { query: "", status: "Scheduled" }).map((r) => r.id)
    ).toEqual(["a", "c"]);
  });

  it("applies both together rather than either alone", () => {
    expect(
      filterEstimates(rows, { query: "margaret", status: "In Progress" })
    ).toHaveLength(0);
  });
});

describe("filterInvoices", () => {
  const rows = [
    invoice({ id: "late", overdueDays: 62 }),
    invoice({ id: "duesoon", customerName: "Peter Nowak", overdueDays: null }),
    invoice({ id: "alsolate", customerName: "Ruiz Property Group", overdueDays: 12 }),
  ];

  it("returns everything when nothing is filtered", () => {
    expect(filterInvoices(rows, { query: "", overdueOnly: false })).toHaveLength(3);
  });

  // overdueDays is null for an invoice that is unpaid but not yet late -- the
  // toggle is "overdue", not "unpaid", and the two are different debts.
  it("keeps only late invoices when overdue is on", () => {
    expect(
      filterInvoices(rows, { query: "", overdueOnly: true }).map((r) => r.id)
    ).toEqual(["late", "alsolate"]);
  });

  it("applies the search alongside the toggle", () => {
    expect(
      filterInvoices(rows, { query: "ruiz", overdueOnly: true }).map((r) => r.id)
    ).toEqual(["alsolate"]);
  });
});

describe("sumCents", () => {
  // The headline figure is recomputed from the visible rows, so a filtered
  // list can never sit under an unfiltered total.
  it("adds the rows it is given", () => {
    expect(sumCents([{ amountCents: 100 }, { amountCents: 250 }])).toBe(350);
  });

  it("treats a missing amount as zero rather than NaN", () => {
    expect(sumCents([{ amountCents: 100 }, { amountCents: null }])).toBe(100);
  });

  it("is zero for nothing", () => {
    expect(sumCents([])).toBe(0);
  });
});

describe("statusOptions", () => {
  // Lifecycle order, not alphabetical: an estimate runs needs-scheduling ->
  // scheduled -> in progress -> complete, and a list reading C, I, N, S makes
  // the reader re-sort it themselves.
  it("lists present statuses in lifecycle order", () => {
    const rows = [
      estimate({ status: "Completed" }),
      estimate({ status: "Needs Scheduling" }),
      estimate({ status: "In Progress" }),
      estimate({ status: "Scheduled" }),
    ];
    expect(statusOptions(rows)).toEqual([
      "Needs Scheduling",
      "Scheduled",
      "In Progress",
      "Completed",
    ]);
  });

  // Offering a filter that returns nothing wastes a tap and reads as a bug.
  it("offers only statuses that actually occur", () => {
    expect(statusOptions([estimate({ status: "Scheduled" })])).toEqual(["Scheduled"]);
  });

  it("does not offer a status for rows that have none", () => {
    expect(statusOptions([estimate({ status: null })])).toEqual([]);
  });

  it("appends a label the lifecycle list has not been taught, rather than dropping it", () => {
    const rows = [estimate({ status: "Scheduled" }), estimate({ status: "Some New State" })];
    expect(statusOptions(rows)).toEqual(["Scheduled", "Some New State"]);
  });

  it("does not repeat a status shared by several rows", () => {
    const rows = [estimate({ status: "Scheduled" }), estimate({ status: "Scheduled" })];
    expect(statusOptions(rows)).toEqual(["Scheduled"]);
  });
});

describe("countOverdue", () => {
  it("counts the late ones, which is what the toggle advertises", () => {
    expect(countOverdue([invoice({ overdueDays: 3 }), invoice({ overdueDays: null })])).toBe(1);
  });
});
