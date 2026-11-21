import { describe, it, expect } from "vitest";
import { FieldyApiError } from "@/lib/fieldy/client";
import { ADDED_GROUP, addTask, buildChecklist, markDone, markNotDone, renderChecklist, syncWithFieldy } from "../checklist";
import { validateGrouping } from "../organize";
import { NOW, TODAY, makeDeps, task } from "./fakes";

const TASKS = [task("t1", "Order the Navien"), task("t2", "Call Mrs. Smith"), task("t3", "Van inventory list")];
const GROUPING = validateGrouping(
  [
    { name: "Troy job", items: [{ taskId: "t1" }] },
    { name: "Calls", items: [{ taskId: "t2" }, { taskId: "t3" }] },
  ],
  TASKS
);

async function built() {
  const ctx = makeDeps({ tasks: TASKS });
  const id = await buildChecklist(ctx.deps, GROUPING, "morning_ai", 2);
  return { ...ctx, id };
}

describe("buildChecklist", () => {
  it("posts a new message for today and records it as rendered", async () => {
    const { slack, lists, items, id } = await built();
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0].channel).toBe("C_FIELDY");
    const row = lists.get(id)!;
    expect(row).toMatchObject({ day: TODAY, messageTs: "171.1", builtBy: "morning_ai", finishedYesterday: 2 });
    expect(row.renderedVersion).toBe(row.version);
    expect(items.get(id)!.map((i) => [i.position, i.groupName, i.fieldyTaskId])).toEqual([
      [1, "Troy job", "t1"],
      [2, "Calls", "t2"],
      [3, "Calls", "t3"],
    ]);
  });

  it("rebuilds the same day in place and keeps what Dave already ticked", async () => {
    const { deps, slack, items, id } = await built();
    await markDone(deps, id, ["t1"], "slack");

    // t1 is now completed in Fieldy, so a fresh grouping no longer includes it.
    const regrouped = validateGrouping([{ name: "Everything", items: [{ taskId: "t2" }, { taskId: "t3" }] }], TASKS.slice(1));
    const again = await buildChecklist(deps, regrouped, "chatgpt", 2);

    expect(again).toBe(id);
    expect(slack.posts).toHaveLength(1);
    const rows = items.get(id)!;
    expect(rows.map((i) => [i.groupName, i.fieldyTaskId, i.doneAt !== null])).toEqual([
      ["Everything", "t2", false],
      ["Everything", "t3", false],
      ["Troy job", "t1", true],
    ]);
  });
});

describe("markDone / markNotDone", () => {
  it("marks the task completed in Fieldy, ticks it, and re-renders", async () => {
    const { deps, fieldy, slack, items, id } = await built();
    const r = await markDone(deps, id, ["t2"], "chatgpt");
    expect(r).toEqual({ changed: ["t2"], unchanged: [], notOnChecklist: [] });
    expect(fieldy.updates).toEqual([["t2", { status: "completed", completionDate: NOW.toISOString() }]]);
    expect(items.get(id)!.find((i) => i.fieldyTaskId === "t2")).toMatchObject({ doneAt: NOW.toISOString(), doneVia: "chatgpt" });
    expect(slack.updates).toHaveLength(1);
  });

  it("changes nothing when Fieldy fails", async () => {
    const { deps, fieldy, slack, items, id } = await built();
    fieldy.failUpdateAt(1, new FieldyApiError("http_503", "PATCH /tasks/{id}"));
    await expect(markDone(deps, id, ["t2"], "slack")).rejects.toMatchObject({ code: "http_503" });
    expect(items.get(id)!.every((i) => i.doneAt === null)).toBe(true);
    expect(slack.updates).toHaveLength(0);
  });

  it("keeps the ones Fieldy accepted when a later one fails, then throws", async () => {
    const { deps, fieldy, items, id } = await built();
    fieldy.failUpdateAt(2, new FieldyApiError("http_503", "PATCH /tasks/{id}"));
    await expect(markDone(deps, id, ["t2", "t3"], "slack")).rejects.toMatchObject({ code: "http_503" });
    const done = items.get(id)!.filter((i) => i.doneAt !== null).map((i) => i.fieldyTaskId);
    expect(done).toEqual(["t2"]);
  });

  it("is a no-op the second time", async () => {
    const { deps, fieldy, id } = await built();
    await markDone(deps, id, ["t2"], "slack");
    const r = await markDone(deps, id, ["t2"], "chatgpt");
    expect(r).toEqual({ changed: [], unchanged: ["t2"], notOnChecklist: [] });
    expect(fieldy.updates).toHaveLength(1);
  });

  it("puts a task back to approved and unticks it", async () => {
    const { deps, fieldy, items, id } = await built();
    await markDone(deps, id, ["t2"], "slack");
    await markNotDone(deps, id, ["t2"], "chatgpt");
    expect(fieldy.updates[1]).toEqual(["t2", { status: "approved" }]);
    expect(items.get(id)!.find((i) => i.fieldyTaskId === "t2")).toMatchObject({ doneAt: null, doneVia: null });
  });

  it("still marks Fieldy when there's no checklist today", async () => {
    const { deps, fieldy, slack } = makeDeps({ tasks: TASKS });
    const r = await markDone(deps, null, ["t1"], "chatgpt");
    expect(r).toEqual({ changed: [], unchanged: [], notOnChecklist: ["t1"] });
    expect(fieldy.updates).toHaveLength(1);
    expect(slack.posts).toHaveLength(0);
  });
});

