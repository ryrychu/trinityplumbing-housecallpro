# Design: Finish Phase 1

**Date:** 2026-07-24
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** Close every gap between the current build and the Phase-1 items in
`list.md`. Phases 2–10 are explicitly out of scope.

---

## Context

Trinity Plumbing ↔ Housecall Pro (HCP) integration: Next.js 14 + TypeScript +
Supabase + Vitest, deployed to Vercel. Real-time webhook sync and the daily cron
backfill are live and verified in production (see `docs/NEXT-SESSION-HANDOFF.md`).

All work to date sits inside **Phase 1**, and Phase 1 is not complete. Against
the `list.md` Phase-1 checklist, the current state is:

| Area | Item | State |
|------|------|-------|
| Synchronize | Customers, Jobs, Estimates, Invoices, Technicians, Job status | ✅ done |
| Synchronize | **Leads** | ❌ not synced (no table, no mapper) |
| Synchronize | **Attachments** | ❌ not synced |
| Synchronize | **Tags** | ⚠️ read inline in `mapJob` for emergency/commercial only; not queryable |
| Synchronize | **Notes** | ⚠️ inside `raw` jsonb only; not queryable |
| Dashboard | Jobs in progress, Open estimates, Pending invoices, Revenue booked, Commercial jobs, Emergency calls | ✅ 6 of 10 cards |
| Dashboard | **Today's schedule, Upcoming estimates, Technician workload, Revenue scheduled next week** | ❌ 4 missing |
| Dashboard | Revenue booked "this week" | ⚠️ renders, but is all-time, not week-scoped |
| Geo | Geographic Scheduling Assistant | ⚠️ geocoding infra only; no distance/zone/direction/drive-time |

### Design decisions locked during brainstorming

1. **Plan scope:** Finish Phase 1 only.
2. **Geographic assistant:** Computed fields only (distance, drive-time estimate,
   service zone, compass direction). The "recommend scheduling based on nearby
   work" engine is deferred to Phase 2.
3. **Service zone:** Determined by a **town/city → zone lookup table**.
4. **Attachments:** Store metadata **and copy the file into Supabase Storage**
   (subject to the HCP-URL-auth validation below).
5. **Dashboard:** **Mixed** — metric cards for counts/revenue, richer panels for
   Today's schedule and Technician workload.
6. **Tags & Notes:** Promote to **first-class queryable columns** (array + text),
   not separate join tables.
7. **Week definition:** **Monday–Sunday** calendar week. "Next week" = the
   following Mon–Sun.
8. **Delete handling:** **In scope** for this plan.

---

## 1. Data model — migration `0005_phase1_completion.sql`

Follows the existing conventions: HCP id as text primary key, full payload in a
`raw jsonb` column, `updated_at timestamptz`, and **no inter-table foreign keys**
(migration `0004` dropped all of them because HCP delivers records out of order;
new tables must not reintroduce hard FKs).

### New table: `leads`
```
id            text primary key      -- HCP lead id
customer_id   text                  -- soft reference, no FK
status        text
source        text                  -- lead_source
created_at    timestamptz
raw           jsonb not null
updated_at    timestamptz not null default now()
```

### New table: `attachments`
```
id            text primary key      -- HCP attachment id
parent_type   text not null         -- 'customer' | 'job'
parent_id     text not null         -- soft reference
file_name     text
content_type  text
hcp_url       text                  -- original HCP-hosted URL
storage_path  text                  -- Supabase Storage path once re-hosted; null if not copied
created_at    timestamptz
raw           jsonb not null
updated_at    timestamptz not null default now()
```
Index: `attachments (parent_type, parent_id)`.

### New columns on existing tables
```
alter table jobs       add column tags  text[] not null default '{}';
alter table jobs       add column notes text;
alter table customers  add column tags  text[] not null default '{}';
alter table customers  add column notes text;
```

### Deliberately NOT stored
Distance-from-Averill-Park, drive-time, compass direction, and service zone are
**computed at read time** from the existing `lat`/`lng` columns. Storing them
would risk staleness when the origin, the road-factor, or the zone table changes;
recomputation is cheap.

### Supabase Storage
One bucket (e.g. `hcp-attachments`) for re-hosted files. Created via migration or
a one-line setup step, documented in the runbook.

---

## 2. Sync layer

### Mappers (`src/lib/sync/mappers.ts`)
- **`mapLead(l)`** — new, mirroring the other mappers.
- **`mapJob`** — additionally populate `tags` (all tag names, lowercased) and
  `notes`. Keep deriving `is_emergency` / `is_commercial` from the tag names
  (unchanged tagging convention: lowercase `emergency` / `commercial`).
- **`mapCustomer`** — additionally populate `tags` and `notes` (notes currently
  only live in `raw`).

### Attachments (`src/lib/sync/attachments.ts` — new)
Attachments arrive **embedded** in customer/job payloads (`attachments: [...]`),
not as their own webhook event. During customer/job sync:
1. Extract the attachment array from the payload.
2. For each: upsert an `attachments` row (metadata + `hcp_url`).
3. If not already re-hosted (`storage_path` null), download `hcp_url` and upload
   to the Storage bucket, then set `storage_path`.

**⚠️ Validate first — HCP file-URL auth.** Before building the download path,
probe one real attachment URL to confirm it is fetchable without HCP auth /
signed-URL handling. If it is **not** publicly fetchable, Phase 1 falls back to
**metadata + `hcp_url` only** (leave `storage_path` null) and re-hosting becomes a
documented follow-up. This keeps the Phase-1 item satisfiable regardless of the
probe result.

The download is best-effort and must never fail the record's core upsert (same
philosophy as geocoding): a download error leaves `storage_path` null and is
retried on a later sync, while customer/job data still lands.

