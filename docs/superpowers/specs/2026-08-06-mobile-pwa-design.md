# Trinity Ops Mobile — Installable PWA — Design

**Date:** 2026-08-06
**Status:** Approved, ready for implementation planning
**Depends on:** Phase 1 foundation (HCP → Supabase sync, live and verified) and
the Slack notification layer (`0006_notifications.sql`, `src/lib/notifications/`)

## Goal

Turn the existing read-only operations dashboard into a **mini Housecall Pro for
the phone** — an installable Progressive Web App the owner adds to an iPhone home
screen, opens like a native app, and trusts enough to run the day from.

Five modules: Today, Schedule, Customers, Money (estimates + invoices), and
Dispatch. Plus the feature that motivated the whole thing: **a push notification
before each upcoming job, which the owner can acknowledge so it stops nagging.**

Housecall Pro remains the system of record. This app reads the Supabase mirror
and writes back to HCP only through endpoints that genuinely exist.

## Decisions

Settled during brainstorming; recorded so they are not relitigated.

| Decision | Choice |
|---|---|
| Read vs write | Read everywhere, plus a small set of real writes |
| Audience | Owner / office only — no technician role, no per-tech filtering |
| Modules in v1 | All five (Today+Schedule+Jobs, Customers, Money, Dispatch) |
| Auth | Supabase Auth, email + password, accounts created by hand |
| App shell | Bottom tab bar, five fixed tabs |
| Target device | **iPhone first.** Desktop is explicitly later |
| Data access | Through our own API routes; service-role key never leaves the server |
| Delivery | Two phases — usable app, then notifications + writes |

**Each phase gets its own implementation plan.** This document specifies both so
the shape of the whole product is visible, but the plan that follows it covers
**Phase 1 only**; Phase 2 is planned after Phase 1 is installed on a real iPhone
and its assumptions have met reality.

## Constraints (established from the live account and the vendored API spec, not assumed)

Each is load-bearing. Ignoring any one of them produces a screen that reads zero
or a button that cannot work.

- **Housecall Pro has no endpoint to change a job's status.** `'/jobs/{id}'` is
  **GET only** (`housecall.v1.yaml:670-716`). The only job mutations are
  sub-resources: `PUT /jobs/{job_id}/schedule`, `PUT /jobs/{job_id}/dispatch`,
  `POST /jobs/{job_id}/notes`, `POST /jobs/{job_id}/tags`, and line items.
  **Therefore "mark this job in progress" cannot be written back to HCP.**
- **`work_status` has no "on my way" state, but HCP still models one.** The enum
  (`housecall.v1.yaml:4823-4830`) is `needs scheduling, scheduled, in progress,
  complete rated, complete unrated, user canceled, pro canceled`. A technician
  tapping "On my way" in the HCP app stamps `raw.work_timestamps.on_my_way_at`
  instead, and `scheduleStatus()`
  (`src/lib/dashboard/queries.ts:228-241`) **already derives an "En Route"
  label from it.** So en-route is readable today; it is simply not writable,
  and it does not live in `work_status`.
- **Live job statuses use a space, not an underscore** — `"in progress"`, and
  completions are `"complete rated"` / `"complete unrated"`
  (`src/lib/dashboard/queries.ts`). Test fixtures once encoded invented values
  and the suite passed green while production read zero. Fixtures use live
  strings.
- **Live invoice statuses are `paid` / `canceled` / `voided` / `open`.** There is
  no `pending`; `open` is the unpaid state (`INVOICE_PENDING` in `queries.ts`).
- **Estimate approval is per-option**, at `raw.options[].approval_status`, with
  approved values `approved` and `pro approved`. `isOpenEstimate()`
  (`src/lib/dashboard/queries.ts:54-62`) already encodes the full definition.
  **No probe is required** — the `PHASE-1.x-BACKLOG.md` item claiming this is
  unresolved is stale and should be struck.
- **Estimate → job cannot be joined.** `/estimates` returns `csr_…` ids while
  jobs expose `est_…` ids; they are different UUIDs and `GET /estimates/est_…`
  404s. `estimates.job_id` stays null. The job screen therefore shows a linked
  invoice and no linked estimate.
- **Invoices *do* carry `job_id`**, so the job → invoice link works.
- **PostgREST caps every response at 1000 rows.** A bare `select("*")` silently
  truncates; this already caused a real bug (19 jobs reported instead of 91).
  Every list query pages with `.range()`.
- **`emergency` / `commercial` come from job tag names, from the rollout date
  forward only.** ~3,000 historical jobs are unclassified. Counters must not
  imply otherwise.
- **201 of 3,038 jobs and 92 of 1,497 customers have no coordinates.** Dispatch
  results are approximate by construction, and a town with no work history
  correctly resolves to nothing.
