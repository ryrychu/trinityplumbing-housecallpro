import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NOT_OWNER_TEXT, createTasksMcpServer, type TasksDeps } from "../server";
import { buildChecklist } from "@/lib/tasks/checklist";
import { validateGrouping } from "@/lib/tasks/organize";
import { NOW, makeDeps, task } from "@/lib/tasks/__tests__/fakes";

const DAVE = "user-dave";
const TASKS = [
  task("t1", "Order the Navien", { date: "2026-11-20" }),
  task("t2", "Call Mrs. Smith"),
  task("d1", "Done this morning", { status: "completed", completionDate: "2026-11-23T12:00:00.000Z" }),
];

async function connect(caller: string | null, opts: { configMissing?: string | null } = {}) {
  const ctx = makeDeps({ tasks: TASKS });
  const deps: TasksDeps = { checklist: ctx.deps, ownerUserId: DAVE, configMissing: () => opts.configMissing ?? null };
  const server = createTasksMcpServer(deps, caller);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, ...ctx };
}

function text(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0].text;
}

describe("Trinity Tasks connector", () => {
  it("lists six tools; reads are read-only, writes are not destructive", async () => {
    const { client } = await connect(DAVE);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(Object.keys(byName).sort()).toEqual(
      ["add_task", "get_my_tasks", "get_recent_recordings", "mark_done", "mark_not_done", "post_checklist"]
    );
    expect(byName.get_my_tasks).toMatchObject({ readOnlyHint: true });
    expect(byName.mark_done).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(byName.post_checklist).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it.each([null, "someone-else"])("refuses every tool for caller %j", async (caller) => {
    const { client, fieldy } = await connect(caller);
    for (const name of ["get_my_tasks", "mark_done"]) {
      const res = await client.callTool({ name, arguments: name === "mark_done" ? { taskIds: ["t1"] } : {} });
      expect(res.isError).toBe(true);
      expect(text(res)).toBe(NOT_OWNER_TEXT);
    }
    expect(fieldy.updates).toHaveLength(0);
  });

  it("get_my_tasks lists open and recently completed tasks with checklist state", async () => {
    const { client, deps } = await connect(DAVE);
    await buildChecklist(deps, validateGrouping([{ name: "Troy", items: [{ taskId: "t1" }] }], TASKS.slice(0, 2)), "chatgpt", 0);
    const body = JSON.parse(text(await client.callTool({ name: "get_my_tasks", arguments: {} })));
    expect(body.today).toBe("2026-11-23");
    expect(body.checklist).toEqual({ posted: true, done: 0, total: 2 });
    expect(body.open).toEqual([
      { id: "t1", title: "Order the Navien", due: "2026-11-20", onChecklist: true, group: "Troy", ticked: false },
      { id: "t2", title: "Call Mrs. Smith", due: null, onChecklist: true, group: "Other", ticked: false },
    ]);
    expect(body.recentlyCompleted).toEqual([
      { id: "d1", title: "Done this morning", completedAt: "2026-11-23T12:00:00.000Z", onChecklist: false },
    ]);
  });

  it("post_checklist validates the grouping and posts it", async () => {
    const { client, slack } = await connect(DAVE);
    const body = JSON.parse(
      text(
        await client.callTool({
          name: "post_checklist",
          arguments: { groups: [{ name: "Troy", items: [{ taskId: "t1", text: "Order Navien" }, { taskId: "bogus" }] }] },
        })
      )
    );
    expect(body).toMatchObject({ posted: true, movedToOther: ["t2"], droppedIds: ["bogus"], notShownCount: 0 });
    expect(slack.posts).toHaveLength(1);
  });

  it("post_checklist says what's missing when Slack isn't set up", async () => {
    const { client, slack } = await connect(DAVE, { configMissing: "SLACK_FIELDY_CHANNEL_ID is not set" });
    const res = await client.callTool({ name: "post_checklist", arguments: { groups: [] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("SLACK_FIELDY_CHANNEL_ID is not set");
    expect(slack.posts).toHaveLength(0);
  });

  it("mark_done ticks today's checklist and marks Fieldy", async () => {
    const { client, deps, fieldy } = await connect(DAVE);
    await buildChecklist(deps, validateGrouping([], TASKS.slice(0, 2)), "chatgpt", 0);
    const body = JSON.parse(text(await client.callTool({ name: "mark_done", arguments: { taskIds: ["t2"] } })));
    expect(body).toMatchObject({ changed: ["t2"], unchanged: [], notOnChecklist: [] });
    expect(fieldy.updates).toEqual([["t2", { status: "completed", completionDate: NOW.toISOString() }]]);
  });

  it("mark_done explains a Fieldy failure and points back to get_my_tasks", async () => {
    const { client } = await connect(DAVE);
    const res = await client.callTool({ name: "mark_done", arguments: { taskIds: ["missing"] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^Couldn't update Fieldy: http_404\..*get_my_tasks/);
  });

  it("add_task creates the task and reports whether it's on the checklist", async () => {
    const { client, fieldy } = await connect(DAVE);
    const body = JSON.parse(text(await client.callTool({ name: "add_task", arguments: { title: "Call the Navien rep", dueDate: "2026-11-24" } })));
    expect(fieldy.created).toEqual([{ title: "Call the Navien rep", date: "2026-11-24T17:00:00.000Z" }]);
    expect(body).toMatchObject({ created: { title: "Call the Navien rep" }, onChecklist: false });
  });

  it("get_recent_recordings returns titles and summaries only", async () => {
    const { client, fieldy } = await connect(DAVE);
    fieldy.setRecordings([{ id: "c1", title: "Troy walkthrough", summary: "Boiler swap.", startTime: "2026-11-23T12:00:00.000Z" }]);
    const body = JSON.parse(text(await client.callTool({ name: "get_recent_recordings", arguments: { hours: 12 } })));
    expect(body.recordings).toEqual([{ title: "Troy walkthrough", summary: "Boiler swap.", startTime: "2026-11-23T12:00:00.000Z" }]);
  });
});
