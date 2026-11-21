// Turning Dave's open Fieldy tasks into checklist groups. validateGrouping is
// the one gate every grouping passes through (OpenAI's, ChatGPT's, the rules
// fallback), so whatever proposed it, no open task is lost and none is invented.
import type { ConversationSummary, FieldyTask } from "@/lib/fieldy/client";
import { dayKeyOf, pendingTasks } from "@/lib/fieldy/report";
import { localDateKey } from "@/lib/notifications/schedule";

/** Slack's limit for a checkbox label. */
export const ITEM_TEXT_MAX = 75;
export const GROUP_NAME_MAX = 60;
/** With MAX_GROUPS this keeps the message far inside Slack's 50 blocks. */
export const MAX_ITEMS = 40;
export const MAX_GROUPS = 12;
export const OTHER_GROUP = "Other";

export type ProposedGroup = { name: string; items: { taskId: string; text?: string }[] };
export type ChecklistGroup = { name: string; items: { taskId: string; text: string }[] };
export type Grouping = {
  groups: ChecklistGroup[];
  /** Open tasks past MAX_ITEMS, not on the checklist. */
  overflow: number;
  /** Open tasks the proposal left out, added under Other. */
  movedToOther: string[];
  /** Ids in the proposal that aren't open tasks, or appeared twice. */
  dropped: string[];
};

/** Proposes a grouping, or null when it couldn't (the caller falls back to rules). */
export type Organizer = (open: FieldyTask[], recordings: ConversationSummary[]) => Promise<ProposedGroup[] | null>;

/** Whitespace flattened, at most `max` code points (as Postgres char_length counts), never splitting an emoji. */
export function fitText(value: string, max = ITEM_TEXT_MAX): string {
  const flat = value.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length > max ? `${points.slice(0, max - 1).join("").trimEnd()}…` : flat;
}

export function validateGrouping(proposed: ProposedGroup[], open: FieldyTask[]): Grouping {
  const ordered = pendingTasks(open);
  const byId = new Map(ordered.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const dropped: string[] = [];
  const groups: ChecklistGroup[] = [];
  const byName = new Map<string, ChecklistGroup>();

  const groupFor = (rawName: string): ChecklistGroup => {
    const name = fitText(rawName, GROUP_NAME_MAX) || OTHER_GROUP;
    const key = name.toLowerCase();
    let g = byName.get(key);
    if (!g) {
      g = { name, items: [] };
      byName.set(key, g);
      groups.push(g);
    }
    return g;
  };

  for (const pg of proposed) {
    for (const item of pg.items) {
      const t = byId.get(item.taskId);
      if (!t || seen.has(item.taskId)) {
        dropped.push(item.taskId);
        continue;
      }
      seen.add(item.taskId);
      groupFor(pg.name).items.push({ taskId: t.id, text: fitText(item.text ?? "") || fitText(t.title) });
    }
  }

  const otherKey = OTHER_GROUP.toLowerCase();
  const other: ChecklistGroup = byName.get(otherKey) ?? { name: OTHER_GROUP, items: [] };
  let named = groups.filter((g) => g.name.toLowerCase() !== otherKey);
  if (named.length > MAX_GROUPS - 1) {
    for (const g of named.slice(MAX_GROUPS - 1)) other.items.push(...g.items);
    named = named.slice(0, MAX_GROUPS - 1);
  }

  const movedToOther: string[] = [];
  for (const t of ordered) {
    if (seen.has(t.id)) continue;
    other.items.push({ taskId: t.id, text: fitText(t.title) });
    movedToOther.push(t.id);
  }

  const all = other.items.length > 0 ? [...named, other] : named;
  let budget = MAX_ITEMS;
  let overflow = 0;
  const capped: ChecklistGroup[] = [];
  for (const g of all) {
    const take = g.items.slice(0, Math.max(0, budget));
    overflow += g.items.length - take.length;
    budget -= take.length;
    if (take.length > 0) capped.push({ name: g.name, items: take });
  }

  return { groups: capped, overflow, movedToOther, dropped };
}

/** The fallback when OpenAI can't group: by due date, oldest first within each group. */
export function groupByRules(open: FieldyTask[], now: Date): ProposedGroup[] {
  const today = localDateKey(now);
  const overdue: ProposedGroup = { name: "Overdue", items: [] };
  const dueToday: ProposedGroup = { name: "Due today", items: [] };
  const noDate: ProposedGroup = { name: "No date", items: [] };
  const later: ProposedGroup = { name: "Later", items: [] };
  for (const t of pendingTasks(open)) {
    const due = dayKeyOf(t.date);
    const bucket = due === null ? noDate : due < today ? overdue : due === today ? dueToday : later;
    bucket.items.push({ taskId: t.id, text: t.title });
  }
  return [overdue, dueToday, noDate, later].filter((g) => g.items.length > 0);
}
