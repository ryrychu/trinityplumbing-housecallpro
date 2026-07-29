# Slack Notifications — Design

**Date:** 2026-07-29
**Status:** Approved, ready for implementation planning
**Depends on:** Phase 1 foundation (HCP → Supabase sync, live and verified)

## Goal

Push three classes of Housecall Pro activity into Slack so the owner and
dispatcher get operational visibility without opening the dashboard:

1. **Job schedule** — a 6:00 a.m. weekday digest of today's jobs, plus a Monday
   look-ahead for the week.
2. **Paid invoices** — posted as invoices transition to `paid`.
3. **Approved estimates** — posted as estimate options are approved.

Each class gets its own Slack channel.

## Constraints (established from the live account, not assumed)

These are load-bearing. Each is documented in the repo already.

- **Invoices have no Housecall Pro webhook.** The HCP dashboard offers events
  only for Jobs, Job Appointments, Estimates, Estimate Options, Customers, and
  Leads (`docs/NEXT-SESSION-HANDOFF.md`). Paid-invoice detection *must* be
  poll-based. Estimates *do* have webhooks, so approvals can be near-instant.
- **The current invoice poll is gated to once per 20 hours.** Invoices carry no
  `updated_at`, so the incremental cursor can never advance and every run
  re-paged all ~2.9k invoices (58 API calls, ~70s). `DEFAULT_INVOICE_RECONCILE_HOURS`
  in `src/app/api/cron/sync/route.ts` caps that at one full pass per 20h.
  **Naively reusing that path would make "real-time" paid-invoice alerts up to
  20 hours stale** — see "Targeted invoice polling" below for the fix.
- **Vercel Hobby caps cron at once per day.** `vercel.json` runs `0 8 * * *`;
  commit `a01c105` set that deliberately. An external scheduler (GitHub Actions
  or similar) will ping `/api/cron/sync` every 15 minutes instead.
- **Live invoice statuses:** `paid` 2217 · `canceled` 570 · `voided` 42 ·
  `open` 25. There is no `pending`. (`src/lib/dashboard/queries.ts`)
- **Estimate approval is per-option**, at `raw.options[].approval_status`, with
  approved values `approved` and `pro approved`. (`src/lib/dashboard/queries.ts`)
- **PostgREST caps every response at 1000 rows.** A bare `select("*")` silently
  truncates — this already caused a real bug (19 jobs reported instead of 91).
  Detection must never depend on an unbounded table scan.
- **Business timezone is `America/New_York`.** Vercel cron is UTC.

## Architecture

A notification layer alongside the existing sync pipeline. Two detection paths,
because HCP's webhook coverage forces it:

```
HCP estimate webhook ──► /api/webhooks/housecall ──┐
                                                    ├─► detect ─► claim ─► postSlack
external scheduler (15m) ──► /api/cron/sync ───────┘
                                    │
                                    └─► isDailyDigestDue / isWeeklyDue ─► digest
```

Rejected alternatives:

- **Pure cron differ** (single notify route, no webhook path) — discards the
  instant estimate path for no gain and re-reads rows sync just wrote.
- **Supabase DB triggers** — moves logic into plpgsql, outside the Vitest suite
  that covers everything else in this repo.

### Modules

| File | Responsibility |
|---|---|
| `src/lib/slack/client.ts` | `postSlack(url, text)` — fetch, timeout, log-and-swallow |
| `src/lib/slack/format.ts` | Message builders. Pure, no I/O. |
| `src/lib/notifications/dedupe.ts` | `claim(kind, entityId) -> boolean` |
| `src/lib/notifications/detect.ts` | Touched records → notifications |
| `src/lib/notifications/schedule.ts` | `isDailyDigestDue` / `isWeeklyDue` |

Modified: `src/app/api/cron/sync/route.ts`, `src/app/api/webhooks/housecall/route.ts`,
`src/lib/sync/syncService.ts` (collect touched records).

## Configuration

