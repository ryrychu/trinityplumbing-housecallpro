import { describe, it, expect } from "vitest";
import type { FieldyTask } from "../client";
import {
  bucketOf,
  completedWindow,
  dayKeyOf,
  ageLabel,
  pendingTasks,
  completedTasks,
} from "../report";

// Saturday 14 Nov 2026, 08:00 EST.
const SAT_8AM = new Date("2026-11-14T13:00:00Z");

let n = 0;
function task(over: Partial<FieldyTask> = {}): FieldyTask {
  n += 1;
  return { id: `t${n}`, title: `Task ${n}`, status: "new", date: null, completionDate: null, ...over };
}

describe("bucketOf", () => {
  it.each([
    ["new", "pending"],
    ["approved", "pending"],
    ["completed", "completed"],
    ["rejected", "closed"],
    ["skipped", "closed"],
    ["cancelled", "closed"],
    ["expired", "closed"],
    ["something-new", "closed"],
    ["", "closed"],
  ])("puts %j in %s", (status, bucket) => {
    expect(bucketOf(status)).toBe(bucket);
  });
});

describe("completedWindow", () => {
  it("is yesterday, midnight to midnight Eastern", () => {
    expect(completedWindow(SAT_8AM)).toEqual({
      startIso: "2026-11-13T05:00:00.000Z",
      endIso: "2026-11-14T05:00:00.000Z",
    });
  });

  it("is 25 hours long the day the clocks go back (Sun 1 Nov 2026)", () => {
    expect(completedWindow(new Date("2026-11-02T13:00:00Z"))).toEqual({
      startIso: "2026-11-01T04:00:00.000Z",
      endIso: "2026-11-02T05:00:00.000Z",
    });
  });

  it("is 23 hours long the day the clocks go forward (Sun 8 Mar 2026)", () => {
    expect(completedWindow(new Date("2026-03-09T12:00:00Z"))).toEqual({
      startIso: "2026-03-08T05:00:00.000Z",
      endIso: "2026-03-09T04:00:00.000Z",
    });
  });

  it("does not depend on what time of day the post runs", () => {
    expect(completedWindow(new Date("2026-11-14T05:00:00Z"))).toEqual(completedWindow(new Date("2026-11-15T04:59:00Z")));
  });
});

describe("dayKeyOf", () => {
  it("gives the Eastern calendar day of an instant", () => {
    expect(dayKeyOf("2026-11-14T03:30:00Z")).toBe("2026-11-13"); // 22:30 EST the day before
  });

  it("keeps a date-only value on its own day instead of shifting it to the evening before", () => {
    expect(dayKeyOf("2026-11-20")).toBe("2026-11-20");
  });

  it("returns null for null or nonsense", () => {
    expect(dayKeyOf(null)).toBeNull();
    expect(dayKeyOf("soon")).toBeNull();
  });
});

describe("ageLabel", () => {
  it.each([
    ["2026-11-11T15:00:00Z", "3 days"],
    ["2026-11-13T23:00:00Z", "1 day"], // 18:00 EST Friday
    ["2026-11-14T06:00:00Z", "today"],
    ["2026-11-14", "today"],
    ["2026-11-20", "due Nov 20"],
    ["2026-12-01T15:00:00Z", "due Dec 1"],
  ])("labels %s as %j", (date, label) => {
    expect(ageLabel(task({ date }), SAT_8AM)).toBe(label);
  });

  it("is null when the task has no date", () => {
    expect(ageLabel(task({ date: null }), SAT_8AM)).toBeNull();
  });

  it("counts calendar days across the fall-back weekend", () => {
    // Sat 31 Oct 23:30 EDT to Mon 2 Nov: two calendar days, though 49.5 hours.
    expect(ageLabel(task({ date: "2026-11-01T03:30:00Z" }), new Date("2026-11-02T13:00:00Z"))).toBe("2 days");
  });
});

describe("pendingTasks", () => {
  it("keeps new and approved, oldest first, undated last", () => {
    const tasks = [
      task({ id: "undated", status: "new" }),
      task({ id: "recent", status: "approved", date: "2026-11-12T15:00:00Z" }),
      task({ id: "old", status: "new", date: "2026-11-01T15:00:00Z" }),
      task({ id: "done", status: "completed", date: "2026-10-01T15:00:00Z" }),
      task({ id: "gone", status: "cancelled", date: "2026-10-01T15:00:00Z" }),
    ];
    expect(pendingTasks(tasks).map((t) => t.id)).toEqual(["old", "recent", "undated"]);
  });
});

describe("completedTasks", () => {
  it("keeps tasks marked done yesterday (Eastern), in the order they were done", () => {
    const tasks = [
      task({ id: "late", status: "completed", completionDate: "2026-11-14T04:59:00Z" }), // Fri 23:59 EST
      task({ id: "early", status: "completed", completionDate: "2026-11-13T05:00:00Z" }), // Fri 00:00 EST
      task({ id: "thu", status: "completed", completionDate: "2026-11-13T04:59:00Z" }),
      task({ id: "sat", status: "completed", completionDate: "2026-11-14T05:00:00Z" }),
      task({ id: "undated", status: "completed", completionDate: null }),
      task({ id: "open", status: "new", completionDate: "2026-11-13T15:00:00Z" }),
    ];
    expect(completedTasks(tasks, SAT_8AM).map((t) => t.id)).toEqual(["early", "late"]);
  });

  it("uses the 25-hour day when the clocks go back", () => {
    const MON = new Date("2026-11-02T13:00:00Z");
    const tasks = [
      task({ id: "sat-night", status: "completed", completionDate: "2026-11-01T03:59:00Z" }),
      task({ id: "sun-start", status: "completed", completionDate: "2026-11-01T04:00:00Z" }),
      task({ id: "sun-end", status: "completed", completionDate: "2026-11-02T04:59:00Z" }),
      task({ id: "mon", status: "completed", completionDate: "2026-11-02T05:00:00Z" }),
    ];
    expect(completedTasks(tasks, MON).map((t) => t.id)).toEqual(["sun-start", "sun-end"]);
  });
});
