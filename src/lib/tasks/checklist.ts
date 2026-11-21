// The one place Dave's checklist changes. ChatGPT (lib/mcp/tasks), Slack taps
// (lib/tasks/interact) and the cron (lib/tasks/morning, syncWithFieldy) all
// call these, so a tick from Slack and a tick from ChatGPT run the same code.
//
// Order on every change: Fieldy first, then the tables, then the version bump,
// then a full re-render of the Slack message from the tables. If Fieldy fails,
// that task's change doesn't happen. If only the re-render fails, the change
// stands and syncWithFieldy re-renders later.
import type { ConversationSummary, FieldyTask, TaskUpdate } from "@/lib/fieldy/client";
import { localDateKey } from "@/lib/notifications/schedule";
import { GROUP_NAME_MAX, fitText, type Grouping } from "./organize";
import { renderChecklistMessage } from "./render";
import type { BuiltBy, ChecklistStore, DoneVia, NewItem } from "./store";

export interface FieldyPort {
  /** new + approved + completed tasks; a task can appear twice if it changed between calls. */
  tasks(): Promise<FieldyTask[]>;
  completed(): Promise<FieldyTask[]>;
  /** Null when Fieldy accepted the change but sent no task back. */
  update(id: string, update: TaskUpdate): Promise<FieldyTask | null>;
  create(input: { title: string; date: string }): Promise<FieldyTask>;
  conversations(startIso: string, endIso: string): Promise<ConversationSummary[]>;
}

export interface SlackPort {
  post(channel: string, text: string, blocks: unknown[]): Promise<string>;
  update(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void>;
  delete(channel: string, ts: string): Promise<void>;
}

export interface ChecklistDeps {
  fieldy: FieldyPort;
  store: ChecklistStore;
  slack: SlackPort;
  channelId: string;
  now(): Date;
}

export type ChangeResult = {
  /** Changed in Fieldy and on the checklist. */
  changed: string[];
  /** Already in the asked-for state on the checklist; Fieldy not called. */
  unchanged: string[];
  /** Changed in Fieldy; not on this checklist (or there is none). */
  notOnChecklist: string[];
};

export const ADDED_GROUP = "Added";

/** A due date Fieldy accepts that stays on the same Eastern day in both EST and EDT (noon or 1pm). */
export function dueDateIso(dayKey: string): string {
  return `${dayKey}T17:00:00.000Z`;
}

/** A never-posted checklist this fresh is left to the run that is building it. */
const UNPOSTED_GRACE_MS = 2 * 60_000;

/**
 * Rebuilds the Slack message from the tables. If the checklist changed
 * meanwhile, renders once more. Two runs can both find no message yet (ChatGPT
 * and the cron at once): both post, only one claim wins, and the loser deletes
 * its own post and updates the winner's on its next pass.
 */
export async function renderChecklist(deps: ChecklistDeps, checklistId: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cl = await deps.store.getById(checklistId);
    if (!cl) return;
    const msg = renderChecklistMessage(cl, await deps.store.listItems(checklistId));
    if (cl.messageTs) {
      await deps.slack.update(cl.channelId, cl.messageTs, msg.text, msg.blocks);
    } else {
      const ts = await deps.slack.post(cl.channelId, msg.text, msg.blocks);
      if (!ts) throw new Error("[tasks] Slack returned no message ts");
      if (!(await deps.store.claimMessageTs(checklistId, ts))) {
        await deps.slack.delete(cl.channelId, ts);
        continue;
      }
    }
    await deps.store.markRendered(checklistId, cl.version);
    const after = await deps.store.getById(checklistId);
    if (!after || after.version === cl.version) return;
  }
}

/**
 * For callers that already wrote Fieldy and the tables: a Slack failure now
 * isn't theirs to report. The version stays ahead of rendered_version, so
 * syncWithFieldy re-renders on its next run.
 */
async function renderOrDefer(deps: ChecklistDeps, checklistId: number): Promise<void> {
  try {
    await renderChecklist(deps, checklistId);
  } catch (err) {
    console.warn(`[tasks] render deferred to next sync: ${errorMessage(err)}`);
  }
}

/** Today's checklist from a validated grouping: created and posted, or rebuilt in place. Returns its id. */
export async function buildChecklist(
  deps: ChecklistDeps,
  grouping: Grouping,
  builtBy: BuiltBy,
  finishedYesterday: number
): Promise<number> {
  const day = localDateKey(deps.now());
  const cl = (await deps.store.getByDay(day)) ?? (await deps.store.create({ day, channelId: deps.channelId, builtBy }));
  const old = await deps.store.listItems(cl.id);
  const oldById = new Map(old.map((i) => [i.fieldyTaskId, i]));

  const order: string[] = [];
  const byGroup = new Map<string, NewItem[]>();
  const push = (group: string, item: Pick<NewItem, "text" | "fieldyTaskId" | "doneAt" | "doneVia">) => {
    if (!byGroup.has(group)) {
      byGroup.set(group, []);
      order.push(group);
    }
    byGroup.get(group)!.push({ ...item, groupName: group, position: 0 });
  };

  const placed = new Set<string>();
  for (const g of grouping.groups) {
    for (const it of g.items) {
      const prev = oldById.get(it.taskId);
      push(g.name, { text: it.text, fieldyTaskId: it.taskId, doneAt: prev?.doneAt ?? null, doneVia: prev?.doneVia ?? null });
      placed.add(it.taskId);
    }
  }
  // Ticked earlier today: completed in Fieldy now, so no longer in a fresh
  // grouping. A rebuild never removes something Dave already finished today.
  for (const prev of old) {
    if (prev.doneAt !== null && !placed.has(prev.fieldyTaskId)) {
      push(prev.groupName, { text: prev.text, fieldyTaskId: prev.fieldyTaskId, doneAt: prev.doneAt, doneVia: prev.doneVia });
    }
  }

  let position = 0;
  const items = order.flatMap((g) => byGroup.get(g)!.map((i) => ({ ...i, position: ++position })));
  await deps.store.replaceItems(cl.id, items);
  await deps.store.updateMeta(cl.id, { builtBy, overflow: grouping.overflow, finishedYesterday });
  await deps.store.touch(cl.id);
  await renderOrDefer(deps, cl.id);
  return cl.id;
}