| Env var | Purpose |
|---|---|
| `SLACK_WEBHOOK_SCHEDULE` | Job schedule channel (daily digest + weekly look-ahead) |
| `SLACK_WEBHOOK_INVOICES` | Paid invoice channel |
| `SLACK_WEBHOOK_ESTIMATES` | Approved estimate channel |
| `SLACK_ALERTS_ENABLED` | Master kill switch. **Defaults to off.** |

Slack **incoming webhooks**, not a bot token: three fixed channels need no
dynamic channel resolution, no OAuth, no scopes, no token refresh.

Two rules:

1. `SLACK_ALERTS_ENABLED` defaults to off so the notifier can be deployed and
   observed in logs before it can post anything.
2. **A missing webhook URL is a no-op, not an error.** Unset URL → that class of
   alert is skipped and logged. Sync must never fail because Slack is
   misconfigured.

## Data model

New migration `supabase/migrations/0006_notifications.sql`:

```sql
create table notifications_sent (
  kind        text not null,   -- 'invoice_paid' | 'estimate_approved'
                               -- | 'daily_digest' | 'weekly_lookahead'
  entity_id   text not null,
  sent_at     timestamptz not null default now(),
  primary key (kind, entity_id)
);
```

`entity_id` by kind:

- `invoice_paid` — invoice id
- `estimate_approved` — `"{estimateId}:{optionId}"`, because approval is
  per-option; approving option B must not be silenced by option A. When an
  option has no `id`, the fallback is the literal string `0` — this **must**
  match the `coalesce(o->>'id', '0')` in the seed below, or seeded rows won't
  suppress the notifications they were written to suppress.
- `daily_digest` — **local** (`America/New_York`) date, `YYYY-MM-DD`
- `weekly_lookahead` — that Monday's local date

### Dedupe rule: insert first, post second

`claim()` attempts the insert. Primary-key collision → already notified, return
`false`, post nothing. Insert succeeds → return `true`, post.

This is idempotent under retries, overlapping cron runs, and duplicate HCP
webhook deliveries, with no locking.

The primitive is **batch**: `claimMany(kind, ids) -> newlyClaimedIds`, a single
`upsert(..., { ignoreDuplicates: true }).select()`. Postgres returns only the
rows it actually inserted. This matters because the 20-hour full reconcile
re-touches all ~2,200 paid invoices; per-row claims would be 2,200 round trips,
whereas `claimMany` is one. `claim()` is a thin single-id wrapper.

**Trade-off, accepted:** a crash between insert and post loses that one
notification. The inverse order would risk double-posting on every retry.
Losing an alert beats spamming the channel, and the daily digest re-surfaces the
day's activity anyway.

### Backfill hazard

2,217 invoices are already `paid`. An empty `notifications_sent` against a full
`invoices` table means 2,217 Slack messages.

The migration therefore **creates the table and seeds it in the same file**, so
no window exists where the notifier can observe an empty table:

```sql
insert into notifications_sent (kind, entity_id)
select 'invoice_paid', id from invoices where status = 'paid'
on conflict do nothing;

insert into notifications_sent (kind, entity_id)
select 'estimate_approved', e.id || ':' || coalesce(o->>'id', '0')
from estimates e, jsonb_array_elements(e.raw->'options') o
where lower(o->>'approval_status') in ('approved', 'pro approved')
on conflict do nothing;
```

**Consequence:** nothing already paid or approved as of deploy day generates an
alert. Only transitions from that point forward. A quiet first day is success.

## Scheduling

The 6 a.m. rule is **not** expressed as a cron expression. Cron cannot say
"6 a.m. Eastern" — only a fixed UTC hour that is wrong for half the year.

The every-15-minute endpoint asks whether a digest is due:

