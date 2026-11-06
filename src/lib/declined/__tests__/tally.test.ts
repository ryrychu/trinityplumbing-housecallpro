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
  function lastWeek(n: number, reason: "busy" | "distance" | null = null): DeclinedRow[] {
    return Array.from({ length: n }, (_, i) => row("2026-11-04T15:00:00Z", reason, `p${i}`));
  }

  it("reads simply for Dave", () => {
    expect(formatWeeklyReport(lastWeek(8), MONDAY_MORNING)).toBe(
      [
        "*Last week (Nov 2–8): 8 calls declined.* Under 15 for the week (7 short).",
        "4-week average: 2.0 a week.",
        "November so far: 8.",
      ].join("\n")
    );
  });

  it("at 14 says under", () => {
    const text = formatWeeklyReport(lastWeek(14), MONDAY_MORNING);
    expect(text).toContain("14 calls declined.* Under 15 for the week (1 short).");
    expect(text).not.toContain("At or over");
  });

  it.each([15, 16])("at %i says at or over 15", (n) => {
    expect(formatWeeklyReport(lastWeek(n), MONDAY_MORNING)).toContain(`${n} calls declined.* At or over 15 for the week`);
  });

  it("adds the busy/distance line only when /trinity entries were counted", () => {
    const text = formatWeeklyReport([...lastWeek(5), row("2026-11-05T15:00:00Z", "busy"), row("2026-11-05T16:00:00Z", "distance")], MONDAY_MORNING);
    expect(text).toContain("7 calls declined.");
    expect(text).toContain("Includes 2 logged with /trinity declined (busy 1, distance 1).");
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

  it("says 1 call, not 1 calls", () => {
    expect(formatWeeklyReport(lastWeek(1), MONDAY_MORNING)).toContain("1 call declined.");
  });
});
