// Turning a request into an exact list of planned material changes, plus
// warnings (allowed, shown) and blocks (refused). Pure: no I/O.
import type { HcpMaterialFields } from "@/lib/housecall/pricebookWrite";
import { formatMoney, type PricebookItem } from "@/lib/mcp/pricebook";
import type { FieldValues, PlannedChange } from "./types";

export type Money = number | string;
export type MaterialEdit = { uuid: string; price?: Money; cost?: Money; description?: string; name?: string; partNumber?: string; unit?: string; taxable?: boolean };
export type RuleEdit = { match: { query?: string; category?: string }; pricePercent?: number; costPercent?: number; round?: "cent" | "dollar" | "99" };
export type PreviewRequest = { items?: MaterialEdit[]; rule?: RuleEdit; allowBelowCost?: boolean };
export type Issue = { uuid: string | null; name: string | null; code: string; message: string };
export type Preview = { changes: PlannedChange[]; warnings: Issue[]; blocks: Issue[] };

export const MAX_ITEMS = 50;
export const BIG_CHANGE = 0.25;
export const SHORT_DESCRIPTION = 20;

const MAX_MONEY_CENTS = 10_000_000 * 100;
const DECIMAL = /^\d+(\.\d+)?$/;

// Strict: plain non-negative decimals only. Works on the decimal string, not
// float math, so 1.005 gives 101 and 19.99 gives 1999.
export function parseMoney(v: Money): number | null {
  if (typeof v === "number" && (!Number.isFinite(v) || v < 0)) return null;
  const s = String(v).replace(/[$,\s]/g, "");
  if (!DECIMAL.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  let cents = Number(whole) * 100 + Number(frac.slice(0, 2).padEnd(2, "0"));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;
  return cents > MAX_MONEY_CENTS ? null : cents;
}

export function applyPercent(cents: number, pct: number, round: "cent" | "dollar" | "99" = "cent"): number {
  const raw = cents * (1 + pct / 100);
  if (round === "dollar") return Math.round(raw / 100) * 100;
  if (round === "99") return Math.max(99, Math.round(raw / 100) * 100 - 1);
  return Math.round(raw);
}

// Text fields are always present ("" when unset), so a change's `before` can put
// an empty field back. Numbers and taxable are left out when HCP has none: HCP
// can't be told to clear them, and undo refuses rather than pretend (see undo.ts).
export function itemValues(i: PricebookItem): FieldValues {
  return {
    name: i.name,
    description: i.description,
    ...(i.priceCents !== null ? { priceCents: i.priceCents } : {}),
    ...(i.costCents !== null ? { costCents: i.costCents } : {}),
    unit: i.unit ?? "",
    partNumber: i.partNumber ?? "",
    ...(i.taxable !== null ? { taxable: i.taxable } : {}),
  };
}

const KEYS: Array<keyof FieldValues> = ["name", "description", "priceCents", "costCents", "unit", "partNumber", "taxable"];

// True if HCP's item no longer matches `values` on any of `keys` (default: the
// keys `values` has). A key missing from `values` means "was unset", so it
// differs once HCP holds a value for it.
export function fieldsDiffer(i: PricebookItem, values: FieldValues, keys?: Array<keyof FieldValues>): boolean {
  const cur = itemValues(i);
  const ks = keys ?? KEYS.filter((k) => values[k] !== undefined);
  return ks.some((k) => values[k] !== cur[k]);
}

export function changedKeys(after: FieldValues): Array<keyof FieldValues> {
  return KEYS.filter((k) => after[k] !== undefined);
}

export function toHcpFields(v: FieldValues): HcpMaterialFields {
  const f: HcpMaterialFields = {};
  if (v.name !== undefined) f.name = v.name;
  if (v.description !== undefined) f.description = v.description;
  if (v.priceCents !== undefined) f.price = v.priceCents;
  if (v.costCents !== undefined) f.cost = v.costCents;
  if (v.unit !== undefined) f.unit_of_measure = v.unit;
  if (v.partNumber !== undefined) f.part_number = v.partNumber;
  if (v.taxable !== undefined) f.taxable = v.taxable;
  return f;
}

export function describeChange(before: FieldValues | null, after: FieldValues): string {
  const parts: string[] = [];
  if (after.priceCents !== undefined) parts.push(`price ${before?.priceCents !== undefined ? formatMoney(before.priceCents) : "new"} → ${formatMoney(after.priceCents)}`);
  if (after.costCents !== undefined) parts.push(`cost ${before?.costCents !== undefined ? formatMoney(before.costCents) : "new"} → ${formatMoney(after.costCents)}`);
  if (after.name !== undefined) parts.push(`name → "${after.name}"`);
  if (after.description !== undefined) parts.push("description changed");
  if (after.unit !== undefined) parts.push(`unit → ${after.unit}`);
  if (after.partNumber !== undefined) parts.push(`part number → ${after.partNumber}`);
  if (after.taxable !== undefined) parts.push(after.taxable ? "taxable" : "not taxable");
  return parts.join("; ");
}

export function priceCheck(name: string, uuid: string, priceCents: number | null, costCents: number | null, allowBelowCost: boolean): Issue | null {
  if (priceCents !== null && priceCents <= 0) return { uuid, name, code: "price_not_positive", message: `${name}: the price must be more than $0.00.` };
  if (costCents !== null && costCents < 0) return { uuid, name, code: "cost_negative", message: `${name}: the cost can't be negative.` };
  if (!allowBelowCost && priceCents !== null && costCents !== null && priceCents < costCents) {
    return { uuid, name, code: "below_cost", message: `${name}: ${formatMoney(priceCents)} is below its cost of ${formatMoney(costCents)}. Ask again with allowBelowCost if that's intended.` };
  }
  return null;
}

const norm = (s: string) => s.trim().toLowerCase();

export function buildPreview(req: PreviewRequest, items: PricebookItem[]): Preview {
  const byUuid = new Map(items.map((i) => [i.uuid, i]));
  const warnings: Issue[] = [];
  const blocks: Issue[] = [];
  const edits: MaterialEdit[] = [];

  for (const e of req.items ?? []) edits.push(e);
  if (req.rule) {
    const { query, category } = req.rule.match;
    for (const i of items) {
      if (i.kind !== "material") continue;
      if (category && norm(i.category ?? "") !== norm(category)) continue;
      if (query && ![i.name, i.category ?? "", i.partNumber ?? ""].some((s) => norm(s).includes(norm(query)))) continue;
      const e: MaterialEdit = { uuid: i.uuid };
      if (req.rule.pricePercent !== undefined && i.priceCents !== null) e.price = applyPercent(i.priceCents, req.rule.pricePercent, req.rule.round) / 100;
      if (req.rule.costPercent !== undefined && i.costCents !== null) e.cost = applyPercent(i.costCents, req.rule.costPercent, req.rule.round) / 100;
      edits.push(e);
    }
  }

  if (edits.length > MAX_ITEMS) {
    return { changes: [], warnings: [], blocks: [{ uuid: null, name: null, code: "too_many", message: `That's ${edits.length} items; the limit is ${MAX_ITEMS} per change. Narrow it down.` }] };
  }

  const seen = new Set<string>();
  const changes: PlannedChange[] = [];
  for (const e of edits) {
    const it = byUuid.get(e.uuid);
    if (!it) { blocks.push({ uuid: e.uuid, name: null, code: "unknown_item", message: `No price book item has id ${e.uuid}.` }); continue; }
    if (it.kind === "service") { blocks.push({ uuid: it.uuid, name: it.name, code: "service_not_editable", message: `${it.name} is a service. HCP's API can't change services; use request_service_changes.` }); continue; }
    if (seen.has(e.uuid)) { blocks.push({ uuid: it.uuid, name: it.name, code: "duplicate_item", message: `${it.name} is in the request twice.` }); continue; }
    seen.add(e.uuid);

    const cur = itemValues(it);
    const want: FieldValues = {};
    if (e.price !== undefined) { const c = parseMoney(e.price); if (c === null) { blocks.push({ uuid: it.uuid, name: it.name, code: "bad_money", message: `${it.name}: "${e.price}" isn't a price.` }); continue; } want.priceCents = c; }
    if (e.cost !== undefined) { const c = parseMoney(e.cost); if (c === null) { blocks.push({ uuid: it.uuid, name: it.name, code: "bad_money", message: `${it.name}: "${e.cost}" isn't a cost.` }); continue; } want.costCents = c; }
    if (e.name !== undefined) want.name = e.name.trim();
    if (e.description !== undefined) want.description = e.description.trim();
    if (e.unit !== undefined) want.unit = e.unit.trim();
    if (e.partNumber !== undefined) want.partNumber = e.partNumber.trim();
    if (e.taxable !== undefined) want.taxable = e.taxable;

    const before: FieldValues = {};
    const after: FieldValues = {};
    for (const k of KEYS) {
      if (want[k] !== undefined && want[k] !== cur[k]) {
        (after as Record<string, unknown>)[k] = want[k];
        if (cur[k] !== undefined) (before as Record<string, unknown>)[k] = cur[k];
      }
    }
    if (Object.keys(after).length === 0) { warnings.push({ uuid: it.uuid, name: it.name, code: "no_change", message: `${it.name} already has those values; skipped.` }); continue; }

    const priceOrCostChanged = after.priceCents !== undefined || after.costCents !== undefined;
    const bad = priceOrCostChanged
      ? priceCheck(it.name, it.uuid, after.priceCents ?? it.priceCents, after.costCents ?? it.costCents, Boolean(req.allowBelowCost))
      : null;
    if (bad) { blocks.push(bad); continue; }

    if (after.priceCents !== undefined && it.priceCents) {
      const delta = Math.abs(after.priceCents - it.priceCents) / it.priceCents;
      if (delta > BIG_CHANGE) warnings.push({ uuid: it.uuid, name: it.name, code: "big_change", message: `${it.name}: price moves ${Math.round(delta * 100)}% (${formatMoney(it.priceCents)} → ${formatMoney(after.priceCents)}).` });
    }
    const desc = after.description ?? it.description;
    if (desc.trim().length < SHORT_DESCRIPTION) warnings.push({ uuid: it.uuid, name: it.name, code: "short_description", message: `${it.name}: the description is ${desc.trim() ? "very short" : "missing"}.` });
    const newName = after.name;
    if (newName !== undefined && items.some((o) => o.uuid !== it.uuid && o.kind === it.kind && norm(o.name) === norm(newName))) {
      warnings.push({ uuid: it.uuid, name: it.name, code: "duplicate_name", message: `Another material is already called "${newName}".` });
    }
    changes.push({ uuid: it.uuid, name: it.name, category: it.category, categoryUuid: it.categoryUuid ?? null, before, after });
  }
  return { changes, warnings, blocks };
}