```
isDailyDigestDue(now):            # PURE — time only, no DB access
  local = now in America/New_York        # Intl.DateTimeFormat, no new deps
  if local is Sat or Sun     -> false
  if local time < 06:00      -> false
  if local time >= 12:00     -> false   # missed window
  else                       -> true

# caller, in the cron route:
if isDailyDigestDue(now) and claim('daily_digest', localDate(now)):
    postSlack(SLACK_WEBHOOK_SCHEDULE, buildDigest(...))
```

`schedule.ts` stays **pure** — it answers "is this a digest moment?" from the
clock alone, so its DST and cutoff tests need no database. The
already-sent-today check is the same `claim()` used everywhere else, applied by
the caller. Keeping these separate is what makes the date logic testable in
isolation.

Properties this buys:

- **DST handled permanently.** `America/New_York` is a rule, not an offset.
- **Self-healing.** Scheduler down at 6:00 → the 6:15 ping sends it. The noon
  cutoff prevents a stale digest arriving at bedtime.
- **Weekday logic is unit-testable**, unlike a cron `1-5` field.
- **Vercel's cron cap stops mattering.**

`isWeeklyDue` is the same mechanism: Mondays at or after 06:00 local,
`entity_id` = that Monday's date. On Mondays the weekly look-ahead posts
**before** the daily digest in the same run.

The existing `vercel.json` daily cron **stays**, as a safety net if the external
scheduler dies. It hits the same idempotent endpoint; the dedupe table absorbs
the extra invocation.

**Operational risk:** the external scheduler becomes load-bearing. If it stops
silently, invoice alerts stop with it. Mitigation: the daily digest footer shows
`last sync: N min ago`, making a stalled pipeline visible in a message that is
read every morning.

## Detection

**Detection reads only the records sync just touched.** The cron sorts
newest-first and stops at the `sync_cursors` watermark, so each run touches a
handful of records. `syncService` collects those; the notification pass inspects
that set. Nothing re-queries the tables.

This is deliberate: a "find all paid invoices not yet notified" query would hit
the 1000-row PostgREST cap that already caused a production bug. Detection stays
O(changes) and that bug class cannot recur.

### Targeted invoice polling

The 20-hour reconcile gate would defeat the whole point of a 15-minute
scheduler. `housecall.v1.yaml` (lines 3341–3465) documents query parameters on
`GET /invoices` that the existing client does not use:

- `status` — enum `open | pending_payment | paid | voided | uncollectible | canceled`
- `paid_at_min` / `paid_at_max` — ISO instants
- `sort_by` — enum including `paid_at`

So paid-invoice detection can ask for exactly what it needs:

```
GET /invoices?status=paid&paid_at_min=<watermark>&sort_by=paid_at&sort_direction=desc&page_size=50
```

**One API call per run instead of 58**, and the result is already scoped to
newly-paid invoices. This makes 15-minute latency *cheaper* than the current
20-hour reconcile, not more expensive.

**This must be verified empirically before it is relied on.** The same OpenAPI
file previously documented behavior the live account did not honor — the item 4
probe found `updated_after` / `updated_since` silently ignored, and the live
invoice payload has no `updated_at` even though `sort_by` lists it. Task 1 is a
probe script; the plan branches on its result.

The watermark is stored in `sync_cursors` under resource `invoices_paid`
(`last_updated_at` = max `paid_at` seen), reusing the existing table rather than
adding another. `notifications_sent` remains the correctness guarantee; the
watermark is only a fetch optimization.

**Fallback if the filters do not work:** keep the existing full reconcile but
lower `INVOICE_RECONCILE_HOURS` to 1, accepting ~1,400 API calls/day for
one-hour latency. Slower and costlier, but no code restructuring.

The 20-hour full reconcile stays either way, as a correctness backstop against a
missed or mis-filtered window.

- **Invoice paid** — invoice with `status === 'paid'` →
  `claim('invoice_paid', id)` → post. A newly-created already-paid invoice
  notifies, which is correct.
- **Estimate approved** — for each `raw.options[]` with `approval_status` in
  `approved` / `pro approved` → `claim('estimate_approved', "{est}:{opt}")` →
  post. Runs on **both** the webhook path (instant) and the cron path (safety
  net); the shared claim table makes the overlap harmless.

