// Service changes can't go through HCP's API, so they're requests: logged as
// pending, posted to a Slack checklist, applied by hand in HCP, then ticked.
// A tick is checked against HCP (services are readable) and a mismatch gets a
// thread reply. One tap = one change, the same stale-message rule as the Fieldy list.
import { formatMoney, type PricebookItem } from "@/lib/mcp/pricebook";
import { optionValuesFor, type BlockActionsPayload } from "@/lib/tasks/interact";
import { fitText } from "@/lib/tasks/organize";
import { escapeMrkdwn, optionLabel } from "@/lib/tasks/render";
import { BIG_CHANGE, describeChange, itemValues, parseMoney, priceCheck, type Issue, type Money } from "./changes";
import type { ChangeRow, FieldValues, PricebookEditStore } from "./types";

export const PB_ACTION_PREFIX = "pb_cb";
export const PB_NOT_ALLOWED_TEXT = "Only Dave and Ella can check these off.";
const PER_ELEMENT = 10;
const DESC_MAX = 75;

export function pbActionId(batchId: string, chunk: number): string {
  return `${PB_ACTION_PREFIX}:${batchId}:${chunk}`;
}
export function parsePbActionId(id: string): { batchId: string; chunk: number } | null {
  const m = /^pb_cb:([0-9a-zA-Z-]+):(\d+)$/.exec(id);
  return m ? { batchId: m[1], chunk: Number(m[2]) } : null;
}

export interface ChecklistSlack {
  post(channel: string, text: string, blocks: unknown[]): Promise<string>;
  update(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void>;
  reply(channel: string, threadTs: string, text: string): Promise<void>;
}
export type ServiceDeps = { store: PricebookEditStore; slack: ChecklistSlack; channelId: string; loadItems(): Promise<PricebookItem[]>; now(): Date; newId(): string; nameOf(userId: string): string };
export type ServiceRequestInput = { uuid: string; price?: Money; description?: string; name?: string };

function label(r: ChangeRow): string {
  if (r.after.priceCents !== undefined) return `${r.itemName}: ${r.before?.priceCents !== undefined ? formatMoney(r.before.priceCents) : "?"} → ${formatMoney(r.after.priceCents)}`;
  if (r.after.name !== undefined) return `${r.itemName} → rename to "${r.after.name}"`;
  return `${r.itemName}: new description`;
}

export function renderServiceBatch(rows: ChangeRow[], askedBy: string): { text: string; blocks: unknown[] } {
  const live = rows.filter((r) => r.status !== "dismissed");
  const done = live.filter((r) => r.status === "done").length;
  const heading = `Price book: ${live.length} service change${live.length === 1 ? "" : "s"} to make in HCP`;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: heading } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Asked by ${escapeMrkdwn(askedBy)}. HCP's API can't change services, so make these in HCP, then tick them here.` }] },
  ];
  if (live.length === 0) blocks.push({ type: "section", text: { type: "mrkdwn", text: "All of these were dismissed." } });
  const elements: unknown[] = [];
  for (let i = 0; i < live.length; i += PER_ELEMENT) {
    const chunk = live.slice(i, i + PER_ELEMENT);
    const options = chunk.map((r) => ({
      text: { type: "mrkdwn", text: optionLabel(label(r), r.status === "done") },
      value: String(r.id),
      ...(r.after.description !== undefined ? { description: { type: "plain_text", text: fitText(r.after.description, DESC_MAX) } } : {}),
    }));
    const initial = options.filter((_, k) => chunk[k].status === "done");
    elements.push({ type: "checkboxes", action_id: pbActionId(rows[0].batchId, i / PER_ELEMENT), options, ...(initial.length ? { initial_options: initial } : {}) });
  }
  if (elements.length) blocks.push({ type: "actions", elements });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${done} of ${live.length} done` }] });
  return { text: `${heading}: ${done} of ${live.length} done`, blocks };
}

export async function rerenderBatch(deps: ServiceDeps, batchId: string): Promise<void> {
  const rows = await deps.store.listBatch(batchId);
  if (rows.length === 0 || !rows[0].slackMessageTs || !rows[0].slackChannelId) return;
  const msg = renderServiceBatch(rows, deps.nameOf(rows[0].requestedBy));
  await deps.slack.update(rows[0].slackChannelId, rows[0].slackMessageTs, msg.text, msg.blocks);
}

