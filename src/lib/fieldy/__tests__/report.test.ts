import { describe, it, expect } from "vitest";
import type { FieldyTask } from "../client";
import {
  bucketOf,
  completedWindow,
  dayKeyOf,
  ageLabel,
  pendingTasks,
  completedTasks,
  formatFieldyPost,
  LIST_MAX,
  FOOTNOTE,
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

describe("formatFieldyPost", () => {
  it("lists pending with ages and yesterday's completed, then the footnote", () => {
    const tasks = [
      task({ title: "Order PRV valve", date: "2026-11-11T15:00:00Z" }),
      task({ title: "Call back about the boiler", status: "approved", date: "2026-11-02T15:00:00Z" }),
      task({ title: "Quote for bathroom", date: "2026-11-20" }),
      task({ title: "Look into van insurance" }),
      task({ title: "Return Ferguson parts", status: "completed", completionDate: "2026-11-13T19:00:00Z" }),
    ];
    expect(formatFieldyPost(tasks, SAT_8AM)).toBe(
      [
        "*Dave's Fieldy tasks, Sat Nov 14*",
        "*Pending: 4*, oldest first",
        "• Call back about the boiler (12 days)",
        "• Order PRV valve (3 days)",
        "• Quote for bathroom (due Nov 20)",
        "• Look into van insurance",
        "*Completed yesterday (Fri Nov 13): 1*",
        "• Return Ferguson parts",
        FOOTNOTE,
      ].join("\n")
    );
  });

  it("says so in one line when there is nothing at all", () => {
    expect(formatFieldyPost([task({ status: "cancelled" })], SAT_8AM)).toBe(
      ["*Dave's Fieldy tasks, Sat Nov 14*", "No open tasks, and nothing marked done yesterday (Fri Nov 13).", FOOTNOTE].join(
        "\n"
      )
    );
  });

  it("says none for an empty section when the other has tasks", () => {
    const text = formatFieldyPost([task({ title: "Only open one" })], SAT_8AM);
    expect(text).toContain("*Completed yesterday (Fri Nov 13):* none");
    const done = formatFieldyPost([task({ status: "completed", completionDate: "2026-11-13T19:00:00Z" })], SAT_8AM);
    expect(done).toContain("*Pending:* none");
  });

  it(`lists at most ${LIST_MAX} per section and sums up the rest`, () => {
    const pending = Array.from({ length: 30 }, (_, i) =>
      task({ title: `Open ${i}`, date: `2026-10-${String(i + 1).padStart(2, "0")}T15:00:00Z` })
    );
    const done = Array.from({ length: 27 }, (_, i) =>
      task({ title: `Done ${i}`, status: "completed", completionDate: `2026-11-13T${String(6 + (i % 18)).padStart(2, "0")}:00:00Z` })
    );
    const lines = formatFieldyPost([...pending, ...done], SAT_8AM).split("\n");

    expect(lines).toContain("*Pending: 30*, oldest first");
    expect(lines).toContain("… and 5 more");
    expect(lines).toContain("*Completed yesterday (Fri Nov 13): 27*");
    expect(lines).toContain("… and 2 more");
    expect(lines.filter((l) => l.startsWith("• Open"))).toHaveLength(LIST_MAX);
    expect(lines.filter((l) => l.startsWith("• Done"))).toHaveLength(LIST_MAX);
    expect(lines).toContain("• Open 0 (44 days)");
  });

  it("shows a task once if it moved from new to completed between the two reads", () => {
    const text = formatFieldyPost(
      [
        task({ id: "same", title: "Fix the leak", status: "new" }),
        task({ id: "same", title: "Fix the leak", status: "completed", completionDate: "2026-11-13T19:00:00Z" }),
      ],
      SAT_8AM
    );
    expect(text.match(/Fix the leak/g)).toHaveLength(1);
    expect(text).toContain("*Pending:* none");
  });

  it("escapes Slack markup, flattens newlines and shortens very long titles", () => {
    const text = formatFieldyPost(
      [task({ title: "Ping <!channel> & <@U123>\nsecond line" }), task({ title: "x".repeat(400) })],
      SAT_8AM
    );
    expect(text).toContain("• Ping &lt;!channel&gt; &amp; &lt;@U123&gt; second line");
    expect(text).not.toContain("<!channel>");
    const long = text.split("\n").find((l) => l.startsWith("• xxx"))!;
    expect(long.length).toBeLessThanOrEqual(2 + 150);
    expect(long.endsWith("…")).toBe(true);
  });

  it("heads a preview so it can't be mistaken for the real post", () => {
    expect(formatFieldyPost([], SAT_8AM, { preview: true }).split("\n")[0]).toBe(
      "*Preview: Dave's Fieldy tasks, Sat Nov 14*"
    );
  });
});
