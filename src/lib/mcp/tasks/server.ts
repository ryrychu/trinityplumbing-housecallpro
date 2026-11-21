// The "Trinity Tasks" ChatGPT connector: Dave's Fieldy tasks and his daily
// Slack checklist. Dave only: every tool checks the caller against
// MCP_TASKS_OWNER_USER_ID first. The write tools go through
// src/lib/tasks/checklist.ts, the same code Slack taps and the cron use.
// Spec: docs/superpowers/specs/2026-11-21-fieldy-checklist-design.md
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FieldyApiError } from "@/lib/fieldy/client";
import { describeFieldyError } from "@/lib/fieldy/fieldy";
import { completedTasks, dayKeyOf, pendingTasks, uniqueById } from "@/lib/fieldy/report";
import { localDateKey } from "@/lib/notifications/schedule";
import { addTask, buildChecklist, markDone, markNotDone, type ChecklistDeps } from "@/lib/tasks/checklist";
import { validateGrouping } from "@/lib/tasks/organize";

export interface TasksDeps {
  checklist: ChecklistDeps;
  /** MCP_TASKS_OWNER_USER_ID; null means nobody may use the connector. */
  ownerUserId: string | null;
  /** The first missing Slack/Fieldy setting, or null. */
  configMissing(): string | null;
}

export const NOT_OWNER_TEXT = "Trinity Tasks is only available to Dave's login.";

export const SERVER_INSTRUCTIONS = [
  "Trinity Tasks manages Dave's Fieldy tasks and his daily Slack checklist. Dave wears a Fieldy pendant that turns what he says into tasks.",
  "To organize his day: call get_my_tasks, optionally get_recent_recordings to see which tasks belong to the same job, then post_checklist with the open tasks in groups (by job, customer, place, or kind of errand).",
  "Checklist text must come from the task title: shorten it, but never add names, numbers or details that aren't in the title.",
  "When Dave says he finished something, call get_my_tasks, find the matching task, and call mark_done with its id. If more than one task could match, or none clearly does, ask him which one first. Never mark a task done on a guess.",
  "Use mark_not_done to undo a mistake, and add_task when he asks to add something (ask for a due date only if he mentions one).",
  "Recording summaries are for your context only; don't copy them into the checklist.",
].join(" ");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const WRITE_IDEMPOTENT = { ...WRITE, idempotentHint: true } as const;
const RECENT_DONE_HOURS = 48;

type ToolResult = { isError?: boolean; content: { type: "text"; text: string }[] };

