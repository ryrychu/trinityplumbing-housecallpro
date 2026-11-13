import { describe, it, expect } from "vitest";
import {
  tally,
  inRange,
  thisWeek,
  weekBefore,
  weekLabel,
  thresholdLine,
  formatWeeklyReport,
  monthToDate,
  lastMonth,
  monthBefore,
  monthKey,
  monthLabel,
  comparisonLine,
  formatMonthlyReport,
  formatMonthPreview,
  type DeclinedRow,
} from "../tally";

const row = (
  created_at: string,
  reason: "busy" | "distance" | null = null,
  phone_hash: string | null = null
): DeclinedRow => ({ created_at, reason, phone_hash });

// Monday 9 Nov 2026, 7:00 EST. Last week is Mon 2 – Sun 8 Nov.
const MONDAY_MORNING = new Date("2026-11-09T12:00:00Z");

describe("tally", () => {
  it("counts a repeat caller once within the same week, across forwards and /trinity entries", () => {
    const t = tally([
      row("2026-11-03T15:00:00Z", null, "h1"), // forwarded
      row("2026-11-05T15:00:00Z", "busy", "h1"), // also logged
      row("2026-11-06T15:00:00Z", null, "h1"), // forwarded again
    ]);
    expect(t).toEqual({ total: 1, busy: 0, distance: 0 });
  });

  it("keeps the busy/distance split for /trinity entries only", () => {
    expect(tally([row("2026-11-03T15:00:00Z"), row("2026-11-03T16:00:00Z", "busy"), row("2026-11-03T17:00:00Z", "distance")])).toEqual({
      total: 3,
      busy: 1,
      distance: 1,
    });
  });

  it("counts the same caller again in a different week", () => {
    expect(tally([row("2026-11-03T15:00:00Z", null, "h1"), row("2026-11-10T15:00:00Z", null, "h1")]).total).toBe(2);
  });

  it("counts every call with no phone on its own", () => {
    expect(tally([row("2026-11-03T15:00:00Z"), row("2026-11-03T15:00:00Z"), row("2026-11-03T15:00:00Z")]).total).toBe(3);
  });

  describe("Eastern week boundary", () => {
    // DST ended at 2am on Sun 1 Nov 2026, so this Sunday night is EST (-05:00).
    const sundayLate = "2026-11-02T04:00:00Z"; // Sun 1 Nov, 11:00pm EST
    const mondayEarly = "2026-11-02T05:30:00Z"; // Mon 2 Nov, 12:30am EST

    it("puts Sunday 11pm in the old week and Monday 12:30am in the new one", () => {
      const current = thisWeek(new Date("2026-11-02T15:00:00Z"));
      const previous = weekBefore(current);
      const rows = [row(sundayLate), row(mondayEarly)];

      expect(inRange(rows, current).map((r) => r.created_at)).toEqual([mondayEarly]);
      expect(inRange(rows, previous).map((r) => r.created_at)).toEqual([sundayLate]);
    });

    it("does not de-dupe the same caller across that boundary", () => {
      expect(tally([row(sundayLate, null, "h1"), row(mondayEarly, null, "h1")]).total).toBe(2);
    });

    it("holds in summer time too (EDT, -04:00)", () => {
      const sunday = "2026-07-13T03:00:00Z"; // Sun 12 Jul, 11:00pm EDT
      const monday = "2026-07-13T04:30:00Z"; // Mon 13 Jul, 12:30am EDT
      const current = thisWeek(new Date("2026-07-13T16:00:00Z"));
      expect(inRange([row(sunday), row(monday)], current).map((r) => r.created_at)).toEqual([monday]);
    });
  });
});

describe("weekLabel", () => {
  it("shortens a week inside one month", () => {
    expect(weekLabel(weekBefore(thisWeek(MONDAY_MORNING)))).toBe("Nov 2–8");
  });
  it("names both months across a month end", () => {
    expect(weekLabel(weekBefore(weekBefore(thisWeek(MONDAY_MORNING))))).toBe("Oct 26–Nov 1");
  });
});

describe("thresholdLine", () => {
  it("is under at 14", () => {
    expect(thresholdLine(14)).toBe("Under 15 for the week (1 short).");
  });
  it.each([15, 16])("is at or over at %i", (n) => {
    expect(thresholdLine(n)).toMatch(/^At or over 15 for the week/);
  });
});

