# Phase 1.x Backlog

Items surfaced during Phase 1 implementation and review that were **deliberately
descoped** from Phase 1. Recorded here so they are tracked, not lost. None block
the Phase 1 foundation; each is a follow-up.

## Confirmed by Task 0 (live Housecall Pro account, 2026-07-24)

The live verification ran against the real account (all endpoints HTTP 200).
Findings, most important first:

1. **Geocoding is required — the Geographic Scheduling Assistant is inert without
   it (highest priority).** HCP address objects are
   `{id, type, street, street_line_2, city, state, zip, country}` with **no
   `latitude`/`longitude`** on customers *or* jobs. `distanceFromAverillPark`,
   `classifyZone`, and compass direction all need coordinates, so the geo module
   produces nothing on real data until a geocoding step is added (e.g. Census
   Geocoder or Google Geocoding on `street, city, state, zip`, cached; populate
   `customers.lat/lng` and `jobs.service_address_lat/lng` during sync). `mapJob`
   already reads `job.address` (a real field) — only the coordinates are missing.

2. **Dashboard `openEstimates` will read 0 on real data.** Estimates expose
   `work_status` (values like `"scheduled"`), not a `"open"` status. The metric
   filters `status === "open"`. Redefine it against real HCP estimate lifecycle
   values — likely `options[].approval_status` (pending/approved/declined) once
   estimates have been acted on. `mapEstimate.status` now stores `work_status`.

3. **Scale: prioritize incremental polling.** 1,497 customers / 3,090 jobs /
   2,866 invoices / 933 estimates / 6 employees. A full all-pages resync every
   15 min at `page_size=50` is ~150+ API calls per run. Confirm whether the list
   endpoints support an `updated_after`/modified-since filter and switch the cron
   to cursor-based incremental sync (see "Incremental polling" below).

4. **Estimate/invoice → job/customer linkage is indirect.** Estimates and
   invoices carry no `job_id`/`customer_id`. The **job** holds
   `original_estimate_id` and an `invoice_number` (invoices share
   `invoice_number`). To populate `estimates.job_id` / `invoices.job_id`, derive
   the link during job sync rather than expecting it on the estimate/invoice.
   Until then those FK columns stay null (harmless; the `raw` jsonb has everything).

5. **Add tests for the corrected estimate/invoice mappers.** `mapEstimate`
   (`work_status` → status, `options[0].total_amount` → amount_cents) and
   `mapInvoice` (`amount` → amount_cents) were fixed against live data but have
   no unit tests yet; `mappers.test.ts` still only covers customer + job.

6. **Confirmed correct (no action):** auth (Bearer), endpoint paths + plural
   resource keys, envelope `{page, page_size, total_pages, total_items,
   <resource>}`, amounts in cents, and `mapJob`/`mapCustomer` field paths
   (customer/tags/schedule/assigned_employees/address all present).

Still unconfirmed (REST can't answer): the webhook `resource` value
(singular vs plural) and whether webhook `data` is a full record or a delta —
both need the dashboard's webhook docs. See the partial-payload item below.

## Data sync gaps

- **Notes, attachments, and tags/job_tags sync.** The Phase 1 goal named these,
  but the mappers and sync service only cover customers, technicians, jobs,
  estimates, and invoices. The corresponding tables were removed from
  `0001_init_schema.sql` to avoid dead schema (see the note there). To add:
  create the tables in a new migration, add `mapNote` / `mapAttachment` /
  `mapTag` mappers following the existing pattern in `src/lib/sync/mappers.ts`,
  register them in `syncOneRecord`'s `TABLE_AND_MAPPER`, and add them to the
  cron backfill in dependency order (after `jobs`). Note: `mapJob` already
  derives `is_emergency` / `is_commercial` from job tag *names*, so the tags
  table is only needed if we want to surface individual tags in the UI.

- **Incremental (cursor-based) polling.** The cron currently does a full
  all-pages resync of every resource every 15 minutes. A `sync_cursors` table
  (also removed for now) plus `?updated_after=<cursor>`-style requests would
  make the backfill incremental. Confirm the real HCP list endpoints support a
  modified-since filter during Task 0 before building this.

## Webhook robustness (depends on Task 0 findings)

- **Partial-payload overwrite.** Mappers emit a *complete* row (`?? null`
  defaults) and the sync does a full-row `upsert`. If HCP webhooks carry only a
  delta (e.g. `{id, work_status}`), a webhook could null out columns a prior
  backfill populated. Task 0 must confirm whether webhook `data` is the full
  resource or a delta. If it is a delta, switch to column-scoped upserts, merge
  against existing `raw`, or fetch the full record from the API on receipt.
  (The out-of-order-event / FK-error path is already handled: the route logs and
  returns 200 so HCP does not retry-storm, and the cron backfill reconciles.)

## Dashboard

- **`revenueBookedCents` has no date filter.** It sums all in_progress +
  scheduled job amounts. The roadmap's "revenue booked this week" / "scheduled
  next week" split needs a date-scoped query once `scheduled_start` data is
  flowing. The metric was renamed from `revenueBookedThisWeekCents` to avoid a
  misleading label until then.
- **Aggregate in SQL, not JS.** `getDashboardSnapshot` does `select("*")` on
  jobs/estimates/invoices (pulling the full `raw` jsonb) and counts in memory.
  Fine at Phase 1 volume; replace with SQL `count`/`sum` or an RPC before the
  tables grow.
- **Missing roadmap metrics.** "Today's schedule", "technician workload", and
  "revenue scheduled next week" follow the same filter/reduce pattern in
  `getDashboardSnapshot` and were left for a fast-follow.

## Geographic Scheduling Assistant

- **Zone thresholds are estimates.** Mile/compass ranges in
  `src/lib/geo/zones.ts` and the `AVG_SPEED_MPH = 32` drive-time constant encode
  informal dispatch zones; tune against real job data. The North Route cap was
  raised to 50 mi during Phase 1 to include Glens Falls.
- **Commercial / Navien priority recommendations.** Scheduling-recommendation
  behavior (Phase 2 per the roadmap), dependent on live tagging conventions.

## Housekeeping

- Add an assertion test that pins each mapper's output keys to the migration's
  column list — the mapper↔schema alignment currently has no compile-time guard.
- `HcpJob` still types `notes` / `attachments`; harmless, but revisit when their
  sync lands.