## Messages

**One message per channel per run.** Four newly-paid invoices produce one
message with four lines, not four messages. Keeps the per-webhook rate limit
irrelevant and the channel readable.

**All amounts are cents in the DB** (`amount_cents`, `total_amount_cents`).
Conversion to dollars happens once, in `format.ts`, and is directly unit-tested —
a cents/dollars mixup is the most likely embarrassing bug in a money channel.

### Daily digest

Renders `getDashboardSnapshot().todaySchedule`, which already returns time,
customer, technician, zone, compass, miles, and drive minutes per job.
**No new geo code and no duplicated zone logic** — the Slack message cannot
disagree with the dashboard because both read one function.

```
*Today - Tue Jul 29* - 6 jobs

8:00a  Mary Kolakowski - Delmar
       Albany Zone / SW / 14 mi / 24 min
       Tech: Dan

10:30a Trinity Commercial - Troy [COMMERCIAL]
       Albany Zone / W / 8 mi / 15 min
       Tech: Dan

1:00p  R. Hoffman - Stephentown [EMERGENCY]
       Southern Berkshire / SE / 19 mi / 31 min
       Tech: Mike

_last sync: 4 min ago_
```

An empty day still posts (`No jobs scheduled today`) — silence is ambiguous.

### Weekly look-ahead

Same per-job format, grouped by day across the Monday–Sunday range. Needs one new
query (jobs across a date range grouped by day), reusing `weekRange` from
`src/lib/dashboard/week.ts`.

### Paid invoice / approved estimate

Customer, amount, and identifier per line, one message per run.

## Error handling

`postSlack` catches and logs; failures never propagate. A Slack outage must not
fail the sync the dashboard depends on. Skipped-because-unconfigured is logged
distinctly from failed-to-post.

## Testing

Vitest, matching the existing 57-test suite.

**`schedule.ts`** — the adversarial cases:
- DST spring-forward **Sun Mar 8 2026** and fall-back **Sun Nov 1 2026**.
- **UTC-rollover trap:** `2026-07-29 21:00 ET` = `2026-07-30 01:00 UTC`. Keying
  dedupe on the UTC date would admit a second digest. Locks in local-date keying.
- Weekend skip, before-06:00, after-noon-cutoff.
- Already-sent-today is a `dedupe.ts` test, not a `schedule.ts` one — see the
  pure/caller split above.

**`format.ts`** — cents→dollars (`$4,280.00`, not `$428000`); empty-schedule
message; emergency/commercial markers; a null-heavy job (no technician, no
geocode) rendering without crashing, since real HCP data has nulls in all those
columns.

**`dedupe.ts`** — `claim` returns `true` once, `false` on every repeat.

**`detect.ts`** — paid invoice detected; `open` / `canceled` / `voided` ignored;
multi-option estimate where option B is approved and A is not.

## Rollout

Order matters.

1. Apply `0006_notifications.sql` (creates **and** seeds). Verify the seeded row
   count before anything else.
2. Deploy with `SLACK_ALERTS_ENABLED` unset. Watch logs for a run or two: the
   detector should report **zero or very few** notifications. A large number
   means the seed did not take — stop and fix.
3. Create the three Slack incoming webhooks; add the URLs as Vercel env vars.
4. Set `SLACK_ALERTS_ENABLED=true`. Confirm the next 6 a.m. digest is correct.
5. Stand up the external 15-minute scheduler last, once the notifier is
   known-good.

Step 2 is the only cheap moment to catch a seeding mistake before it becomes
2,200 Slack messages. Do not skip it.

## Out of scope

- Slack slash commands or interactive buttons (approve/dispatch from Slack).
- Per-user DMs or technician-specific routing.
- Configurable channel routing in the DB — three env vars is enough for three
  fixed channels.
- Alerting on job status changes, new leads, or overdue invoices.