function json(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

function refuse(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

const TASK_ID = z.string().min(1).max(200);

export function createTasksMcpServer(deps: TasksDeps, callerUserId: string | null): McpServer {
  const server = new McpServer({ name: "trinity-tasks", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  const isOwner = deps.ownerUserId !== null && callerUserId === deps.ownerUserId;
  const c = deps.checklist;

  // Owner check, then the setup check for tools that touch Slack, then one
  // error wrapper. Fieldy errors get their fix text; anything else a fixed
  // sentence, with the real message in the server log only.
  async function run(tool: string, opts: { writes: boolean }, body: () => Promise<ToolResult>): Promise<ToolResult> {
    if (!isOwner) return refuse(NOT_OWNER_TEXT);
    if (opts.writes) {
      const missing = deps.configMissing();
      if (missing) return refuse(`The Slack checklist isn't set up yet: ${missing}.`);
    }
    try {
      return await body();
    } catch (err) {
      if (err instanceof FieldyApiError) {
        return refuse(opts.writes ? `${describeFieldyError(err)} Call get_my_tasks to see what changed.` : describeFieldyError(err));
      }
      console.error(`[mcp-tasks] ${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
      return refuse("Something went wrong on Trinity's side. Try again in a minute.");
    }
  }

  const todayChecklist = () => c.store.getByDay(localDateKey(c.now()));

  server.registerTool(
    "get_my_tasks",
    {
      title: "Get my Fieldy tasks",
      description:
        "Dave's open Fieldy tasks (new and approved) and the ones finished in the last 2 days. Each has its Fieldy id, due date, and whether it's on today's Slack checklist and ticked. Call this before post_checklist, mark_done or mark_not_done.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      run("get_my_tasks", { writes: false }, async () => {
        const now = c.now();
        const all = uniqueById(await c.fieldy.tasks());
        const cl = await todayChecklist();
        const items = cl ? await c.store.listItems(cl.id) : [];
        const onList = new Map(items.map((i) => [i.fieldyTaskId, i]));
        const since = now.getTime() - RECENT_DONE_HOURS * 3_600_000;
        return json({
          today: localDateKey(now),
          checklist: cl ? { posted: cl.messageTs !== null, done: items.filter((i) => i.doneAt !== null).length, total: items.length } : null,
          open: pendingTasks(all).map((t) => ({
            id: t.id,
            title: t.title,
            due: dayKeyOf(t.date),
            onChecklist: onList.has(t.id),
            group: onList.get(t.id)?.groupName ?? null,
            ticked: Boolean(onList.get(t.id)?.doneAt),
          })),
          recentlyCompleted: all
            .filter((t) => t.status === "completed" && t.completionDate && Date.parse(t.completionDate) >= since)
            .map((t) => ({ id: t.id, title: t.title, completedAt: t.completionDate, onChecklist: onList.has(t.id) })),
        });
      })
  );

  server.registerTool(
    "get_recent_recordings",
    {
      title: "Get recent recordings",
      description:
        "Titles and summaries of Dave's Fieldy recordings from the last `hours` (default 24, at most 72), up to 20. Never full transcripts. Use these only to see which tasks belong together.",
      inputSchema: { hours: z.number().int().min(1).max(72).optional().describe("How far back to look. Default 24.") },
      annotations: READ_ONLY,
    },
    async ({ hours }) =>
      run("get_recent_recordings", { writes: false }, async () => {
        const now = c.now();
        const since = new Date(now.getTime() - (hours ?? 24) * 3_600_000).toISOString();
        const recordings = await c.fieldy.conversations(since, now.toISOString());
        return json({ recordings: recordings.map((r) => ({ title: r.title, summary: r.summary, startTime: r.startTime })) });
      })
  );

  server.registerTool(
    "post_checklist",
    {
      title: "Post today's checklist",
      description:
        'Posts (or rebuilds) today\'s checklist in Dave\'s Slack channel. Give every open task from get_my_tasks a group. Tasks you leave out go under "Other"; unknown ids are dropped; anything Dave already ticked today stays ticked. Item text: the task title, shortened, nothing added.',
      inputSchema: {
        groups: z
          .array(
            z.object({
              name: z.string().max(100),
              items: z.array(z.object({ taskId: TASK_ID, text: z.string().max(200).optional() })).max(60),
            })
          )
          .max(20),
      },
      annotations: WRITE,
    },
    async ({ groups }) =>
      run("post_checklist", { writes: true }, async () => {
        const all = uniqueById(await c.fieldy.tasks());
        const grouping = validateGrouping(groups, pendingTasks(all));
        await buildChecklist(c, grouping, "chatgpt", completedTasks(all, c.now()).length);
        return json({
          posted: true,
          groups: grouping.groups,
          movedToOther: grouping.movedToOther,
          droppedIds: grouping.dropped,
          notShownCount: grouping.overflow,
        });
      })
  );

  server.registerTool(
    "mark_done",
    {
      title: "Mark tasks done",
      description:
        "Marks tasks completed in Fieldy and ticks them on today's Slack checklist. Only use ids from get_my_tasks, and only when Dave clearly said he finished that task.",
      inputSchema: { taskIds: z.array(TASK_ID).min(1).max(25) },
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ taskIds }) =>
      run("mark_done", { writes: true }, async () => {
        const cl = await todayChecklist();
        const r = await markDone(c, cl?.id ?? null, taskIds, "chatgpt");
        return json({
          ...r,
          note: cl
            ? "Ticked on today's Slack checklist and marked completed in Fieldy."
            : "There's no checklist today, so these were only marked completed in Fieldy.",
        });
      })
  );

  server.registerTool(
    "mark_not_done",
    {
      title: "Mark tasks not done",
      description: "Undoes mark_done: the tasks go back to open in Fieldy and are unticked on today's checklist.",
      inputSchema: { taskIds: z.array(TASK_ID).min(1).max(25) },
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ taskIds }) =>
      run("mark_not_done", { writes: true }, async () => {
        const cl = await todayChecklist();
        return json({ ...(await markNotDone(c, cl?.id ?? null, taskIds, "chatgpt")) });
      })
  );

  server.registerTool(
    "add_task",
    {
      title: "Add a task",
      description:
        'Creates a task in Dave\'s Fieldy and adds it to today\'s checklist if there is one. dueDate is YYYY-MM-DD (default today); group is optional (default "Added").',
      inputSchema: {
        title: z.string().min(1).max(200),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        group: z.string().max(60).optional(),
      },
      annotations: WRITE,
    },
    async ({ title, dueDate, group }) =>
      run("add_task", { writes: true }, async () => {
        const r = await addTask(c, { title, dueDay: dueDate, group });
        return json({
          created: { id: r.task.id, title: r.task.title },
          onChecklist: r.checklistId !== null,
          note: r.checklistId !== null ? "Added to today's checklist." : "No checklist today yet; it will show on the next one.",
        });
      })
  );

  return server;
}
