import { describe, it, expect, vi, beforeEach } from "vitest";
import { FieldyApiError } from "@/lib/fieldy/client";
import { buildChecklist, markDone } from "../checklist";
import { NOT_ALLOWED_TEXT, handleChecklistTap, optionValuesFor, type BlockActionsPayload } from "../interact";
import { validateGrouping } from "../organize";
import { makeDeps, task } from "./fakes";

const DAVE = "U_DAVE";
const TASKS = [task("t1", "Order the Navien"), task("t2", "Call Mrs. Smith"), task("t3", "Van list")];

async function setup() {
  const ctx = makeDeps({ tasks: TASKS });
  const id = await buildChecklist(
    ctx.deps,
    validateGrouping([{ name: "A", items: [{ taskId: "t1" }, { taskId: "t2" }] }, { name: "B", items: [{ taskId: "t3" }] }], TASKS),
    "morning_ai",
    0
  );
  const note = vi.fn(async () => true);
  // What Slack sends: the message as Dave saw it, and the boxes now ticked in the one element he tapped.
  const tap = (actionId: string, selected: string[], user = DAVE): BlockActionsPayload => ({
    type: "block_actions",
    user: { id: user },
    response_url: "https://hooks.slack.com/actions/x",
    message: { blocks: ctx.slack.lastBlocks() },
    actions: [{ action_id: actionId, selected_options: selected.map((value) => ({ value })) }],
  });
  return { ...ctx, id, note, tap };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("handleChecklistTap", () => {
  it("ticks a box: Fieldy completed, item done via slack, message re-rendered", async () => {
    const { deps, fieldy, slack, items, id, note, tap } = await setup();
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, ["t2"]), deps, { allowedUsers: [DAVE], note });
    expect(fieldy.updates.map(([tid, u]) => [tid, u.status])).toEqual([["t2", "completed"]]);
    expect(items.get(id)!.find((i) => i.fieldyTaskId === "t2")).toMatchObject({ doneVia: "slack" });
    expect(slack.updates).toHaveLength(1);
    expect(note).not.toHaveBeenCalled();
  });

  it("unticks a box and leaves the other group alone", async () => {
    const { deps, fieldy, items, id, note, tap } = await setup();
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, ["t1", "t2"]), deps, { allowedUsers: [DAVE], note });
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, ["t2"]), deps, { allowedUsers: [DAVE], note });
    expect(fieldy.updates.map(([tid, u]) => [tid, u.status])).toEqual([
      ["t1", "completed"],
      ["t2", "completed"],
      ["t1", "approved"],
    ]);
    expect(items.get(id)!.find((i) => i.fieldyTaskId === "t3")!.doneAt).toBeNull();
  });

  it("ticks from an out-of-date message without reopening what was ticked since", async () => {
    const { deps, fieldy, slack, items, id, note, tap } = await setup();
    const stale = slack.lastBlocks(); // the message before t1 was ticked elsewhere
    await markDone(deps, id, ["t1"], "chatgpt");
    const payload = { ...tap(`fieldy_cb:${id}:0`, ["t2"]), message: { blocks: stale } };
    await handleChecklistTap(payload, deps, { allowedUsers: [DAVE], note });
    expect(fieldy.updates.map(([tid, u]) => [tid, u.status])).toEqual([
      ["t1", "completed"],
      ["t2", "completed"],
    ]);
    expect(fieldy.updates.some(([tid, u]) => tid === "t1" && u.status === "approved")).toBe(false);
    const done = items.get(id)!.filter((i) => i.doneAt !== null).map((i) => i.fieldyTaskId);
    expect(done).toEqual(["t1", "t2"]);
  });

  it("applies nothing and re-renders when a tap would untick two boxes at once", async () => {
    const { deps, fieldy, slack, items, id, note, tap } = await setup();
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, ["t1", "t2"]), deps, { allowedUsers: [DAVE], note });
    const fieldyBefore = fieldy.updates.length;
    const updatesBefore = slack.updates.length;
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, []), deps, { allowedUsers: [DAVE], note });
    expect(fieldy.updates).toHaveLength(fieldyBefore);
    expect(slack.updates).toHaveLength(updatesBefore + 1);
    const done = items.get(id)!.filter((i) => i.doneAt !== null).map((i) => i.fieldyTaskId);
    expect(done).toEqual(["t1", "t2"]);
    expect(note).not.toHaveBeenCalled();
  });

  it("snaps back and tells anyone else only Dave can tick", async () => {
    const { deps, fieldy, slack, id, note, tap } = await setup();
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, ["t1"], "U_ELLA"), deps, { allowedUsers: [DAVE], note });
    expect(fieldy.updates).toHaveLength(0);
    expect(slack.updates).toHaveLength(1);
    expect(note).toHaveBeenCalledWith("https://hooks.slack.com/actions/x", NOT_ALLOWED_TEXT);
  });

  it("snaps back and explains when Fieldy fails", async () => {
    const { deps, fieldy, slack, items, id, note, tap } = await setup();
    fieldy.failUpdateAt(1, new FieldyApiError("http_401", "PATCH /tasks/{id}"));
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, ["t1"]), deps, { allowedUsers: [DAVE], note });
    expect(items.get(id)!.every((i) => i.doneAt === null)).toBe(true);
    expect(slack.updates).toHaveLength(1);
    expect(note).toHaveBeenCalledWith("https://hooks.slack.com/actions/x", expect.stringMatching(/^Couldn't update Fieldy: http_401\./));
  });

  it("ignores actions that aren't checklist boxes, and unknown checklists", async () => {
    const { deps, fieldy, slack, note, tap } = await setup();
    await handleChecklistTap(tap("something_else", ["t1"]), deps, { allowedUsers: [DAVE], note });
    await handleChecklistTap(tap("fieldy_cb:999:0", ["t1"]), deps, { allowedUsers: [DAVE], note });
    expect(fieldy.updates).toHaveLength(0);
    expect(slack.updates).toHaveLength(0);
  });
});

describe("optionValuesFor", () => {
  it("finds the option values of one checkboxes element", () => {
    const blocks = [{ type: "actions", elements: [{ action_id: "fieldy_cb:1:0", options: [{ value: "a" }, { value: "b" }] }] }];
    expect(optionValuesFor(blocks, "fieldy_cb:1:0")).toEqual(["a", "b"]);
    expect(optionValuesFor(blocks, "fieldy_cb:1:9")).toBeNull();
  });
});