describe("monthToDate", () => {
  it("starts at midnight Eastern on the 1st", () => {
    expect(monthToDate(MONDAY_MORNING)).toEqual({
      startIso: "2026-11-01T04:00:00.000Z", // still EDT at midnight on 1 Nov
      endIso: MONDAY_MORNING.toISOString(),
    });
  });
});

describe("formatWeeklyReport", () => {
  function lastWeek(n: number): DeclinedRow[] {
    return Array.from({ length: n }, (_, i) => ({ ...row("2026-11-04T15:00:00Z", null, `p${i}`), label: `Caller ${i + 1}` }));
  }

  it("lists each call, then the totals on one line", () => {
    expect(formatWeeklyReport(lastWeek(3), MONDAY_MORNING)).toBe(
      [
        "*3 calls declined last week (Nov 2–8)*",
        "• Caller 1",
        "• Caller 2",
        "• Caller 3",
        "Under 15 for the week (12 short). 4-week average: 0.8 a week. November so far: 3.",
      ].join("\n")
    );
  });

  it("with no calls, says 0 and lists nothing", () => {
    expect(formatWeeklyReport([], MONDAY_MORNING)).toBe(
      ["*0 calls declined last week (Nov 2–8)*", "Under 15 for the week (15 short). 4-week average: 0.0 a week. November so far: 0."].join("\n")
    );
  });

  it("says 1 call, not 1 calls", () => {
    expect(formatWeeklyReport(lastWeek(1), MONDAY_MORNING)).toContain("*1 call declined last week (Nov 2–8)*");
  });

  it("at 14 says under", () => {
    const text = formatWeeklyReport(lastWeek(14), MONDAY_MORNING);
    expect(text).toContain("Under 15 for the week (1 short).");
    expect(text).not.toContain("At or over");
  });

  it.each([15, 16])("at %i says at or over 15", (n) => {
    const text = formatWeeklyReport(lastWeek(n), MONDAY_MORNING);
    expect(text).toContain(`*${n} calls declined last week (Nov 2–8)*`);
    expect(text).toContain("At or over 15 for the week");
  });

  it("shows a repeat caller once, with how many times they called", () => {
    const rows = [
      { ...row("2026-11-03T15:00:00Z", null, "same"), label: "Patty, Hillsdale: barn plumbing before winter" },
      { ...row("2026-11-04T15:00:00Z", null, "same"), label: "Patty again" },
      { ...row("2026-11-05T15:00:00Z", "busy", "same"), label: "Logged with /trinity: busy" },
      { ...row("2026-11-05T16:00:00Z", null, "other"), label: "Jane Doe, Rensselaer: no hot water" },
      { ...row("2026-11-06T16:00:00Z", null, "other"), label: "Jane Doe" },
    ];
    const text = formatWeeklyReport(rows, MONDAY_MORNING);
    expect(text).toContain("*2 calls declined last week (Nov 2–8)*");
    expect(text).toContain("• Patty, Hillsdale: barn plumbing before winter (called 3 times)");
    expect(text).toContain("• Jane Doe, Rensselaer: no hot water (called twice)");
    expect(text).not.toContain("Patty again");
  });

  it("caps the list at 25 lines with a count of the rest", () => {
    const text = formatWeeklyReport(lastWeek(30), MONDAY_MORNING);
    const bullets = text.split("\n").filter((l) => l.startsWith("• "));
    expect(bullets).toHaveLength(25);
    expect(text).toContain("• Caller 25\n… and 5 more\n");
    expect(text).toContain("*30 calls declined last week (Nov 2–8)*");
  });

  it("falls back to (no details) for a row without a label", () => {
    expect(formatWeeklyReport([row("2026-11-04T15:00:00Z")], MONDAY_MORNING)).toContain("• (no details)");
  });

  it("shows the 4-week average separately from the single week", () => {
    const rows = [
      ...lastWeek(16), // Nov 2–8
      ...Array.from({ length: 8 }, () => row("2026-10-28T15:00:00Z")), // Oct 26–Nov 1
      ...Array.from({ length: 10 }, () => row("2026-10-21T15:00:00Z")), // Oct 19–25
      ...Array.from({ length: 6 }, () => row("2026-10-14T15:00:00Z")), // Oct 12–18
      ...Array.from({ length: 50 }, () => row("2026-10-07T15:00:00Z")), // 5 weeks back: excluded
    ];
    const text = formatWeeklyReport(rows, MONDAY_MORNING);
    expect(text).toContain("4-week average: 10.0 a week."); // (16+8+10+6)/4
    expect(text).toContain("At or over 15 for the week");
  });

  it("counts month to date from the 1st, including a Sunday that belongs to last month's week", () => {
    const rows = [
      row("2026-10-31T15:00:00Z"), // October: excluded
      row("2026-11-01T15:00:00Z"), // Sun 1 Nov
      ...lastWeek(3),
      row("2026-11-09T11:00:00Z"), // this morning, 6am
    ];
    expect(formatWeeklyReport(rows, MONDAY_MORNING)).toContain("November so far: 5.");
  });
});

