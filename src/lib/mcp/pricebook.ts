// Price book data for the ChatGPT connector: loads services and materials live
// from Housecall Pro, flattens them into one row shape, and runs the search and
// audit the MCP tools expose. Pure functions apart from the loader.
import type {
  HcpMaterial,
  HcpMaterialCategory,
  HcpPricebookService,
  HousecallPricebookClient,
} from "@/lib/housecall/pricebook";

export type ItemKind = "service" | "material";

export interface PricebookItem {
  kind: ItemKind;
  uuid: string;
  name: string;
  category: string | null;
  description: string;
  priceCents: number | null;
  costCents: number | null;
  unit: string | null;
  partNumber: string | null;
  updatedAt: string | null;
  taxable: boolean | null;
}

export interface Pricebook {
  items: PricebookItem[];
  truncated: boolean;
  loadedAt: string;
}

export type PricebookLoader = () => Promise<Pricebook>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function normalizeService(s: HcpPricebookService): PricebookItem {
  return {
    kind: "service",
    uuid: s.uuid,
    name: (s.name ?? "").trim(),
    category: str(s.category?.name),
    description: s.description ?? "",
    priceCents: num(s.price),
    costCents: num(s.cost),
    unit: str(s.unit_of_measure),
    partNumber: str(s.task_number),
    updatedAt: str(s.updated_at),
    taxable: typeof s.taxable === "boolean" ? s.taxable : null,
  };
}

export function normalizeMaterial(m: HcpMaterial, categoryName?: string): PricebookItem {
  return {
    kind: "material",
    uuid: m.uuid,
    name: (m.name ?? "").trim(),
    category: str(m.material_category_name) ?? str(categoryName),
    description: m.description ?? "",
    priceCents: num(m.price),
    costCents: num(m.cost),
    unit: str(m.unit_of_measure),
    partNumber: str(m.part_number),
    updatedAt: str(m.updated_at),
    taxable: typeof m.taxable === "boolean" ? m.taxable : null,
  };
}

type PricebookSource = Pick<HousecallPricebookClient, "listServices" | "listMaterialCategories" | "listMaterials">;

// Run `fn` over `inputs` with at most `limit` in flight, keeping input order.
async function mapLimited<T, R>(inputs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(inputs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, inputs.length) }, async () => {
    while (next < inputs.length) {
      const i = next++;
      out[i] = await fn(inputs[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export function createPricebookLoader(
  client: PricebookSource,
  opts: { ttlMs?: number; now?: () => number; maxCategories?: number; concurrency?: number } = {}
): PricebookLoader {
  const ttlMs = opts.ttlMs ?? 2 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const maxCategories = opts.maxCategories ?? 300;
  const concurrency = opts.concurrency ?? 5;
  let cache: { at: number; book: Pricebook } | null = null;

  async function load(): Promise<Pricebook> {
    let truncated = false;

    const services = await client.listServices();
    truncated ||= services.truncated;

    // Materials can only be listed one category at a time, so walk the
    // category tree breadth-first, a level at a time.
    const categories: HcpMaterialCategory[] = [];
    let level: (string | undefined)[] = [undefined];
    while (level.length > 0 && categories.length < maxCategories) {
      const children = await mapLimited(level, concurrency, (parent) => client.listMaterialCategories(parent));
      const found: HcpMaterialCategory[] = [];
      for (const c of children) {
        truncated ||= c.truncated;
        found.push(...c.items);
      }
      const room = maxCategories - categories.length;
      if (found.length > room) truncated = true;
      const kept = found.slice(0, room);
      categories.push(...kept);
      level = kept.map((c) => c.uuid);
    }
    if (level.length > 0) truncated = true;

    const materialLists = await mapLimited(categories, concurrency, async (c) => {
      const res = await client.listMaterials(c.uuid);
      truncated ||= res.truncated;
      return res.items.map((m) => normalizeMaterial(m, c.name));
    });

    return {
      items: [...services.items.map(normalizeService), ...materialLists.flat()],
      truncated,
      loadedAt: new Date(now()).toISOString(),
    };
  }

  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.book;
    const book = await load();
    cache = { at: now(), book };
    return book;
  };
}

export function searchPricebook(items: PricebookItem[], query: string, kind?: ItemKind, limit = 50): PricebookItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = items.filter((i) => {
    if (kind && i.kind !== kind) return false;
    return [i.name, i.description, i.category ?? "", i.partNumber ?? ""].some((f) => f.toLowerCase().includes(q));
  });
  return hits.slice(0, limit);
}

export type AuditRule =
  | "zero_price"
  | "below_cost"
  | "missing_description"
  | "short_description"
  | "duplicate_name"
  | "stale";

export interface AuditReport {
  totalItems: number;
  staleCheck: "ran" | "unavailable";
  counts: Record<AuditRule, number>;
  findings: Record<AuditRule, PricebookItem[]>;
}

const SHORT_DESCRIPTION = 20;

export function auditPricebook(items: PricebookItem[], opts: { staleMonths?: number; now?: Date } = {}): AuditReport {
  const staleMonths = opts.staleMonths ?? 12;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - staleMonths);

  const findings: Record<AuditRule, PricebookItem[]> = {
    zero_price: [],
    below_cost: [],
    missing_description: [],
    short_description: [],
    duplicate_name: [],
    stale: [],
  };

  const byName = new Map<string, PricebookItem[]>();
  for (const i of items) {
    if (i.priceCents === null || i.priceCents === 0) findings.zero_price.push(i);
    // $0 items are already reported under zero_price; don't double-count them.
    if (i.priceCents !== null && i.priceCents > 0 && i.costCents !== null && i.priceCents < i.costCents) {
      findings.below_cost.push(i);
    }
    const desc = i.description.trim();
    if (desc === "") findings.missing_description.push(i);
    else if (desc.length < SHORT_DESCRIPTION) findings.short_description.push(i);
    if (i.updatedAt && new Date(i.updatedAt) < cutoff) findings.stale.push(i);

    const key = `${i.kind}:${i.name.trim().toLowerCase()}`;
    byName.set(key, [...(byName.get(key) ?? []), i]);
  }
  // Array.from: the tsconfig target doesn't allow iterating a Map directly.
  for (const group of Array.from(byName.values())) if (group.length > 1) findings.duplicate_name.push(...group);

  const counts = Object.fromEntries(Object.entries(findings).map(([k, v]) => [k, v.length])) as Record<AuditRule, number>;
  return {
    totalItems: items.length,
    staleCheck: items.some((i) => i.updatedAt) ? "ran" : "unavailable",
    counts,
    findings,
  };
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatMoney(cents: number | null): string {
  return cents === null ? "n/a" : USD.format(cents / 100);
}
