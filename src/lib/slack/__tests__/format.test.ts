import { describe, it, expect } from "vitest";
import {
  formatCents,
  formatDailyDigest,
  formatWeeklyLookahead,
  formatPaidInvoices,
  formatApprovedEstimates,
} from "../format";

describe("formatCents", () => {
  it("renders cents as dollars — the money bug that matters most here", () => {
    expect(formatCents(428000)).toBe("$4,280.00");
  });

  it("keeps sub-dollar precision", () => {
    expect(formatCents(5)).toBe("$0.05");
  });

  it("renders zero", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("renders null as an em dash rather than $NaN", () => {
    expect(formatCents(null)).toBe("—");
    expect(formatCents(undefined)).toBe("—");
  });
});

describe("formatDailyDigest", () => {
  const now = new Date("2026-07-29T10:00:00Z"); // Wed 06:00 EDT

  const row = {
    id: "job_1",
    scheduledStart: "2026-07-29T12:00:00Z", // 08:00 EDT
    customerName: "Mary Kolakowski",
    technicianName: "Dan",
    zone: "Albany Zone",
    compass: "SW",
    miles: 14,
    driveMinutes: 24,
  };

  it("includes the date, job count, local time, customer, zone and tech", () => {
    const out = formatDailyDigest(now, [row], 4);
    expect(out).toContain("Wed Jul 29");
    expect(out).toContain("1 job");
    expect(out).toContain("8:00a");
    expect(out).toContain("Mary Kolakowski");
    expect(out).toContain("Albany Zone");
    expect(out).toContain("SW");
    expect(out).toContain("14 mi");
    expect(out).toContain("24 min");
    expect(out).toContain("Dan");
  });

  it("shows sync age so a stalled external scheduler is visible", () => {
    expect(formatDailyDigest(now, [row], 4)).toContain("last sync: 4 min ago");
  });

  it("still posts on an empty day — silence would be ambiguous", () => {
    const out = formatDailyDigest(now, [], 2);
    expect(out).toContain("No jobs scheduled today");
  });

  it("renders a job with no tech, no geocode and no customer without crashing", () => {
    const bare = {
      id: "job_2",
      scheduledStart: null,
      customerName: null,
      technicianName: null,
      zone: "Unknown",
      compass: "",
      miles: null,
      driveMinutes: null,
    };
    const out = formatDailyDigest(now, [bare], null);
    expect(out).toContain("Unknown");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
  });

  it("renders zero miles and zero drive minutes rather than dropping them — a job in Averill Park itself is a real case", () => {
    const zeroDistance = { ...row, id: "job_3", miles: 0, driveMinutes: 0 };
    const out = formatDailyDigest(now, [zeroDistance], 4);
    expect(out).toContain("0 mi");
    expect(out).toContain("0 min");
  });

  it("shows zero minutes since last sync rather than falling back to 'unknown'", () => {
    const out = formatDailyDigest(now, [row], 0);
    expect(out).toContain("last sync: 0 min ago");
    expect(out).not.toContain("last sync: unknown");
  });
});

describe("formatWeeklyLookahead", () => {
  it("groups jobs under each day heading", () => {
    const out = formatWeeklyLookahead(new Date("2026-07-27T10:00:00Z"), [
      {
        dateKey: "2026-07-27",
        rows: [
          {
            id: "j1",
            scheduledStart: "2026-07-27T12:00:00Z",
            customerName: "A Customer",
            technicianName: "Dan",
            zone: "Albany Zone",
            compass: "SW",
            miles: 10,
            driveMinutes: 18,
          },
        ],
      },
      { dateKey: "2026-07-28", rows: [] },
    ]);
    expect(out).toContain("Week ahead");
    expect(out).toContain("Mon Jul 27");
    expect(out).toContain("A Customer");
    expect(out).toContain("Tue Jul 28");
    expect(out).toContain("No jobs");
  });
});

describe("formatPaidInvoices", () => {
  it("lists each invoice with a dollar amount", () => {
    const out = formatPaidInvoices([
      { id: "inv_1", customerName: "Mary Kolakowski", amountCents: 428000, invoiceNumber: "1042" },
      { id: "inv_2", customerName: null, amountCents: null, invoiceNumber: null },
    ]);
    expect(out).toContain("2 invoices paid");
    expect(out).toContain("Mary Kolakowski");
    expect(out).toContain("$4,280.00");
    expect(out).toContain("#1042");
    expect(out).toContain("—");
    expect(out).not.toContain("undefined");
  });

  it("uses the singular heading for one and plural for many", () => {
    const one = formatPaidInvoices([
      { id: "a", customerName: "X", amountCents: 100, invoiceNumber: "1" },
    ]);
    const two = formatPaidInvoices([
      { id: "a", customerName: "X", amountCents: 100, invoiceNumber: "1" },
      { id: "b", customerName: "Y", amountCents: 200, invoiceNumber: "2" },
    ]);
    expect(one).toContain("1 invoice paid");
    expect(two).toContain("2 invoices paid");
  });
});

describe("formatApprovedEstimates", () => {
  it("lists each approved option", () => {
    const out = formatApprovedEstimates([
      { key: "est_1:opt_b", customerName: "R. Hoffman", amountCents: 250000, optionName: "Better" },
    ]);
    expect(out).toContain("estimate approved");
    expect(out).toContain("R. Hoffman");
    expect(out).toContain("$2,500.00");
    expect(out).toContain("Better");
  });
});