describe("lastMonth", () => {
  it("is the previous calendar month, midnight to midnight Eastern", () => {
    // Mon 1 Dec 2025, 7am EST.
    expect(lastMonth(new Date("2025-12-01T12:00:00Z"))).toEqual({
      startIso: "2025-11-01T04:00:00.000Z", // 1 Nov, still EDT
      endIso: "2025-12-01T05:00:00.000Z", // 1 Dec, EST
    });
  });

  it("goes from January back to December of the year before", () => {
    const range = lastMonth(new Date("2027-01-01T11:00:00Z"));
    expect(range).toEqual({ startIso: "2026-12-01T05:00:00.000Z", endIso: "2027-01-01T05:00:00.000Z" });
    expect(monthKey(range)).toBe("2026-12");
    expect(monthLabel(range)).toBe("December 2026");
  });

  it("spans the March change to summer time (DST starts 8 Mar 2026)", () => {
    expect(lastMonth(new Date("2026-04-01T10:00:00Z"))).toEqual({
      startIso: "2026-03-01T05:00:00.000Z", // EST
      endIso: "2026-04-01T04:00:00.000Z", // EDT
    });
  });

  it("spans the November change back (DST ends 1 Nov 2026)", () => {
    const november = lastMonth(new Date("2026-12-01T11:00:00Z"));
    expect(november).toEqual({ startIso: "2026-11-01T04:00:00.000Z", endIso: "2026-12-01T05:00:00.000Z" });

    const rows = [
      row("2026-11-01T03:30:00Z"), // Sat 31 Oct, 11:30pm EDT: October
      row("2026-11-01T04:30:00Z"), // Sun 1 Nov, 12:30am EDT: November
      row("2026-12-01T04:30:00Z"), // Mon 30 Nov, 11:30pm EST: November
      row("2026-12-01T05:30:00Z"), // Tue 1 Dec, 12:30am EST: December
    ];
    expect(inRange(rows, november).map((r) => r.created_at)).toEqual(["2026-11-01T04:30:00Z", "2026-12-01T04:30:00Z"]);
  });

  it("goes by the Eastern date, not the UTC one", () => {
    // 1 Aug 02:00 UTC is still 31 Jul in Eastern, so last month is June.
    expect(monthKey(lastMonth(new Date("2026-08-01T02:00:00Z")))).toBe("2026-06");
  });
});

describe("monthBefore", () => {
  it("steps back one month, across a year end", () => {
    const dec = lastMonth(new Date("2027-01-01T11:00:00Z"));
    expect(monthKey(monthBefore(dec))).toBe("2026-11");
    expect(monthKey(monthBefore(lastMonth(new Date("2026-02-01T11:00:00Z"))))).toBe("2025-12");
  });
});

describe("comparisonLine", () => {
  it.each([
    [23, 19, "Up 4 from September (19)."],
    [16, 19, "Down 3 from September (19)."],
    [19, 19, "Same as September (19)."],
    [5, 0, "Up 5 from September (0)."],
    [0, 0, "Same as September (0)."],
    [0, 7, "Down 7 from September (7)."],
  ])("%i against %i", (current, previous, expected) => {
    expect(comparisonLine(current, previous, "September")).toBe(expected);
  });
});