- **Business timezone is `America/New_York`**; Vercel runs UTC.
- **No RLS exists on any table.** Six migrations, zero policies. Nothing is
  exposed today because no browser code touches Supabase — but the anon key is
  public by design, so any client-side Supabase call would expose every customer
  record for read *and write*. This directly determines the data-access design
  below.

### iOS platform constraints

- **Web push requires the app be installed to the Home Screen** (iOS 16.4+). In
  a browser tab, notifications do not exist at all.
- **iOS ignores notification action buttons.** No "On my way" button on the lock
  screen — that is Android-only. The notification opens the app instead.
- **Install on iPhone goes through Safari**, not Chrome, and the installed app
  has its own storage — the user signs in again inside it.
- **No Background Sync.** Queued offline writes flush when the app is next
  opened or when `online` fires, never silently in the background.

## Architecture

### Route layout

The mobile app lives under `/app/*`. `src/app/dispatch/page.tsx` already owns
`/dispatch`, so a root-level mobile app collides on day one; the prefix also
leaves the existing desktop dashboard untouched and scopes the manifest and
service worker cleanly.

```
/app/login            email + password
/app/today            tab 1 — today's board
/app/schedule         tab 2 — week strip + day list
/app/customers        tab 3 — search-first
/app/money            tab 4 — estimates | invoices segments
/app/dispatch         tab 5 — nearby lookup
/app/jobs/[id]        job detail (push deep-link target)
/app/settings         sign out, notification prefs (Phase 2)
```

Manifest: `start_url: /app/today`, `scope: /app/`, `display: standalone`, dark
theme color `#121212`, gold `#f2c400` accent, icons from the existing Trinity
mark.

### Rendering and data flow

**Client-rendered shell, all data as JSON from `/api/app/*`.** This deliberately
differs from the existing server-component pages. The reason is offline: a
service worker can cache a JSON response and label it *"as of 8:42a"*, whereas
cached server-rendered HTML is a stale page the UI cannot date or reason about.
One data path, cached one way.

```
iPhone (installed PWA)
   │  fetch /api/app/*            (session cookie)
   ▼
Next.js route handlers  ──►  service-role Supabase client  ──►  Supabase mirror
   │                                (existing query modules, reused)
   └── Phase 2 writes ──►  Housecall Pro API  ──► upsert mirror immediately
```

Route handlers reuse the existing query modules — `getDashboardSnapshot`, the
week-ahead builder, `nearby.ts` — rather than reimplementing them. **Every JSON
payload carries `generated_at`** so freshness is a property of the data.

### Auth

Supabase Auth, email + password, **no public sign-up** — accounts are created by
hand in the Supabase dashboard. Session in an HTTP-only cookie, refreshed and
enforced by Next middleware covering `/app/*` and `/api/app/*`. An expired
session redirects to `/app/login` preserving the intended destination.

This adds `@supabase/ssr`. The project is deliberately dependency-lean, so the
addition is called out rather than assumed: the alternative is hand-rolling
cookie-based session refresh, which is more code in the one place where bugs are
security bugs.

The service-role key stays server-side, exactly as today. **No RLS work is
required, and no new path to getting RLS wrong is introduced.**

### Offline

Service worker precaches the app shell. `/api/app/*` GETs are
stale-while-revalidate: render cached data immediately, revalidate in the
background, and when the network is gone say so plainly —
*"Offline — showing data from 8:42a."* Never a spinner on a blank screen.

Phase 2 adds an IndexedDB write queue with client-generated idempotency keys,
flushed on app open and on `online`, with a visible pending-changes count.

## Phase 1 — the usable app

Ship target: the owner installs it from Safari, signs in, and runs the day.

### 📋 Today — `GET /api/app/today`

Day's jobs in time order and three counters (in progress, emergency, unpaid
invoices). Reuses `getDashboardSnapshot` and the
`todaySchedule` row builder. Canceled jobs excluded (commit `116450c`).
Display statuses map from live strings. The emergency and commercial counters
are labelled to reflect that they count tagged jobs only.

### 📅 Schedule — `GET /api/app/schedule?week=`

Week strip with a per-day job count; tap a day for its list. Filter by
technician from the `technicians` table. Weekends included — Trinity books them.
Reuses the week-ahead query in `src/lib/dashboard/week.ts`.

### 📋 Job detail — `GET /api/app/jobs/[id]`

Time, address, technician, service, booked amount, notes from `raw`, linked
invoice. Call and Directions are `tel:` and `maps:` links — no API, works
offline. Two honesty requirements:

- The amount is `total_amount_cents`, **what was booked, not what was paid.**
  The mirror has no line items.
- **No estimate link is shown**, because no key exists to join on. This is a
  constraint, not an omission.

