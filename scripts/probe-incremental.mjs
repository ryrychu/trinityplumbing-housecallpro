// Throwaway probe (item 4): does the HCP /jobs list endpoint support a
// modified-since filter? Compares total_items for a baseline request vs. the
// same request with each candidate param set to a recent cutoff. A candidate
// "works" if it meaningfully reduces total_items (i.e. the server honored it);
// an ignored/unknown param returns the full baseline count.
//   set -a; source .env.local; set +a; node scripts/probe-incremental.mjs
const key = process.env.HOUSECALL_API_KEY;
if (!key || !key.trim()) {
  console.error("HOUSECALL_API_KEY not set.");
  process.exit(1);
}

const BASE = "https://api.housecallpro.com";
const CUTOFF = "2026-07-20T00:00:00Z"; // recent — should exclude most of the ~3k jobs
const CANDIDATES = [
  "updated_after",
  "updated_at_min",
  "updated_since",
  "modified_since",
  "modified_after",
  "since",
];

async function totalItems(query) {
  const res = await fetch(`${BASE}/jobs?page=1&page_size=1${query}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, total: body?.total_items ?? null };
}

const baseline = await totalItems("");
console.log(`baseline /jobs total_items = ${baseline.total} (HTTP ${baseline.status})`);
console.log(`cutoff = ${CUTOFF}\n`);

for (const param of CANDIDATES) {
  const r = await totalItems(`&${param}=${encodeURIComponent(CUTOFF)}`);
  const honored = r.total != null && baseline.total != null && r.total < baseline.total;
  console.log(
    `${param.padEnd(16)} HTTP ${r.status}  total_items=${r.total}  ${honored ? "<-- FILTERED (supported?)" : "(ignored / full count)"}`
  );
}
