// The daily Fieldy post: Dave's open tasks and what he marked done yesterday.
// Pure: tasks and a clock in, Slack mrkdwn out.
import { dayRange } from "@/lib/dashboard/week";
import { localDateKey } from "@/lib/notifications/schedule";
import { dayLabelFromKey } from "@/lib/slack/format";
import type { FieldyTask } from "./client";

/** At most this many tasks per section; the rest are summed up. Same cap as the declined-calls list. */
export const LIST_MAX = 25;
const TITLE_MAX = 150;

export const FOOTNOTE = "_A task only shows as completed here once Dave marks it done in Fieldy._";

export type TaskBucket = "pending" | "completed" | "closed";
export type Range = { startIso: string; endIso: string };

/**
 * new: waiting for Dave to review. approved: accepted, not done yet. Both are
 * open. Rejected, skipped, cancelled and expired are dismissed and not shown;
 * so is any status Fieldy adds later, until someone decides where it belongs.
 */
export function bucketOf(status: string): TaskBucket {
  if (status === "new" || status === "approved") return "pending";
  if (status === "completed") return "completed";
  return "closed";
}

/**
 * Yesterday, midnight to midnight Eastern (23 or 25 hours across a clock
 * change). Consecutive days' windows meet exactly, so a task done at 7:30am,
 * after that morning's post, shows the next morning, and nothing is listed twice.
 */
export function completedWindow(now: Date): Range {
  const today = dayRange(now);
  // Twelve hours before local midnight is always the previous calendar day.
  return dayRange(new Date(Date.parse(today.startIso) - 12 * 3_600_000));
}

/** The Eastern calendar day (YYYY-MM-DD) of an ISO value, or null. */
export function dayKeyOf(value: string | null): string | null {
  if (!value) return null;
  // A bare date names a calendar day already; parsing it would make it UTC
  // midnight, which is the evening before in Eastern time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : localDateKey(new Date(ms));
}

function dayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/**
 * The date a pending task's age is counted from.
 *
 * ASSUMPTION: Fieldy's /tasks schema has no created-at field, only `date`,
 * documented as the due date. Tasks are made from conversations, so `date` is
 * the closest thing to "when this came up" the API offers. If real tasks show
 * that `date` means something else, or Fieldy adds a creation time, change this
 * one line; ordering and the age label both follow it.
 */
export function taskAgeAnchor(task: FieldyTask): string | null {
  return task.date;
}

/** "3 days", "1 day", "today", "due Nov 20", or null when the task has no date. */
export function ageLabel(task: FieldyTask, now: Date): string | null {
  const key = dayKeyOf(taskAgeAnchor(task));
  if (!key) return null;
  const days = dayNumber(localDateKey(now)) - dayNumber(key);
  if (days === 0) return "today";
  if (days === 1) return "1 day";
  if (days > 1) return `${days} days`;
  const due = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
    new Date(`${key}T12:00:00Z`)
  );
  return `due ${due}`;
}

/** One entry per task id. A task read as new and then as completed (it changed between calls) counts as completed. */
function uniqueById(tasks: FieldyTask[]): FieldyTask[] {
  const byId = new Map<string, FieldyTask>();
  for (const t of tasks) {
    const seen = byId.get(t.id);
    if (!seen || bucketOf(t.status) === "completed") byId.set(t.id, t);
  }
  return Array.from(byId.values());
}

/** Open tasks, oldest first; tasks with no date go last. */
export function pendingTasks(tasks: FieldyTask[]): FieldyTask[] {
  const keyed = tasks
    .filter((t) => bucketOf(t.status) === "pending")
    .map((t) => ({ t, day: dayKeyOf(taskAgeAnchor(t)), raw: taskAgeAnchor(t) ?? "" }));
  keyed.sort((a, b) => {
    if (a.day !== b.day) {
      if (a.day === null) return 1;
      if (b.day === null) return -1;
      return a.day < b.day ? -1 : 1;
    }
    if (a.raw !== b.raw) return a.raw < b.raw ? -1 : 1;
    return a.t.title.localeCompare(b.t.title);
  });
  return keyed.map((k) => k.t);
}

/** Tasks marked done during yesterday (Eastern), in the order they were done. */
export function completedTasks(tasks: FieldyTask[], now: Date): FieldyTask[] {
  const w = completedWindow(now);
  const from = Date.parse(w.startIso);
  const to = Date.parse(w.endIso);
  return tasks
    .filter((t) => bucketOf(t.status) === "completed" && t.completionDate)
    .map((t) => ({ t, at: Date.parse(t.completionDate!) }))
    .filter(({ at }) => at >= from && at < to)
    .sort((a, b) => a.at - b.at)
    .map(({ t }) => t);
}

function cleanTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  const short = flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…` : flat;
  // Escaped so a title can't ping the channel (<!channel>) or a person.
  return short.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function capped(lines: string[]): string[] {
  if (lines.length <= LIST_MAX) return lines;
  return [...lines.slice(0, LIST_MAX), `… and ${lines.length - LIST_MAX} more`];
}

/**
 * The post for the morning of `now`. With `preview` the heading says so;
 * the body is identical, so the preview shows exactly what will be posted.
 */
export function formatFieldyPost(tasks: FieldyTask[], now: Date, opts: { preview?: boolean } = {}): string {
  const all = uniqueById(tasks);
  const pending = pendingTasks(all);
  const done = completedTasks(all, now);
  const yesterday = dayLabelFromKey(localDateKey(new Date(completedWindow(now).startIso)));

  const lines = [`*${opts.preview ? "Preview: " : ""}Dave's Fieldy tasks, ${dayLabelFromKey(localDateKey(now))}*`];

  if (pending.length === 0 && done.length === 0) {
    lines.push(`No open tasks, and nothing marked done yesterday (${yesterday}).`);
  } else {
    if (pending.length === 0) {
      lines.push("*Pending:* none");
    } else {
      lines.push(`*Pending: ${pending.length}*, oldest first`);
      lines.push(
        ...capped(
          pending.map((t) => {
            const age = ageLabel(t, now);
            return `• ${cleanTitle(t.title)}${age ? ` (${age})` : ""}`;
          })
        )
      );
    }
    if (done.length === 0) {
      lines.push(`*Completed yesterday (${yesterday}):* none`);
    } else {
      lines.push(`*Completed yesterday (${yesterday}): ${done.length}*`);
      lines.push(...capped(done.map((t) => `• ${cleanTitle(t.title)}`)));
    }
  }

  lines.push(FOOTNOTE);
  return lines.join("\n");
}