Phase 1 displays status read-only, using `scheduleStatus()`'s existing labels —
`Scheduled`, **`En Route`**, `In Progress`, `Completed`, `Needs Scheduling`,
`Canceled`. No status *control* is drawn, because none can be built. En Route
appears whenever the technician has tapped "On my way" inside HCP.

### 👤 Customers — `GET /api/app/customers?q=`

Search-first over 1,497 records, server-side, across name, company, phone and
address. Phone normalization means `5185550142`, `(518) 555-0142` and
`518-555-0142` are one query. Recently-viewed customers appear before the user
types. Detail shows contact, lifetime value, and job history.

### 💵 Money — `GET /api/app/estimates`, `GET /api/app/invoices`

Two segments in one tab. Estimates reuse `isOpenEstimate()` verbatim. Invoices
default to unpaid (`status = 'open'`), with overdue computed as
`due_date < today AND status != 'paid'` and the day count shown in red. The tab
carries an unpaid-count badge.

### 📍 Dispatch — existing `GET /api/dispatch/nearby`

A UI port; the logic already exists. The screen states that results depend on
geocoded history, so a town never worked in returns nothing — which is itself
the answer.

### 🔑 Login

Email + password, stays signed in. Shows an install hint when opened in a
browser tab rather than the installed app, since push silently does not exist
there.

## Phase 2 — notifications, acknowledgement, and writes

### Schema (migration `0007`)

- **`push_subscriptions`** — `user_id`, `endpoint` (unique), `p256dh`, `auth`,
  `created_at`, `last_success_at`, `failure_count`.
- **`job_acks`** — one row per job: `job_id` (pk), `kind`
  (`on_my_way` | `snoozed`), `acked_by`, `acked_at`, `snooze_until`,
  `hcp_note_id`.
- **`notification_prefs`** — `user_id` (pk), per-type switches (reminders,
  digest, invoices, estimates), `quiet_start`, `quiet_end`.

The dedupe ledger from `0006_notifications.sql` is reused as-is for
exactly-once delivery.

### Reminder delivery