export async function requestServiceChanges(
  deps: ServiceDeps,
  items: ServiceRequestInput[],
  editorId: string,
  opts: { allowBelowCost?: boolean } = {}
): Promise<{ batchId: string | null; requested: Array<{ id: number; name: string; change: string }>; merged: Array<{ id: number; name: string }>; blocks: Issue[]; warnings: Issue[] }> {
  const book = await deps.loadItems();
  const byUuid = new Map(book.map((i) => [i.uuid, i]));
  const blocks: Issue[] = [];
  const warnings: Issue[] = [];
  const planned: Array<{ it: PricebookItem; before: FieldValues; after: FieldValues }> = [];

  for (const req of items) {
    const it = byUuid.get(req.uuid);
    if (!it) { blocks.push({ uuid: req.uuid, name: null, code: "unknown_item", message: `No price book item has id ${req.uuid}.` }); continue; }
    if (it.kind !== "service") { blocks.push({ uuid: it.uuid, name: it.name, code: "material_use_preview", message: `${it.name} is a material; change it with preview_material_changes.` }); continue; }
    const cur = itemValues(it);
    const after: FieldValues = {};
    if (req.price !== undefined) { const c = parseMoney(req.price); if (c === null) { blocks.push({ uuid: it.uuid, name: it.name, code: "bad_money", message: `"${req.price}" isn't a price.` }); continue; } after.priceCents = c; }
    if (req.name !== undefined) after.name = req.name.trim();
    if (req.description !== undefined) after.description = req.description.trim();
    const bad = priceCheck(it.name, it.uuid, after.priceCents ?? it.priceCents, it.costCents, Boolean(opts.allowBelowCost));
    if (bad) { blocks.push(bad); continue; }
    if (after.priceCents !== undefined && it.priceCents && Math.abs(after.priceCents - it.priceCents) / it.priceCents > BIG_CHANGE) {
      warnings.push({ uuid: it.uuid, name: it.name, code: "big_change", message: `${it.name}: price moves more than 25%.` });
    }
    const before: FieldValues = {};
    for (const k of Object.keys(after) as Array<keyof FieldValues>) if (cur[k] !== undefined) (before as Record<string, unknown>)[k] = cur[k];
    planned.push({ it, before, after });
  }
  if (blocks.length > 0 || planned.length === 0) return { batchId: null, requested: [], merged: [], blocks, warnings };

  const pending = await deps.store.listPendingServices();
  const merged: Array<{ id: number; name: string }> = [];
  const touchedBatches: string[] = [];
  const fresh: typeof planned = [];
  for (const p of planned) {
    const existing = pending.find((r) => r.itemUuid === p.it.uuid);
    if (existing) {
      await deps.store.updateAfter(existing.id, { ...existing.after, ...p.after });
      merged.push({ id: existing.id, name: existing.itemName });
      if (!touchedBatches.includes(existing.batchId)) touchedBatches.push(existing.batchId);
    } else fresh.push(p);
  }
  for (const b of touchedBatches) await rerenderBatch(deps, b);
  if (fresh.length === 0) return { batchId: null, requested: [], merged, blocks, warnings };

  const batchId = deps.newId();
  const rows = await deps.store.insertChanges(
    fresh.map((p) => ({ batchId, kind: "service_request" as const, itemUuid: p.it.uuid, itemName: p.it.name, itemKind: "service" as const, categoryUuid: null, before: p.before, after: p.after, status: "pending" as const, requestedBy: editorId, errorCode: null }))
  );
  const msg = renderServiceBatch(rows, deps.nameOf(editorId));
  const ts = await deps.slack.post(deps.channelId, msg.text, msg.blocks);
  await deps.store.setSlackMessage(batchId, deps.channelId, ts);
  const withDesc = rows.filter((r) => r.after.description !== undefined);
  if (withDesc.length > 0) {
    await deps.slack.reply(deps.channelId, ts, withDesc.map((r) => `*${escapeMrkdwn(r.itemName)}*, new description:\n${escapeMrkdwn(r.after.description ?? "")}`).join("\n\n"));
  }
  return { batchId, requested: rows.map((r) => ({ id: r.id, name: r.itemName, change: describeChange(r.before, r.after) })), merged, blocks, warnings };
}

function hcpMismatch(r: ChangeRow, now: PricebookItem | undefined): string | null {
  if (!now) return `HCP no longer lists ${r.itemName}.`;
  if (r.after.priceCents !== undefined && now.priceCents !== r.after.priceCents) return `HCP still shows ${formatMoney(now.priceCents)} for ${r.itemName}.`;
  if (r.after.name !== undefined && now.name.trim() !== r.after.name) return `HCP still shows the name "${now.name}" for ${r.itemName}.`;
  if (r.after.description !== undefined && now.description.trim() !== r.after.description) return `HCP's description for ${r.itemName} doesn't match the request yet.`;
  return null;
}

export async function handleServiceTap(
  payload: BlockActionsPayload,
  deps: ServiceDeps,
  opts: { allowedUsers: string[]; note(url: string, text: string): Promise<unknown> }
): Promise<void> {
  const userId = payload.user?.id ?? "";
  for (const action of payload.actions ?? []) {
    const aid = action.action_id ?? "";
    const parsed = parsePbActionId(aid);
    if (!parsed) continue;
    const rows = await deps.store.listBatch(parsed.batchId);
    if (rows.length === 0) continue;
    if (!opts.allowedUsers.includes(userId)) {
      await rerenderBatch(deps, parsed.batchId);
      if (payload.response_url) await opts.note(payload.response_url, PB_NOT_ALLOWED_TEXT);
      continue;
    }
    const values = optionValuesFor(payload.message?.blocks, aid) ?? [];
    const selected = new Set((action.selected_options ?? []).map((o) => o.value));
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const tick: ChangeRow[] = [];
    const untick: ChangeRow[] = [];
    for (const v of values) {
      const r = byId.get(v);
      if (!r || r.status === "dismissed") continue;
      if (selected.has(v) && r.status === "pending") tick.push(r);
      if (!selected.has(v) && r.status === "done") untick.push(r);
    }
    const nowIso = deps.now().toISOString();
    if (tick.length > 0) {
      await deps.store.setStatus(tick.map((r) => r.id), "done", { resolvedBy: userId, resolvedAt: nowIso });
    } else if (untick.length === 1) {
      await deps.store.setStatus([untick[0].id], "pending", { resolvedBy: null, resolvedAt: null });
    }
    await rerenderBatch(deps, parsed.batchId);
    if (tick.length > 0) {
      const byUuid = new Map((await deps.loadItems()).map((i) => [i.uuid, i]));
      for (const r of tick) {
        const msg = hcpMismatch(r, byUuid.get(r.itemUuid));
        if (msg && r.slackChannelId && r.slackMessageTs) await deps.slack.reply(r.slackChannelId, r.slackMessageTs, msg);
      }
    }
  }
}
