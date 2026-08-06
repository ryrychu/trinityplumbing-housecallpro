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

2. **RESOLVED — dashboard `openEstimates` will read 0 on real data.**
   Estimates expose `work_status` (values like `"scheduled"`), not a
   `"open"` status, and the metric used to filter `status === "open"`. Fixed
   by `isOpenEstimate()` in `src/lib/dashboard/queries.ts`, which redefines
   "open" against `raw.options[].approval_status`: an estimate is open if
   its status isn't terminal and it has an option with no `approval_status`
   set (i.e. nothing approved and nothing left pending review), and not open
   if any option is already approved. The mobile app's Money tab
   (`src/lib/mobile/money.ts`) imports and reuses this exact function rather
   than re-deriving the definition, so the desktop dashboard and the mobile
   app cannot drift apart on what "open" means.

3. **Scale: prioritize incremental polling.** 1,497 customers / 3,090 jobs /
   2,866 invoices / 933 estimates / 6 employees. A full all-pages resync every
   15 min at `page_size=50` is ~150+ API calls per run. Confirm whether the list
   endpoints support an `updated_after`/modified-since filter and switch the cron
   to cursor-based incremental sync (see "Incremental polling" below).

4. **Estimate/invoice → job linkage — RESOLVED / partially infeasible (item 5,
   2026-07-24).** Re-probed against the live account:
   - **Invoices carry `job_id` directly** (e.g. `job_id: "job_a955…"`). The
     earlier "invoices carry no job_id" note was wrong. `mapInvoice` already
     maps it, so `invoices.job_id` is populated with no derivation. (Regression
     test added in `mappers.test.ts`.)
   - **Estimate → job is NOT achievable** with the current API surface. The job
     exposes `original_estimate_id` / `original_estimate_uuids` prefixed `est_…`,
     but the `/estimates` list resource ids are prefixed `csr_…` (different
     UUIDs), the estimate object has no `est_`-prefixed field, and
     `GET /estimates/est_…` returns 404. So there is no key to join on;
     `estimates.job_id` stays null (the `raw` jsonb still has everything). Revisit
     only if HCP later exposes the `est_`↔`csr_` mapping or a `job_id` on
     estimates. A fuzzy customer+address+time match was considered and rejected
     as unreliable.

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
- **DONE (2026-08-01) — nearby-work lookup.** The roadmap's *"Already working
  in Delmar Tuesday afternoon"* now exists at `/dispatch`: type a town or
  address, get the next 14 days ranked by whether work is already booked
  nearby. `src/lib/dispatch/nearby.ts` + `resolveLocation.ts`.

  **Why it is a lookup and not an optimizer.** The go-live status census sums
  to exactly 3,038 across six statuses — **zero jobs sit in `needs
  scheduling`**. Trinity schedules at the moment of booking, so there is no
  queue of unscheduled work for a batch optimizer to arrange. Phase 2 as
  written ("recommend best day, best technician") assumes a queue that does
  not exist in this account; the useful shape is an answer for whoever is on
  the phone. Revisit if HCP usage ever changes.

  Town resolution averages the coordinates of past jobs in that town rather
  than geocoding the name — the Census one-line endpoint is unreliable without
  a street, and a static town→coords table would be another list to maintain.
  A town with no history correctly resolves to nothing, which is itself the
  answer to "are we already going there".

- **Commercial / Navien priority recommendations.** Still open. The tagging
  convention (above) now gives `is_commercial` a real signal, so a commercial-
  priority weighting in the nearby lookup is newly buildable. Navien customers
  have no flag yet — `customers.tags` already syncs, so a `navien` tag would
  work the same way `commercial` now does.

## Go-live Step 2 findings (live data, 2026-07-24)

Verifying the first real backfill against the live account surfaced five issues.
Four are fixed; one needs a business decision.

- **FIXED — hard FKs abort the sync.** A job assigned to a deactivated
  technician (HCP `/employees` returns 6; a job referenced a 7th) violated
  `jobs_technician_id_fkey` and killed the whole run. These tables mirror an
  external source of truth that gives no referential guarantees, so migration
  `0004_drop_external_fks.sql` drops all six inter-table FKs and indexes the
  reference columns instead.