### Router (`src/lib/sync/syncService.ts`)
- `RESOURCE_ALIASES`: add `lead → leads` and `pro → technicians`.
- `TABLE_AND_MAPPER`: add `leads`.
- `syncOneRecord`: after upserting a customer/job, invoke the attachment sync for
  that record.

### Client + cron (`src/lib/housecall/client.ts`, `src/app/api/cron/sync/route.ts`)
- `HousecallClient.listLeads(page)`.
- Add `leads` to the incremental cron pass (cursor-based like customers/jobs/
  estimates).
- **Invoices:** enable HCP's `invoice.*` webhooks (HCP dashboard config) to close
  the documented ~21h invoice lag. The time-gated cron reconcile stays as backstop.

---

## 3. Delete handling (`src/lib/sync/syncService.ts`)

`syncOneRecord` currently only upserts, so a `*.deleted` event would re-insert the
record. Add a delete branch:
- The webhook route already derives `event` (e.g. `customer.deleted`). Pass the
  event action (suffix after the last `.`) through to `syncOneRecord`.
- On a `deleted` action, `delete from <table> where id = <record.id>` instead of
  upserting. Geocoding/attachment enrichment is skipped for deletes.
- Deleting a customer/job also removes its `attachments` rows (soft cascade in
  code, since there are no DB FKs).

This unblocks safely enabling `customer.deleted` / `job.deleted` webhooks (do not
enable them in HCP until this ships).

---

## 4. Geographic Scheduling Assistant — computed fields

New module `src/lib/geo/serviceArea.ts` — pure, side-effect-free functions over
coordinates, independently testable:

- `AVERILL_PARK` — origin constant (lat/lng of Averill Park, NY).
- `haversineMiles(a, b)` — great-circle distance in miles.
- `driveTimeEstimate(miles)` — `miles × ROAD_WINDING_FACTOR ÷ AVG_SPEED_MPH`,
  returned in minutes. A documented approximation; no external routing API. The
  factor and speed are named constants, easy to tune.
- `compassDirection(from, to)` — 8-point bearing (N/NE/E/SE/S/SW/W/NW).
- `zoneForTown(town)` — lookup against a `TOWN_ZONES` config
  (`Record<string, Zone>`, case-insensitive). Returns a fallback zone (e.g.
  `"Other"`) for unknown towns.

`TOWN_ZONES` will be **seeded from the actual town/city distribution** in the
synced customer/job data (a quick census query), then presented for approval
before finalizing. Example zones from `list.md`: Albany Zone, North Route,
Southern Berkshire Route, Vermont Route.

These fields are surfaced per-job in the Today's-schedule dashboard panel
(§5). No new table; computed from `service_address_lat`/`lng` and the job's town.

---

## 5. Dashboard (`src/lib/dashboard/queries.ts`, `src/app/dashboard/page.tsx`)

Extend `DashboardSnapshot` and render mixed cards + panels.

### New metric cards
- **Upcoming estimates** — count of open estimates with a future scheduled date
  (distinct from total Open Estimates).
- **Revenue scheduled next week** — sum of `total_amount_cents` for jobs whose
  `scheduled_start` falls in the **next** Mon–Sun week.
- **Revenue booked this week** — re-scope the existing Revenue Booked to jobs with
  `scheduled_start` in the **current** Mon–Sun week (fixes the all-time value).
  The existing all-time figure is replaced, not added.

### New panels
- **Today's schedule** — jobs with `scheduled_start` today, ordered by start
  time; each row shows time, customer, assigned technician, and the computed
  zone / distance / compass direction from §4.
- **Technician workload** — per technician: count of jobs scheduled today and
  total scheduled hours (from `scheduled_start`/`scheduled_end`).

### Week boundary helper
A small shared helper computes the current and next Mon–Sun ranges (in the
business's local timezone) so "this week", "next week", and "today" are defined
once and reused. Timezone is a named constant.

### Pagination
All new queries page through with `.range()` (PostgREST caps responses at 1000
rows — the hard-won dashboard truncation bug). Select only needed columns.

---

## 6. Testing & verification

- **TDD per module:** `serviceArea` math (distance/drive-time/direction/zone),
  mappers (leads, tags, notes), attachment extraction, the delete branch, and the
  new dashboard queries (week-boundary edge cases: Sunday→Monday rollover, empty
  weeks).
- **Verify against live data, not fixtures.** Fixtures previously encoded invented
  API values (`in_progress`, `pending`) that HCP never sends; the suite passed
  while production was wrong. Census the real values before asserting.
- **Definition of done:** full Vitest suite green, `eslint` clean (no `any`,
  no unused), `next build` clean, and the dashboard renders correct numbers
  against production data.

---

## Out of scope (Phase 2+)

- The scheduling **recommendation** engine (best day/tech, route grouping,
  "already working nearby") — Phase 2.
- Separate relational `tags`/`job_tags`/`notes` tables with per-note author/
  timestamp — deferred; first-class columns suffice for Phase 1.
- Any Phase 3–10 subsystem (inventory, SOPs, AI assistant, commercial dashboard,
  customer portal, marketing, KPIs, predictive scheduling).

---

## Risks & open items

1. **HCP attachment-URL auth** (§2) — the one genuine unknown; validated by probe
   before committing the re-hosting path, with a metadata-only fallback.
2. **Vercel Hobby licensing** — this is a commercial dashboard on a
   non-commercial-licensed plan. Flagged previously; the user's call, not a
   blocker for this plan.
3. **`TOWN_ZONES` completeness** — unknown towns get a fallback zone; the table is
   easy to extend as new towns appear.