async function changeTasks(
  deps: ChecklistDeps,
  checklistId: number | null,
  taskIds: string[],
  to: "done" | "open",
  via: DoneVia
): Promise<ChangeResult> {
  const ids = Array.from(new Set(taskIds));
  const items = checklistId === null ? [] : await deps.store.listItems(checklistId);
  const byId = new Map(items.map((i) => [i.fieldyTaskId, i]));
  const nowIso = deps.now().toISOString();
  const result: ChangeResult = { changed: [], unchanged: [], notOnChecklist: [] };

  let failure: unknown = null;
  for (const id of ids) {
    const item = byId.get(id);
    if (item && (item.doneAt !== null) === (to === "done")) {
      result.unchanged.push(id);
      continue;
    }
    try {
      await deps.fieldy.update(id, to === "done" ? { status: "completed", completionDate: nowIso } : { status: "approved" });
    } catch (err) {
      failure = err;
      break;
    }
    (item ? result.changed : result.notOnChecklist).push(id);
  }

  if (checklistId !== null && result.changed.length > 0) {
    await deps.store.setDone(checklistId, result.changed, to === "done" ? nowIso : null, to === "done" ? via : null);
    await deps.store.touch(checklistId);
    await renderOrDefer(deps, checklistId);
  }
  // Thrown after recording the ones Fieldy accepted, so the checklist matches Fieldy.
  if (failure) throw failure;
  return result;
}

export function markDone(deps: ChecklistDeps, checklistId: number | null, taskIds: string[], via: DoneVia): Promise<ChangeResult> {
  return changeTasks(deps, checklistId, taskIds, "done", via);
}

export function markNotDone(deps: ChecklistDeps, checklistId: number | null, taskIds: string[], via: DoneVia): Promise<ChangeResult> {
  return changeTasks(deps, checklistId, taskIds, "open", via);
}

/** A new Fieldy task, added to today's checklist if there is one. */
export async function addTask(
  deps: ChecklistDeps,
  input: { title: string; dueDay?: string; group?: string }
): Promise<{ task: FieldyTask; checklistId: number | null }> {
  const today = localDateKey(deps.now());
  const task = await deps.fieldy.create({ title: input.title.trim(), date: dueDateIso(input.dueDay ?? today) });
  const cl = await deps.store.getByDay(today);
  if (!cl) return { task, checklistId: null };
  await deps.store.appendItem(cl.id, {
    groupName: fitText(input.group ?? "", GROUP_NAME_MAX) || ADDED_GROUP,
    text: fitText(task.title),
    fieldyTaskId: task.id,
  });
  await deps.store.touch(cl.id);
  await renderOrDefer(deps, cl.id);
  return { task, checklistId: cl.id };
}

/**
 * Every 15 minutes from the cron: tick items Dave marked done in the Fieldy
 * app itself, then re-render any recent checklist Slack is behind on (a failed
 * chat.update, or a first post that never landed). Each step fails on its
 * own: a Fieldy error or one bad render doesn't skip the rest.
 */
export async function syncWithFieldy(deps: ChecklistDeps): Promise<{ ticked: number; rerendered: number }> {
  const now = deps.now();
  let ticked = 0;
  try {
    const today = await deps.store.getByDay(localDateKey(now));
    if (today) {
      const open = (await deps.store.listItems(today.id)).filter((i) => i.doneAt === null);
      if (open.length > 0) {
        const completed = new Set((await deps.fieldy.completed()).map((t) => t.id));
        const ids = open.filter((i) => completed.has(i.fieldyTaskId)).map((i) => i.fieldyTaskId);
        if (ids.length > 0) {
          await deps.store.setDone(today.id, ids, now.toISOString(), "fieldy");
          await deps.store.touch(today.id);
          ticked = ids.length;
        }
      }
    }
  } catch (err) {
    console.error(`[tasks] sync Fieldy ticks failed: ${errorMessage(err)}`);
  }

  const yesterday = localDateKey(new Date(now.getTime() - 24 * 3_600_000));
  const behind = await deps.store.listBehind(yesterday);
  let rerendered = 0;
  for (const cl of behind) {
    // Not posted yet and just changed: the run building it is still posting.
    if (cl.messageTs === null && now.getTime() - Date.parse(cl.updatedAt) < UNPOSTED_GRACE_MS) continue;
    try {
      await renderChecklist(deps, cl.id);
      rerendered += 1;
    } catch (err) {
      console.error(`[tasks] sync render failed: ${errorMessage(err)}`);
    }
  }
  return { ticked, rerendered };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
