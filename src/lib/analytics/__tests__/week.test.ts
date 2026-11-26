import { describe, it, expect } from "vitest";
import { reportWeeks } from "../week";

describe("reportWeeks", () => {
  it("on a Monday morning reports the Mon–Sun just ended against the one before", () => {
    // Mon Nov 23 2026, 9:00 AM EST.
    expect(reportWeeks(new Date("2026-11-23T14:00:00Z"))).toEqual({
      week: { startDate: "2026-11-16", endDate: "2026-11-22", label: "Nov 16–22", key: "2026-11-16" },
      previousWeek: { startDate: "2026-11-09", endDate: "2026-11-15", label: "Nov 9–15", key: "2026-11-09" },
    });
  });

  it("decides the day in Eastern time, not UTC", () => {
    // 11:30 PM Sunday Nov 22 in Albany is already Monday in UTC.
    expect(reportWeeks(new Date("2026-11-23T04:30:00Z")).week.startDate).toBe("2026-11-09");
    // 12:30 AM Monday Nov 23 in Albany.
    expect(reportWeeks(new Date("2026-11-23T05:30:00Z")).week.startDate).toBe("2026-11-16");
  });

  it("handles the fall-back week (clocks change Sun Nov 1 2026)", () => {
    const w = reportWeeks(new Date("2026-11-02T14:00:00Z")); // Mon 9:00 AM EST
    expect(w.week).toEqual({ startDate: "2026-10-26", endDate: "2026-11-01", label: "Oct 26–Nov 1", key: "2026-10-26" });
    expect(w.previousWeek).toMatchObject({ startDate: "2026-10-19", endDate: "2026-10-25" });
  });

  it("handles the spring-forward week (clocks change Sun Mar 8 2026)", () => {
    const w = reportWeeks(new Date("2026-03-09T14:00:00Z")); // Mon 10:00 AM EDT
    expect(w.week).toMatchObject({ startDate: "2026-03-02", endDate: "2026-03-08" });
    expect(w.previousWeek).toMatchObject({ startDate: "2026-02-23", endDate: "2026-03-01", label: "Feb 23–Mar 1" });
  });

  it("goes back whole weeks with weeksAgo, across a DST change", () => {
    const w = reportWeeks(new Date("2026-11-23T14:00:00Z"), 12);
    expect(w.week).toMatchObject({ startDate: "2026-08-24", endDate: "2026-08-30" });
    expect(w.previousWeek).toMatchObject({ startDate: "2026-08-17", endDate: "2026-08-23" });
  });

  it("mid-week still reports the last full week", () => {
    // Thu Nov 26 2026.
    expect(reportWeeks(new Date("2026-11-26T17:00:00Z")).week.startDate).toBe("2026-11-16");
  });
});