describe("addTask", () => {
  it("creates the task in Fieldy, due today by default, and adds it under Added", async () => {
    const { deps, fieldy, items, id } = await built();
    const r = await addTask(deps, { title: "  Call the Navien rep " });
    expect(fieldy.created).toEqual([{ title: "Call the Navien rep", date: `${TODAY}T17:00:00.000Z` }]);
    expect(r.checklistId).toBe(id);
    expect(items.get(id)!.slice(-1)[0]).toMatchObject({ groupName: ADDED_GROUP, text: "Call the Navien rep", position: 4 });
  });

  it("uses the given due day and group", async () => {
    const { deps, fieldy, items, id } = await built();
    await addTask(deps, { title: "Pick up flux", dueDay: "2026-11-25", group: "Errands" });
    expect(fieldy.created[0].date).toBe("2026-11-25T17:00:00.000Z");
    expect(items.get(id)!.slice(-1)[0].groupName).toBe("Errands");
  });

  it("only creates in Fieldy when there's no checklist today", async () => {
    const { deps, slack } = makeDeps();
    const r = await addTask(deps, { title: "Pick up flux" });
    expect(r.checklistId).toBeNull();
    expect(slack.posts).toHaveLength(0);
  });
});

describe("renderChecklist", () => {
  it("renders once more if the checklist changed while Slack was updating", async () => {
    let touchedOnce = false;
    const ctx = makeDeps({
      tasks: TASKS,
      onUpdate: async () => {
        if (!touchedOnce) {
          touchedOnce = true;
          await ctx.deps.store.touch(1);
        }
      },
    });
    const id = await buildChecklist(ctx.deps, GROUPING, "morning_ai", 0); // first render posts; no update yet
    await ctx.deps.store.touch(id);
    await renderChecklist(ctx.deps, id);
    expect(ctx.slack.updates).toHaveLength(2);
    const row = ctx.lists.get(id)!;
    expect(row.renderedVersion).toBe(row.version);
  });
});

describe("syncWithFieldy", () => {
  it("ticks items Dave marked done in the Fieldy app", async () => {
    const { deps, fieldy, items, id } = await built();
    fieldy.state.get("t3")!.status = "completed";
    const r = await syncWithFieldy(deps);
    expect(r.ticked).toBe(1);
    expect(items.get(id)!.find((i) => i.fieldyTaskId === "t3")).toMatchObject({ doneVia: "fieldy" });
  });

  it("re-renders a checklist whose last Slack update didn't land", async () => {
    const { deps, slack, id } = await built();
    await deps.store.touch(id); // as if a change saved but chat.update failed
    const r = await syncWithFieldy(deps);
    expect(r.rerendered).toBe(1);
    expect(slack.updates).toHaveLength(1);
  });

  it("does nothing without a checklist", async () => {
    const { deps, slack } = makeDeps({ tasks: TASKS });
    expect(await syncWithFieldy(deps)).toEqual({ ticked: 0, rerendered: 0 });
    expect(slack.posts).toHaveLength(0);
  });
});
