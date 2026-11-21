import { describe, it, expect } from "vitest";
import { MAX_GROUPS, MAX_ITEMS, OTHER_GROUP, fitText, groupByRules, validateGrouping } from "../organize";
import { NOW, task } from "./fakes";

const OPEN = [
  task("t1", "Order Navien NPE-240A for the Troy job", { date: "2026-11-20" }),
  task("t2", "Call back Mrs. Smith about the water heater quote", { date: "2026-11-23" }),
  task("t3", "Send Dylan the van inventory list"),
];

describe("fitText", () => {
  it("flattens whitespace and cuts long text with an ellipsis", () => {
    expect(fitText("  a\n  b  ")).toBe("a b");
    const long = "x".repeat(100);
    expect(fitText(long)).toHaveLength(75);
    expect(fitText(long).endsWith("…")).toBe(true);
  });

  it("never splits an emoji, counting code points against the limit", () => {
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(fitText(`${"a".repeat(74)}😀`)).toBe(`${"a".repeat(74)}😀`); // 75 code points: fits
    for (let n = 70; n <= 80; n++) {
      const out = fitText(`${"a".repeat(n)}😀😀bb`);
      expect(loneSurrogate.test(out)).toBe(false);
      expect(Array.from(out).length).toBeLessThanOrEqual(75);
    }
  });
});

describe("validateGrouping", () => {
  it("keeps the proposed groups and text for known tasks", () => {
    const g = validateGrouping(
      [
        { name: "Troy job", items: [{ taskId: "t1", text: "Order the Navien" }] },
        { name: "Calls", items: [{ taskId: "t2", text: "Call Mrs. Smith" }, { taskId: "t3", text: "Dylan: van list" }] },
      ],
      OPEN
    );
    expect(g.groups).toEqual([
      { name: "Troy job", items: [{ taskId: "t1", text: "Order the Navien" }] },
      { name: "Calls", items: [{ taskId: "t2", text: "Call Mrs. Smith" }, { taskId: "t3", text: "Dylan: van list" }] },
    ]);
    expect(g).toMatchObject({ overflow: 0, movedToOther: [], dropped: [] });
  });

  it("drops unknown and repeated ids and never invents a task", () => {
    const g = validateGrouping([{ name: "A", items: [{ taskId: "t1" }, { taskId: "nope" }, { taskId: "t1" }] }], OPEN);
    expect(g.dropped).toEqual(["nope", "t1"]);
    expect(g.groups.flatMap((x) => x.items.map((i) => i.taskId)).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("puts open tasks the grouping left out under Other, last", () => {
    const g = validateGrouping([{ name: "Troy job", items: [{ taskId: "t1" }] }], OPEN);
    expect(g.groups.map((x) => x.name)).toEqual(["Troy job", OTHER_GROUP]);
    expect(g.movedToOther).toEqual(["t2", "t3"]);
  });

  it("uses the Fieldy title when the text is empty", () => {
    const g = validateGrouping([{ name: "A", items: [{ taskId: "t3", text: "   " }] }], [OPEN[2]]);
    expect(g.groups[0].items[0].text).toBe("Send Dylan the van inventory list");
  });

  it("merges groups with the same name, ignoring case", () => {
    const g = validateGrouping([{ name: "Calls", items: [{ taskId: "t2" }] }, { name: "calls", items: [{ taskId: "t3" }] }], OPEN.slice(1));
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0].items.map((i) => i.taskId)).toEqual(["t2", "t3"]);
  });

  it("folds groups past the cap into Other", () => {
    const many = Array.from({ length: 15 }, (_, i) => task(`g${i}`, `Task ${i}`));
    const g = validateGrouping(
      many.map((t) => ({ name: `Group ${t.id}`, items: [{ taskId: t.id }] })),
      many
    );
    expect(g.groups).toHaveLength(MAX_GROUPS);
    expect(g.groups[MAX_GROUPS - 1].name).toBe(OTHER_GROUP);
    expect(g.groups[MAX_GROUPS - 1].items).toHaveLength(15 - (MAX_GROUPS - 1));
  });

  it("caps the checklist at MAX_ITEMS and counts the rest as overflow", () => {
    const many = Array.from({ length: 45 }, (_, i) => task(`m${i}`, `Task ${i}`));
    const g = validateGrouping([{ name: "All", items: many.map((t) => ({ taskId: t.id })) }], many);
    expect(g.groups[0].items).toHaveLength(MAX_ITEMS);
    expect(g.overflow).toBe(5);
  });
});

describe("groupByRules", () => {
  it("groups into Overdue, Due today, No date and Later, skipping empty groups", () => {
    const later = task("t4", "Winterize the Delmar cabin", { date: "2026-12-01" });
    const groups = groupByRules([...OPEN, later], NOW);
    expect(groups.map((g) => g.name)).toEqual(["Overdue", "Due today", "No date", "Later"]);
    expect(groups[0].items).toEqual([{ taskId: "t1", text: "Order Navien NPE-240A for the Troy job" }]);
    expect(groupByRules([OPEN[2]], NOW).map((g) => g.name)).toEqual(["No date"]);
  });

  it("ignores tasks that aren't open", () => {
    expect(groupByRules([task("x", "Done", { status: "completed" })], NOW)).toEqual([]);
  });
});