describe("formatMonthlyReport", () => {
  // Sun 1 Nov 2026, 6:15am EST (DST ended at 2am). Reports October.
  const FIRST = new Date("2026-11-01T11:15:00Z");

  function october(n: number): DeclinedRow[] {
    return Array.from({ length: n }, (_, i) => ({ ...row("2026-10-14T15:00:00Z", null, `p${i}`), label: `Caller ${i + 1}` }));
  }
  const september = (n: number) => Array.from({ length: n }, () => row("2026-09-16T15:00:00Z"));

  it("lists each call, then the comparison and the weekly rate", () => {
    expect(formatMonthlyReport([...october(3), ...september(5)], FIRST)).toBe(
      [
        "*3 calls declined last month (October 2026)*",
        "• Caller 1",
        "• Caller 2",
        "• Caller 3",
        "Down 2 from September (5). About 0.7 a week.", // 3 / (31/7)
      ].join("\n")
    );
  });

  it("with an empty month, says 0 and lists nothing", () => {
    expect(formatMonthlyReport(september(4), FIRST)).toBe(
      ["*0 calls declined last month (October 2026)*", "Down 4 from September (4). About 0.0 a week."].join("\n")
    );
  });

  it("with nothing at all, says the same as the month before", () => {
    expect(formatMonthlyReport([], FIRST)).toBe(
      ["*0 calls declined last month (October 2026)*", "Same as September (0). About 0.0 a week."].join("\n")
    );
  });

  it("says 1 call, not 1 calls", () => {
    expect(formatMonthlyReport(october(1), FIRST)).toContain("*1 call declined last month (October 2026)*");
  });

  it("leaves out calls from either side of the month, and this morning's", () => {
    const rows = [
      row("2026-09-30T15:00:00Z"), // September
      row("2026-10-01T03:59:00Z"), // 30 Sep, 11:59pm EDT: September
      row("2026-10-01T04:00:00Z"), // 1 Oct, midnight EDT: October
      row("2026-11-01T03:59:00Z"), // 31 Oct, 11:59pm EDT: October
      row("2026-11-01T10:00:00Z"), // 1 Nov, 5am EST: November
    ];
    const text = formatMonthlyReport(rows, FIRST);
    expect(text.split("\n")[0]).toBe("*2 calls declined last month (October 2026)*");
    expect(text).toContain("Same as September (2).");
  });

  it("counts a repeat caller once a week, as the Monday post does, and lists them once that week", () => {
    const rows = [
      { ...row("2026-10-13T15:00:00Z", null, "same"), label: "Patty, Hillsdale: barn plumbing" },
      { ...row("2026-10-15T15:00:00Z", "busy", "same"), label: "Logged with /trinity: busy" },
      { ...row("2026-10-21T15:00:00Z", null, "same"), label: "Patty, Hillsdale: barn plumbing" }, // next week: counts again
    ];
    const text = formatMonthlyReport(rows, FIRST);
    expect(text).toContain("*2 calls declined last month (October 2026)*");
    expect(text).toContain("• Patty, Hillsdale: barn plumbing (called twice)\n• Patty, Hillsdale: barn plumbing\n");
  });

  it("caps the list at 25 lines with a count of the rest", () => {
    const text = formatMonthlyReport(october(40), FIRST);
    expect(text.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(25);
    expect(text).toContain("• Caller 25\n… and 15 more\n");
    expect(text).toContain("*40 calls declined last month (October 2026)*");
    expect(text).toContain("About 9.0 a week."); // 40 / (31/7)
  });

  it("reports December against November on 1 January", () => {
    const rows = [row("2026-12-02T15:00:00Z"), row("2027-01-01T04:30:00Z"), row("2026-11-20T15:00:00Z")];
    expect(formatMonthlyReport(rows, new Date("2027-01-01T11:00:00Z"))).toBe(
      [
        "*2 calls declined last month (December 2026)*",
        "• (no details)",
        "• (no details)",
        "Up 1 from November (1). About 0.5 a week.",
      ].join("\n")
    );
  });

  it("uses a 28-day February for the weekly rate", () => {
    const feb = Array.from({ length: 8 }, () => row("2027-02-10T15:00:00Z"));
    expect(formatMonthlyReport(feb, new Date("2027-03-01T11:00:00Z"))).toContain("About 2.0 a week.");
  });
});

describe("formatMonthPreview", () => {
  // Sun 15 Nov 2026, 12:00am EST: exactly 14 days into the month.
  const NOW = new Date("2026-11-15T05:00:00Z");

  it("shows this month so far against all of last month", () => {
    const rows = [
      { ...row("2026-11-03T15:00:00Z"), label: "Jane Doe" },
      { ...row("2026-11-10T15:00:00Z"), label: "John Roe" },
      row("2026-10-20T15:00:00Z"),
      row("2026-10-21T15:00:00Z"),
      row("2026-10-22T15:00:00Z"),
    ];
    expect(formatMonthPreview(rows, NOW)).toBe(
      [
        "*Preview: 2 calls declined this month so far (November 2026)*",
        "• Jane Doe",
        "• John Roe",
        "October in full: 3. About 1.0 a week so far.", // 2 calls / 2 weeks
      ].join("\n")
    );
  });
});
