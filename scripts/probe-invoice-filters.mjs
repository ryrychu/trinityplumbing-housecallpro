// scripts/probe-invoice-filters.mjs
// Verifies whether the live HCP account honors the /invoices query params that
// housecall.v1.yaml documents (status, paid_at_min, sort_by=paid_at).
// The spec has been wrong before: item 4 found updated_after silently ignored.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim();
}

const KEY = process.env.HOUSECALL_API_KEY;
if (!KEY) throw new Error("Missing HOUSECALL_API_KEY in .env.local");

async function get(qs) {
  const res = await fetch(`https://api.housecallpro.com/invoices?${qs}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  if (!res.ok) return { error: `${res.status} ${await res.text()}` };
  const json = await res.json();
  return { items: json.invoices ?? [], total: json.total_pages };
}

const baseline = await get("page=1&page_size=50");
console.log("baseline           :", baseline.items?.length, "items, total_pages", baseline.total);
console.log("  sample keys      :", Object.keys(baseline.items?.[0] ?? {}).join(", "));

const paidOnly = await get("page=1&page_size=50&status=paid");
const statuses = new Set((paidOnly.items ?? []).map((i) => i.status));
console.log("status=paid        :", paidOnly.items?.length, "items, statuses seen:", [...statuses]);
console.log("  FILTER WORKS?    :", statuses.size === 1 && statuses.has("paid"));

const since = new Date(Date.now() - 30 * 86400000).toISOString();
const recent = await get(`page=1&page_size=50&status=paid&paid_at_min=${since}`);
const older = (recent.items ?? []).filter((i) => i.paid_at && i.paid_at < since);
console.log(`paid_at_min=${since}`);
console.log("                   :", recent.items?.length, "items,", older.length, "older than cutoff");
console.log("  FILTER WORKS?    :", recent.items?.length > 0 && older.length === 0);

const sorted = await get("page=1&page_size=50&status=paid&sort_by=paid_at&sort_direction=desc");
const paidAts = (sorted.items ?? []).map((i) => i.paid_at).filter(Boolean);
const desc = paidAts.every((v, i) => i === 0 || paidAts[i - 1] >= v);
console.log("sort_by=paid_at    :", paidAts.length, "with paid_at, descending?", desc);
