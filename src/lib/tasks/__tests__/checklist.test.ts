import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

describe("first post races", () => {
  it("deletes its own post and updates the other run's message when it loses the claim", async () => {
    const ctx = makeDeps({ tasks: TASKS });
    const claim = ctx.deps.store.claimMessageTs;
    let raced = false;
    ctx.deps.store.claimMessageTs = async (id, ts) => {
      if (raced) return claim(id, ts);
      raced = true;
      ctx.lists.get(id)!.messageTs = "999.1"; // another run posted and claimed first
      return false;
    };
    const id = await buildChecklist(ctx.deps, GROUPING, "chatgpt", 0);
    expect(ctx.slack.posts).toHaveLength(1);
    expect(ctx.slack.deletes).toEqual([{ channel: "C_FIELDY", ts: "171.1" }]);
    expect(ctx.slack.updates.map((u) => u.ts)).toEqual(["999.1"]);
    const row = ctx.lists.get(id)!;
    expect(row.messageTs).toBe("999.1");
    expect(row.renderedVersion).toBe(row.version);
  });
});

describe("syncWithFieldy fault isolation", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function unposted(ctx: ReturnType<typeof makeDeps>, day: string, ageMs: number) {
    const cl = await ctx.deps.store.create({ day, channelId: "C_FIELDY", builtBy: "morning_ai" });
    ctx.lists.get(cl.id)!.updatedAt = new Date(NOW.getTime() - ageMs).toISOString();
    return cl.id;
  }

  it("leaves a never-posted checklist changed in the last 2 minutes to the run building it", async () => {
    const ctx = makeDeps({ tasks: TASKS });
    const fresh = await unposted(ctx, TODAY, 30_000);
    const stale = await unposted(ctx, "2026-11-22", 5 * 60_000);
    const r = await syncWithFieldy(ctx.deps);
    expect(r.rerendered).toBe(1);
    expect(ctx.slack.posts).toHaveLength(1);
    expect(ctx.lists.get(fresh)!.messageTs).toBeNull();
    expect(ctx.lists.get(stale)!.messageTs).toBe("171.1");
  });

  it("still renders the other checklists when one render throws", async () => {
    const ctx = makeDeps({ tasks: TASKS });
    const a = await unposted(ctx, "2026-11-22", 5 * 60_000);
    const b = await unposted(ctx, TODAY, 5 * 60_000);
    ctx.lists.get(a)!.messageTs = "100.1";
    ctx.lists.get(b)!.messageTs = "100.2";
    const update = ctx.deps.slack.update;
    ctx.deps.slack.update = async (channel, ts, text, blocks) => {
      if (ts === "100.1") throw new Error("[slack] chat.update failed: message_not_found");
      return update(channel, ts, text, blocks);
    };
    const r = await syncWithFieldy(ctx.deps);
    expect(r.rerendered).toBe(1);
    expect(ctx.slack.updates.map((u) => u.ts)).toEqual(["100.2"]);
    expect(ctx.lists.get(b)!.renderedVersion).toBe(ctx.lists.get(b)!.version);
    expect(ctx.lists.get(a)!.renderedVersion).toBeLessThan(ctx.lists.get(a)!.version);
    expect(console.error).toHaveBeenCalledWith("[tasks] sync render failed: [slack] chat.update failed: message_not_found");
  });

  it("still re-renders when reading Fieldy fails", async () => {
    const { deps, slack, id } = await built();
    await deps.store.touch(id);
    deps.fieldy.completed = async () => {
      throw new FieldyApiError("http_503", "GET /tasks");
    };
    const r = await syncWithFieldy(deps);
    expect(r).toEqual({ ticked: 0, rerendered: 1 });
    expect(slack.updates).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[tasks\] sync Fieldy ticks failed: /));
  });
});

describe("a Slack failure after Fieldy and the tables are written", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("addTask still resolves with the checklist, left for the sync to re-render", async () => {
    const { deps, slack, items, lists, id } = await built();
    slack.failUpdates = true;
    const r = await addTask(deps, { title: "Pick up flux" });
    expect(r.checklistId).toBe(id);
    expect(items.get(id)!.slice(-1)[0]).toMatchObject({ text: "Pick up flux" });
    expect(lists.get(id)!.renderedVersion).toBeLessThan(lists.get(id)!.version);
    expect(console.warn).toHaveBeenCalledWith("[tasks] render deferred to next sync: [slack] chat.update failed: http_503");
  });

  it("markDone still resolves with the change, and the item is done", async () => {
    const { deps, fieldy, slack, items, id } = await built();
    slack.failUpdates = true;
    const r = await markDone(deps, id, ["t2"], "chatgpt");
    expect(r).toEqual({ changed: ["t2"], unchanged: [], notOnChecklist: [] });
    expect(fieldy.updates).toHaveLength(1);
    expect(items.get(id)!.find((i) => i.fieldyTaskId === "t2")!.doneAt).toBe(NOW.toISOString());
  });

  it("buildChecklist still returns the id when the rebuild can't update Slack", async () => {
    const { deps, slack, id } = await built();
    slack.failUpdates = true;
    expect(await buildChecklist(deps, GROUPING, "chatgpt", 2)).toBe(id);
  });

  it("renderChecklist itself still throws", async () => {
    const { deps, slack, id } = await built();
    slack.failUpdates = true;
    await expect(renderChecklist(deps, id)).rejects.toThrow(/http_503/);
  });
});
