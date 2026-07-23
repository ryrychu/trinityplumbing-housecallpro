# Go-Live Runbook — Housecall Pro Integration (Phase 1)

The code is complete and merged behind a credential gate. These are the steps
that require your live credentials and accounts, in order. Run them yourself
with your keys; none require code changes unless Task 0 turns up a surprise.

Prerequisites: create `.env.local` at the repo root from `.env.example` and fill
in the real values (this file is git-ignored). You still need a
`HOUSECALL_WEBHOOK_SECRET` (set in step 4) and a `CRON_SECRET` (generate one:
`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`).

---

## Step 0 — Confirm the live Housecall Pro API shape (do this FIRST)

The client was written against the documented API shape. Confirm it against your
real account before trusting the sync. Save this as `verify-hcp-api.mjs`, run it,
then delete it (it is throwaway, not part of the app):

```javascript
const key = process.env.HOUSECALL_API_KEY;
if (!key) { console.error("Set HOUSECALL_API_KEY first."); process.exit(1); }
for (const resource of ["customers", "employees", "jobs", "estimates", "invoices"]) {
  const res = await fetch(`https://api.housecallpro.com/${resource}?page=1&page_size=1`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  const body = await res.json();
  console.log(`\n=== ${resource} : HTTP ${res.status} ===`);
  console.log("top-level keys:", Object.keys(body));
  console.log(JSON.stringify(body, null, 2).slice(0, 1500));
}
```

Run: `HOUSECALL_API_KEY=<key> node verify-hcp-api.mjs`

Check and record:
1. **HTTP 200** for each resource (a 404 means the path/plural is wrong).
2. **List envelope**: is the array under `customers` / `jobs` / etc.? Is
   pagination `page` / `total_pages`? If names differ, update
   `src/lib/housecall/client.ts` (`request()` + `BASE_URL`).
3. **Job payload shape**: do jobs carry `customer.id`, `assigned_employees[]`,
   `work_status`, `tags[].name`, `schedule.scheduled_start`, `total_amount`
   (cents?), `address.latitude/longitude`? Adjust `src/lib/sync/mappers.ts` if
   field paths differ.
4. **Webhook event envelope** (from the dashboard's webhook docs): what is the
   `resource` value — singular (`employee`) or plural (`employees`)? The sync
   routes on plural keys (`customers/employees/jobs/estimates/invoices`); if the
   webhook sends singular, add an alias in `syncOneRecord`'s `TABLE_AND_MAPPER`.
5. **Full record vs delta**: does a webhook's `data` contain the full resource
   or just changed fields? If it's a delta, see the partial-payload item in
   `PHASE-1.x-BACKLOG.md` before pointing live webhooks here — a full-row upsert
   of a delta will null out columns.

Delete the script when done: `rm verify-hcp-api.mjs`.

---

## Step 1 — Create the Supabase project and apply the schema

Use a NEW dedicated project (not the existing `inquiries.trinity.plumbing`).

```bash
npx supabase login                       # interactive; opens a browser
npx supabase link --project-ref <your-new-project-ref>
npx supabase db push
```

Expected: the migration applies with no errors, creating `customers`,
`technicians`, `jobs`, `estimates`, `invoices` (5 tables — notes/attachments/
tags/sync_cursors are Phase 1.x, see the backlog). Copy the project URL, anon
key, and service-role key into `.env.local`.

---

## Step 2 — Verify locally against the real API

```bash
npm run dev
# In another shell, trigger a manual backfill (uses CRON_SECRET from .env.local):
curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/sync
```

Expected: `{ "ok": true, "syncedAt": ... }`. Then open
`http://localhost:3000/dashboard` — the six metric cards should show real counts.
Spot-check a few rows in the Supabase table editor against Housecall Pro.

---

## Step 3 — Deploy to Vercel

```bash
vercel link
vercel env add HOUSECALL_API_KEY
vercel env add HOUSECALL_WEBHOOK_SECRET
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add CRON_SECRET
vercel --prod
```

The cron in `vercel.json` runs `/api/cron/sync` every 15 minutes. Vercel
auto-injects `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set, so
the route's auth check works as written.

---

## Step 4 — Register the webhook subscription

In the Housecall Pro dashboard's webhook settings:
- Point create/update events for customer, job, estimate, invoice, and employee
  at `https://<your-vercel-domain>/api/webhooks/housecall`.
- Set the signing secret to the same value as `HOUSECALL_WEBHOOK_SECRET`.
- Confirm the signature header is `X-HousecallPro-Signature`; if it differs,
  update `src/app/api/webhooks/housecall/route.ts`.

Test with a real change in Housecall Pro and confirm the row updates in Supabase
and the dashboard. A malformed or unsigned request returns 400/401; a downstream
sync failure returns 200 and is logged (check Vercel function logs) so HCP does
not retry-storm — the 15-minute cron reconciles any gap.
