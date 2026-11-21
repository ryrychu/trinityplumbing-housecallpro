// Dave's checklist as a Slack message, rebuilt in full from the database on
// every change (never patched in place), so whatever Slack shows is exactly
// what the tables hold.
//
// Slack limits this respects: a checkbox label is at most 75 characters, a
// checkboxes element holds at most 10 options, an actions block at most 25
// elements, a message at most 50 blocks. validateGrouping caps a checklist at
// 40 items in 12 groups: 1 header + 12 × (label + actions) + 1 footer = 26 blocks.
import { dayLabelFromKey } from "@/lib/slack/format";
import type { Grouping } from "./organize";
import type { BuiltBy, ChecklistRow, ItemRow } from "./store";

export const OPTION_TEXT_MAX = 75;
export const OPTIONS_PER_ELEMENT = 10;
export const ACTION_PREFIX = "fieldy_cb";

export type SlackBlock = Record<string, unknown>;
export type ChecklistMessage = { text: string; blocks: SlackBlock[] };
export type GroupLayout = { name: string; chunks: { index: number; items: ItemRow[] }[] };

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A checkbox label: escaped, struck through when done, within OPTION_TEXT_MAX
 * after both. The limit is checked in UTF-16 units (the stricter measure); the
 * text is shortened by code points so an emoji is never split.
 */
export function optionLabel(raw: string, done: boolean): string {
  let points = Array.from(raw);
  for (;;) {
    const escaped = escapeMrkdwn(points.join(""));
    const label = done ? `~${escaped}~` : escaped;
    if (label.length <= OPTION_TEXT_MAX || points.length <= 1) return label;
    points = Array.from(`${points.slice(0, Math.max(1, points.length - 2)).join("").trimEnd()}…`);
  }
}

/** Groups in the order their first item appears, each split into chunks of OPTIONS_PER_ELEMENT. Chunk indexes run across the whole message. */
export function layoutChecklist(items: ItemRow[]): GroupLayout[] {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const groups: { name: string; items: ItemRow[] }[] = [];
  for (const it of sorted) {
    let g = groups.find((x) => x.name === it.groupName);
    if (!g) {
      g = { name: it.groupName, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }
  let index = 0;
  return groups.map((g) => {
    const chunks: GroupLayout["chunks"] = [];
    for (let i = 0; i < g.items.length; i += OPTIONS_PER_ELEMENT) {
      chunks.push({ index: index++, items: g.items.slice(i, i + OPTIONS_PER_ELEMENT) });
    }
    return { name: g.name, chunks };
  });
}

export function actionId(checklistId: number, chunk: number): string {
  return `${ACTION_PREFIX}:${checklistId}:${chunk}`;
}

export function parseActionId(id: string): { checklistId: number; chunk: number } | null {
  const m = /^fieldy_cb:(\d+):(\d+)$/.exec(id);
  return m ? { checklistId: Number(m[1]), chunk: Number(m[2]) } : null;
}

export function heading(day: string): string {
  return `Dave's checklist, ${dayLabelFromKey(day)}`;
}

export function footerLine(c: { done: number; total: number; finishedYesterday: number; overflow: number; builtBy: BuiltBy }): string {
  const parts = [`${c.done} of ${c.total} done`, `Finished yesterday: ${c.finishedYesterday}`];
  if (c.overflow > 0) parts.push(`+${c.overflow} more in Fieldy`);
  if (c.builtBy === "morning_rules") parts.push("Grouped by date; AI grouping didn't run");
  return parts.join(" · ");
}

function option(item: ItemRow) {
  return { text: { type: "mrkdwn", text: optionLabel(item.text, item.doneAt !== null) }, value: item.fieldyTaskId };
}

export function renderChecklistMessage(cl: ChecklistRow, items: ItemRow[]): ChecklistMessage {
  const done = items.filter((i) => i.doneAt !== null).length;
  const blocks: SlackBlock[] = [{ type: "header", text: { type: "plain_text", text: heading(cl.day) } }];
  const layout = layoutChecklist(items);
  if (layout.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "No open Fieldy tasks." } });
  }
  for (const g of layout) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${escapeMrkdwn(g.name)}*` } });
    blocks.push({
      type: "actions",
      elements: g.chunks.map((c) => {
        const options = c.items.map(option);
        const initial = options.filter((_, i) => c.items[i].doneAt !== null);
        return {
          type: "checkboxes",
          action_id: actionId(cl.id, c.index),
          options,
          // Slack rejects an empty initial_options, so leave it out when nothing is ticked.
          ...(initial.length > 0 ? { initial_options: initial } : {}),
        };
      }),
    });
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: footerLine({ done, total: items.length, finishedYesterday: cl.finishedYesterday, overflow: cl.overflow, builtBy: cl.builtBy }),
      },
    ],
  });
  return { text: `${heading(cl.day)}: ${done} of ${items.length} done`, blocks };
}

/** `/trinity fieldy preview`: the checklist the morning pass would build, as text. */
export function renderChecklistPreview(day: string, grouping: Grouping, builtBy: BuiltBy, finishedYesterday: number): string {
  const lines = [`*Preview: ${heading(day)}*`];
  if (grouping.groups.length === 0) lines.push("No open Fieldy tasks.");
  for (const g of grouping.groups) {
    lines.push(`*${escapeMrkdwn(g.name)}*`);
    for (const i of g.items) lines.push(`• ${escapeMrkdwn(i.text)}`);
  }
  const total = grouping.groups.reduce((n, g) => n + g.items.length, 0);
  lines.push(`_${footerLine({ done: 0, total, finishedYesterday, overflow: grouping.overflow, builtBy })}_`);
  return lines.join("\n");
}