- **FIXED — invoices have no `updated_at`.** The live invoice payload has no
  modification timestamp at all, so the incremental cursor could never advance
  and every run re-paged all ~2.9k invoices (58 calls, ~70s of a ~72s run;
  ~5.6k wasted calls/day). The cron now reconciles invoices at most once per
  `INVOICE_RECONCILE_HOURS` (default 24) and records `synced_at` with a null
  `last_updated_at`; webhooks cover live invoice changes. Steady-state runs are
  now ~2s.
- **FIXED — dashboard matched status values that do not exist.** Live
  `jobs.work_status` is `"in progress"` (a SPACE, not `"in_progress"`), and
  invoices use `open`, never `pending`. Both cards read 0. Test fixtures had
  encoded the same invented values, so the suite passed while production was
  wrong — fixtures now use live strings.
- **FIXED — PostgREST 1000-row cap silently truncated every count.** Listed
  above as a performance nit ("aggregate in SQL"); it was actually a correctness
  bug. `getDashboardSnapshot` now pages with `.range()` and selects only the
  columns each metric needs. Jobs in progress went 19 → 91, pending invoices
  24 → 25, revenue booked $36,195.59 → $145,708.30.
- **RESOLVED BY PROCESS (2026-08-01) — `emergencyCalls` and `commercialJobs`
  have no data source.** Both derive from job tag names, but only 22 of 3,038
  jobs carried any tag and none were emergency/commercial (actual names:
  "HomeServe", "My Website", "H-27", "Dylan spiff up sell", "3LD"). No code
  change could populate them.

  Trinity adopted a tagging convention instead: staff now tag `emergency` (any
  after-hours, same-day or urgent call-out) and `commercial` (business,
  property manager, or non-residential), applying both where both apply. Staff
  were told capitalization does not matter and that the exact plain word is
  what registers — `mapJob` lowercases and now also trims, and matches the
  exact tag within the array, so a descriptive tag like "emergency call - no
  heat" alongside the plain one is harmless. Regression tests pin all three
  behaviors.

  **Both cards count tagged jobs only, from the rollout date forward.** The
  ~3,000 historical jobs stay unclassified; backfilling them would need manual
  review. One option if that ever becomes worth doing: `customers.company` is
  already synced and populated, so historical *commercial* work could be
  retro-classified from a non-empty company name without anyone reading job
  records. Emergency has no equivalent signal and would need real review.

Geocoding after the uncapped local backfill: 92/1497 customers and 201/3038 jobs
still lack coordinates — 63 are definitive Census no-matches, the rest lack a
street or city/zip. That floor is expected, not a budget problem.

## Invoice filter probe (2026-07-29)

`scripts/probe-invoice-filters.mjs` hit the live `GET /invoices` endpoint to
check whether `status=paid`, `paid_at_min`, and `sort_by=paid_at` (all
documented in `housecall.v1.yaml`) actually work, so a paid-invoice poll can
use one targeted call instead of paging all ~2.9k invoices. **All three
filters work on the live account:**

- **`status` filters correctly, sent as `status[]=paid`** (array form —
  `housecall.v1.yaml` types `status` as an array and the live API enforces it
  literally; a bare `status=paid` 422s with `{"errors":{"status":"must be an
  array"}}`). With `status[]=paid`, every returned item has `status: "paid"`
  (2,234 of ~2,900 total invoices came back as paid; baseline `total_pages`
  58 → 45 with the filter applied). Same unencoded-bracket convention already
  used for `expand[]` in `src/lib/housecall/client.ts`.
- **`paid_at_min` filters correctly**: `status[]=paid&paid_at_min=<30-days-ago
  ISO timestamp>` returned only invoices paid within that window (26 items,
  0 older than the cutoff).
- **`sort_by=paid_at&sort_direction=desc` sorts correctly**: 50 items came back
  with `paid_at` populated in strictly descending order.
- **`paid_at` is present on the invoice payload** — it's one of the top-level
  fields (`id, status, invoice_number, amount, ..., paid_at, sent_at, ...`),
  populated for paid invoices.

**Conclusion for Task 8:** build `listPaidInvoicesSince` using
`status[]=paid`, `paid_at_min=<cursor>`, `sort_by=paid_at`,
`sort_direction=desc` — this lets the cron detect newly-paid invoices with a
single API call instead of the current 58-call full pass.

## Housekeeping

- Add an assertion test that pins each mapper's output keys to the migration's
  column list — the mapper↔schema alignment currently has no compile-time guard.
- `HcpJob` still types `notes` / `attachments`; harmless, but revisit when their
  sync lands.