VAPID keys in env (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`),
sent with `web-push` from the existing cron invocation using the same `claim()`
pattern that already guarantees one digest per day.

Rule, stated precisely so it is testable: on each run, select jobs where
`scheduled_start > now` and
`scheduled_start <= now + REMINDER_LEAD_MINUTES` (default **40**), excluding
canceled jobs, jobs with an unexpired `job_acks` row, and users whose reminders
are off or who are inside quiet hours. Each surviving job is claimed under
`reminder:<job_id>`, so it sends exactly once regardless of how many runs match
it.

**A job is also suppressed when Housecall Pro already says someone is handling
it** — `raw.work_timestamps.on_my_way_at` or `started_at` is stamped, or
`scheduleStatus()` returns `En Route` / `In Progress`. If the technician tapped
"On my way" in the HCP app, reminding the owner is noise. The ack is therefore a
*second* source of the same signal, not the only one.

Quiet hours evaluate in `America/New_York` exactly as
`src/lib/notifications/schedule.ts` already does, defaulting to **21:00–06:00**.
**Emergency jobs ignore quiet hours.**

**Timing is bounded by the external scheduler, not by code.** With a 40-minute
lead: at the current 15-minute cadence a reminder arrives 25–40 minutes ahead;
at a 5-minute cadence, 35–40. That is a scheduler setting to be changed
deliberately, and the spec does not claim more precision than the scheduler
provides.

### The acknowledgement

Push payload deep-links to `/app/jobs/<id>?from=push`; the service worker's
`notificationclick` opens exactly that job, not the home screen. **On my way**
posts to `/api/app/jobs/[id]/ack`, which upserts `job_acks` and silences the
reminder. Snooze sets `snooze_until` and the rule skips the job until it passes.

The job screen states **"Status in HCP: scheduled"** alongside the ack. The ack
is ours — it controls reminders, the list badge, and the app icon badge — and it
never claims to have changed a status that no API can change.

Optionally the ack also posts a note to the HCP job so a trace exists there.
This is genuinely reversible: `POST /jobs/{id}/notes` returns an id we store,
and `DELETE /jobs/{job_id}/notes/{note_id}` (`housecall.v1.yaml:1505-1529`)
retracts it when the user taps UNDO.

### Icon badge

`navigator.setAppBadge()` on app open and on push receipt, counting today's
upcoming unacked jobs. Supported on installed iOS web apps.

### Writes

All go through our routes, which call HCP and then immediately upsert the mirror
so the screen updates without waiting for a webhook.

| Action | Endpoint | Notes |
|---|---|---|
| Add note to job | `POST /jobs/{id}/notes` | Reversible via note DELETE |
| Approve estimate | `POST /estimates/options/approve` | Body `{option_ids: […]}` |
| Decline estimate | `POST /estimates/options/decline` | Confirm sheet, names the customer |
| Create customer | `POST /customers` | |

Two properties of approval worth encoding in the UI:

- It sets **"pro approved"**, which `APPROVED_STATUSES` already recognises, so
  the mirror's `isOpenEstimate()` stays consistent.
- **If the company has "automatically copy an approved estimate to a new job"
  enabled, approving creates a job.** The confirm sheet must say so.

### Comfort features (all eight, agreed)

1. **Undo on every write**, 5-second toast. Reversibility is what makes a phone
   UI safe to tap.
2. **Instant open, basement-tolerant.** Cached render with a freshness stamp;
   writes queue offline and flush on open or `online`.
3. **Quiet hours + per-type switches.** Nothing buzzes 9pm–6am except
   emergencies; each notification class toggles independently.
4. **Guard rails only where earned.** Declining an estimate is customer-visible
   and irreversible, so it confirms. Reversible actions get no friction.
5. **6am digest + live alerts as push**, reusing the existing detect/dedupe
   logic as a second delivery channel. The same detection also renders an
   **activity strip** at the bottom of Today ("Invoice #4471 paid — 12 min
   ago"). It ships in Phase 2 rather than Phase 1 because it is the push
   pipeline's data, not the schedule's, and building it twice would be the
   drift this codebase keeps guarding against.
6. **App icon badge** = upcoming jobs not yet acknowledged.
7. **Forgiving search** — phone formats normalized, partial addresses, recently
   viewed first.
8. **Always state data freshness** — pull-to-refresh everywhere, visible
   "updated 2 min ago", explicit offline wording.

## Error handling

- **Writes are optimistic with a 5-second undo.** Failure raises a persistent
  *"Couldn't save — Retry"* banner. A write is never silently lost.
- **HCP failures surface the actual cause**, the discipline established by
  commit `df8cedf`.
- **Push endpoints returning 404/410** have their subscription deleted. Other
  push errors are logged and never abort the sync run — matching the try/catch
  behaviour already regression-tested on the estimate webhook path.
- **Expired session** redirects to login preserving the destination.
- **Offline** serves cache and says so; writes queue rather than fail.

## Testing

Vitest, following existing patterns.

- **Unit:** reminder-window selection, quiet-hours evaluation, ack suppression,
  snooze expiry, badge counting, phone normalization, status mapping.
  **Fixtures use live status strings** — the backlog records a suite that passed
  while production read zero because fixtures encoded invented values.
- **Route handlers:** tests alongside, as in `src/app/api/**/__tests__/`.
- **Components:** Testing Library, as in
  `src/app/dashboard/components/__tests__/`.
- **Manual iPhone checklist** (cannot be automated; belongs in the runbook):
  install from Safari → grant permission → receive push → tap opens the job →
  ack silences it → airplane-mode read → queued write flushes on reopen.

## Rejected alternatives

- **Direct client-side Supabase with RLS.** Buys free Realtime updates and less
  glue code, at the price of making RLS policies the only barrier between a
  public anon key and 1,497 customers' addresses — on every table, forever. The
  data changes when a 15-minute cron runs; pull-to-refresh and push already
  cover "something happened."
- **Writing job status back to HCP.** No endpoint exists. A local ack satisfies
  the actual requirement ("so it doesn't come up in notifications again")
  without lying about HCP state.
- **Server-rendered mobile pages.** Caching HTML gives a stale page that cannot
  be dated; JSON can be.
- **Mobile app at the root.** Collides with the existing `/dispatch` route and
  disturbs the working desktop dashboard for no gain.
- **One-phase delivery.** Push cannot be tested until the app is installed on a
  real iPhone, so bundling it with the readable app delays everything behind the
  riskiest part.

## Open risks

- **The estimate approve/decline endpoints list *Company API Key* and OAuth in
  their security block — not *Application API Key*.** The existing
  `HOUSECALL_API_KEY` may not be authorized. **Phase 2 must probe this against
  the live account** (in the style of `scripts/probe-invoice-filters.mjs`)
  before the approve/decline buttons are built. If it fails, Money ships
  read-only and the buttons are dropped.
- **Reminder punctuality depends on an external scheduler** that is already
  load-bearing and already fails silently. A dead scheduler now also means no
  job reminders.
- **iOS push subscriptions are lost if the app icon is deleted**, with no
  server-side signal. Stale subscriptions are pruned on 404/410 at send time.

## Out of scope

Technician accounts and roles; a desktop/responsive build (explicitly later);
creating or rescheduling jobs; taking payments; photo capture and attachments;
line-item editing; offline *reads* of records never visited.
