import { describe, it, expect } from "vitest";
import { OPTION_TEXT_MAX, actionId, layoutChecklist, optionLabel, parseActionId, renderChecklistMessage, renderChecklistPreview } from "../render";
import type { ChecklistRow, ItemRow } from "../store";

const CL: ChecklistRow = {
  id: 7,
  day: "2026-11-23",
  channelId: "C1",
  messageTs: "171.1",
  builtBy: "morning_ai",
  version: 2,
  renderedVersion: 1,
  overflow: 0,
  finishedYesterday: 3,
};

function item(n: number, group: string, done = false): ItemRow {
  return {
    checklistId: 7,
    position: n,
    groupName: group,
    text: `Task ${n}`,
    fieldyTaskId: `t${n}`,
    doneAt: done ? "2026-11-23T14:00:00.000Z" : null,
    doneVia: done ? "slack" : null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = { type: string; text?: { text: string }; elements?: Array<Record<string, any>> };

describe("renderChecklistMessage", () => {
  it("has a heading, a label and checkboxes per group, and a footer", () => {
    const msg = renderChecklistMessage(CL, [item(1, "Troy job"), item(2, "Calls", true), item(3, "Calls")]);
    const blocks = msg.blocks as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["header", "section", "actions", "section", "actions", "context"]);
    expect(blocks[0].text!.text).toBe("Dave's checklist, Mon Nov 23");
    expect(blocks[1].text!.text).toBe("*Troy job*");
    const calls = blocks[4].elements![0];
    expect(calls).toMatchObject({ type: "checkboxes", action_id: "fieldy_cb:7:1" });
    expect(calls.options.map((o: { value: string }) => o.value)).toEqual(["t2", "t3"]);
    expect(calls.options[0].text.text).toBe("~Task 2~");
    expect(calls.initial_options).toEqual([calls.options[0]]);
    expect(blocks[2].elements![0].initial_options).toBeUndefined();
    expect(blocks[5].elements![0].text).toBe("1 of 3 done · Finished yesterday: 3");
    expect(msg.text).toBe("Dave's checklist, Mon Nov 23: 1 of 3 done");
  });

  it("splits a group into checkboxes of at most 10 and stays under 50 blocks at the caps", () => {
    const items = Array.from({ length: 40 }, (_, i) => item(i + 1, i < 25 ? "Big" : `G${i % 11}`));
    const blocks = renderChecklistMessage(CL, items).blocks as Block[];
    expect(blocks.length).toBeLessThanOrEqual(50);
    const big = blocks[2].elements!;
    expect(big.map((e) => e.options.length)).toEqual([10, 10, 5]);
    const ids = blocks.flatMap((b) => (b.type === "actions" ? b.elements!.map((e) => e.action_id) : []));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("adds the overflow and the no-AI notes to the footer", () => {
    const blocks = renderChecklistMessage({ ...CL, overflow: 4, builtBy: "morning_rules" }, [item(1, "A")]).blocks as Block[];
    expect(blocks[blocks.length - 1].elements![0].text).toBe(
      "0 of 1 done · Finished yesterday: 3 · +4 more in Fieldy · Grouped by date; AI grouping didn't run"
    );
  });

  it("says so when there are no tasks", () => {
    const blocks = renderChecklistMessage(CL, []).blocks as Block[];
    expect(blocks[1].text!.text).toBe("No open Fieldy tasks.");
  });
});

describe("optionLabel", () => {
  it("escapes Slack control characters so a title can't ping anyone", () => {
    expect(optionLabel("<!channel> & co", false)).toBe("&lt;!channel&gt; &amp; co");
  });

  it("keeps the label within Slack's limit even after escaping and strikethrough", () => {
    const label = optionLabel("&".repeat(70), true);
    expect(label.length).toBeLessThanOrEqual(OPTION_TEXT_MAX);
    expect(label.startsWith("~")).toBe(true);
    expect(label.endsWith("~")).toBe(true);
  });
});

describe("action ids and layout", () => {
  it("round-trips an action id and rejects others", () => {
    expect(parseActionId(actionId(7, 3))).toEqual({ checklistId: 7, chunk: 3 });
    expect(parseActionId("other:7:3")).toBeNull();
  });

  it("keeps groups in first-appearance order by position", () => {
    const layout = layoutChecklist([item(3, "B"), item(1, "A"), item(2, "B")]);
    expect(layout.map((g) => g.name)).toEqual(["A", "B"]);
    expect(layout[1].chunks[0].items.map((i) => i.fieldyTaskId)).toEqual(["t2", "t3"]);
  });
});

describe("renderChecklistPreview", () => {
  it("is plain mrkdwn with the same footer", () => {
    const text = renderChecklistPreview(
      "2026-11-23",
      { groups: [{ name: "Troy job", items: [{ taskId: "t1", text: "Order the Navien" }] }], overflow: 0, movedToOther: [], dropped: [] },
      "morning_ai",
      2
    );
    expect(text).toBe(
      ["*Preview: Dave's checklist, Mon Nov 23*", "*Troy job*", "• Order the Navien", "_0 of 1 done · Finished yesterday: 2_"].join("\n")
    );
  });
});
