// Throwaway probe (item 3): tally real estimate work_status + option approval_status
// values so the dashboard "openEstimates" metric can be redefined against live data.
//   set -a; source .env.local; set +a; node scripts/probe-estimates.mjs
const key = process.env.HOUSECALL_API_KEY;
if (!key || !key.trim()) {
  console.error("HOUSECALL_API_KEY not set.");
  process.exit(1);
}

const BASE = "https://api.housecallpro.com";
const workStatus = {};
const approval = {};
let sampled = 0;
let firstItemPrinted = false;

for (let page = 1; page <= 3; page++) {
  const res = await fetch(`${BASE}/estimates?page=${page}&page_size=50`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`page ${page}: HTTP ${res.status}`);
    break;
  }
  const body = await res.json();
  const items = body.estimates ?? [];
  if (items.length === 0) break;
  for (const est of items) {
    sampled++;
    const ws = est.work_status ?? "(none)";
    workStatus[ws] = (workStatus[ws] ?? 0) + 1;
    for (const opt of est.options ?? []) {
      const ap = opt.approval_status ?? "(none)";
      approval[ap] = (approval[ap] ?? 0) + 1;
    }
    if (!firstItemPrinted) {
      firstItemPrinted = true;
      console.log("=== sample estimate keys ===", Object.keys(est));
      console.log("sample options[0]:", JSON.stringify(est.options?.[0], null, 2));
    }
  }
  if (page >= (body.total_pages ?? 1)) break;
}

console.log(`\n=== sampled ${sampled} estimates ===`);
console.log("work_status distribution:", workStatus);
console.log("options[].approval_status distribution:", approval);
