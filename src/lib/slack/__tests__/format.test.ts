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
    address: "12 Elm St, Albany",
    service: "Water Heater Repair",
    customerPhone: "5185550142",
    status: "Scheduled",
  };

  it("renders time, customer, phone, address, service, tech and status", () => {
    const out = formatDailyDigest(now, [row]);
    expect(out).toContain("Wed Jul 29");
    expect(out).toContain("1 job");
    expect(out).toContain("• *8:00 AM* — Mary Kolakowski  ·  📞 (518) 555-0142");
    expect(out).toContain("     📍 12 Elm St, Albany");
    expect(out).toContain("     🔧 Water Heater Repair");
    expect(out).toContain("     👤 Dan  ·  Scheduled");
  });

  it("drops the zone/miles/drive clutter Dave does not read at 6am", () => {
    const out = formatDailyDigest(now, [row]);
    expect(out).not.toContain("Albany Zone");
    expect(out).not.toContain("14 mi");
    expect(out).not.toContain("24 min");
  });

  it("bolds an unassigned job — the one line that needs acting on before the day starts", () => {
    const out = formatDailyDigest(now, [{ ...row, technicianName: null }]);
    expect(out).toContain("     👤 *Unassigned*  ·  Scheduled");
  });

  it("keeps the assignment line when the status is unknown", () => {
    const out = formatDailyDigest(now, [{ ...row, status: null }]);
    expect(out).toContain("     👤 Dan");
    expect(out).not.toContain("Dan  ·  ");
  });

  it("ends on the last job, with no sync-age footer", () => {
    const out = formatDailyDigest(now, [row]);
    expect(out).not.toContain("last sync");
    expect(out.endsWith("\n")).toBe(false);
  });

  it("still posts on an empty day — silence would be ambiguous", () => {
    const out = formatDailyDigest(now, []);
    expect(out).toContain("No jobs scheduled today");
  });

  it("falls back to the zone when a job has no address", () => {
    const out = formatDailyDigest(now, [{ ...row, id: "job_z", address: null }]);
    expect(out).toContain("     📍 Albany Zone");
  });

  describe("phone rendering", () => {
    const withPhone = (customerPhone: string | null) =>
      formatDailyDigest(now, [{ ...row, customerPhone }]);

    it("formats a 10-digit number", () => {
      expect(withPhone("5185550142")).toContain("📞 (518) 555-0142");
    });

    it("strips the US country code rather than rendering an 11-digit blob", () => {
      expect(withPhone("15185550142")).toContain("📞 (518) 555-0142");
    });

    it("shows an unrecognized length as stored instead of mangling it", () => {
      expect(withPhone("442071838750")).toContain("📞 442071838750");
    });

    it("omits the phone entirely when there is none", () => {
      const out = withPhone(null);
      expect(out).not.toContain("📞");
      expect(out).toContain("• *8:00 AM* — Mary Kolakowski\n");
    });
  });

  it("renders a job with no tech, no geocode, no customer, no address and no service without crashing", () => {
    const bare = {
      id: "job_2",
      scheduledStart: null,
      customerName: null,
      technicianName: null,
      zone: "Unknown",
      compass: "",
      miles: null,
      driveMinutes: null,
      address: null,
      service: null,
      customerPhone: null,
      status: null,
    };
    const out = formatDailyDigest(now, [bare]);
    expect(out).toContain("• *Time TBD* — Unknown customer");
    // An unknown zone is a placeholder, not a location — better to show no
    // location line than a line that says nothing.
    expect(out).not.toContain("📍");
    expect(out).not.toContain("🔧");
    // ...but the assignment line still shows, because "nobody is going" is the
    // one absence that must not read as silence.
    expect(out).toContain("     👤 *Unassigned*");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
  });

  it("has no footer on an empty day either", () => {
    expect(formatDailyDigest(now, [])).not.toContain("last sync");
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
            address: "9 Oak Ave, Troy",
            service: "Drain Cleaning",
            customerPhone: "5185550199",
            status: "Scheduled",
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
    // Same job block as the daily digest — one renderer, so the two can't drift.
    expect(out).toContain("     📍 9 Oak Ave, Troy");
    expect(out).toContain("     🔧 Drain Cleaning");
    expect(out).toContain("     👤 Dan  ·  Scheduled");
  });
});

describe("formatPaidInvoices", () => {
  it("lists each invoice with a dollar amount", () => {
    const out = formatPaidInvoices([
      { id: "inv_1", customerName: "Mary Kolakowski", customerId: "cus_1", amountCents: 428000, invoiceNumber: "1042" },
      { id: "inv_2", customerName: null, customerId: null, amountCents: null, invoiceNumber: null },
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
      { id: "a", customerName: "X", customerId: null, amountCents: 100, invoiceNumber: "1" },
    ]);
    const two = formatPaidInvoices([
      { id: "a", customerName: "X", customerId: null, amountCents: 100, invoiceNumber: "1" },
      { id: "b", customerName: "Y", customerId: null, amountCents: 200, invoiceNumber: "2" },
    ]);
    expect(one).toContain("1 invoice paid");
    expect(two).toContain("2 invoices paid");
  });
});

describe("formatApprovedEstimates", () => {
  it("lists each approved option", () => {
    const out = formatApprovedEstimates([
      { key: "est_1:opt_b", customerName: "R. Hoffman", customerId: "cus_1", amountCents: 250000, optionName: "Better" },
    ]);
    expect(out).toContain("estimate approved");
    expect(out).toContain("R. Hoffman");
    expect(out).toContain("$2,500.00");
    expect(out).toContain("Better");
  });
});
