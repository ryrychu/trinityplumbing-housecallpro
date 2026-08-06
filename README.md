# Trinity Plumbing — Housecall Pro Integration (Phase 1)

A Next.js 14 app that syncs Housecall Pro data (customers, jobs, estimates,
invoices, technicians, tags, notes, attachments) into a dedicated Supabase
Postgres database via webhooks (real-time) and a Vercel Cron polling backfill,
and surfaces it through an Operations Dashboard and a Geographic Scheduling
Assistant. The dashboard reads only from Supabase — it never calls Housecall
Pro directly.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in real values
npm run dev                  # http://localhost:3000
npm test                     # Vitest
npm run build                # production build / typecheck / lint
```

## Mobile app (`/app`)

An installable iPhone PWA at `/app/*`, alongside the existing `/dashboard`.
Read-only in Phase 1 — it mirrors the same Supabase data the desktop
dashboard reads, with a phone-sized layout and offline caching, but makes no
writes of its own. Five tabs:

- **Today** — the day's jobs, Eastern time.
- **Schedule** — the same schedule, day-by-day.
- **Customers** — search by name or phone, with job history.
- **Money** — open estimates and pending/overdue invoices.
- **Dispatch** — the "are we already going near there?" lookup, same
  `/api/dispatch/nearby` route the desktop `/dispatch` page uses.

Auth is Supabase Auth, gated by `src/middleware.ts` on every `/app/*` page
and `/api/app/*` route: signed-out browser requests are redirected to
`/app/login`, signed-out API requests get a 401. There is no public
sign-up — accounts are created by hand in the Supabase dashboard (see the
runbook below). Behind that gate, `/api/app/*` routes read with
`getSupabaseServerClient()` (`src/lib/supabase/client.ts`), which holds the
`SUPABASE_SERVICE_ROLE_KEY` — a server-only env var that never reaches the
browser. The middleware's sign-in check is what stands between a visitor and
the data; there is no Postgres row-level security on top of it. That check
only guards requests that pass through it — a query issued straight from
browser code with the anon key would skip the middleware entirely, and with
no RLS underneath to fall back on, it would read the whole `customers`
table with no login required. That is why every data read is routed through
`getSupabaseServerClient()` in server-only code (`/api/app/*` route
handlers) rather than a browser-side Supabase client, and why that
confinement has to stay that way, not just happen to be how it's written
today.

**Before anyone installs this on a phone, read
[`docs/MOBILE-INSTALL.md`](docs/MOBILE-INSTALL.md).** It covers creating
accounts (and the dashboard setting that must be flipped before deploy, not
after), installing from Safari, and a verification checklist including an
offline-mode sequence that has to be run in a specific order to mean
anything. The original spec is
[`docs/superpowers/plans/2026-08-06-mobile-pwa-phase-1.md`](docs/superpowers/plans/2026-08-06-mobile-pwa-phase-1.md).

## Environment variables (set in Vercel → Project → Settings → Environment Variables)

- `HOUSECALL_API_KEY` — Bearer token for the Housecall Pro public API.
- `HOUSECALL_WEBHOOK_SECRET` — shared secret used to verify webhook signatures.
- `NEXT_PUBLIC_SUPABASE_URL` — the new dedicated Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key.
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (server-only, never exposed to the client).
- `CRON_SECRET` — shared secret for authorizing the `/api/cron/sync` polling route.
- `SLACK_WEBHOOK_SCHEDULE` — Slack incoming webhook for the job-schedule channel
  (6:00 a.m. daily digest + Monday week-ahead), read in
  `src/app/api/cron/sync/route.ts`.
- `ADMIN_TRIGGER_TOKEN` — password for the `/admin` page, which posts a
  schedule digest to Slack on demand. Unlike every other secret here you must
  be able to read this one back in order to type it in, so keep a copy when you
  set it. The app has no other authentication, so this is the only thing
  stopping a stranger who finds the URL from posting to Slack.
- `SLACK_WEBHOOK_INVOICES` — Slack incoming webhook for the paid-invoice
  channel, read in `src/lib/notifications/dispatch.ts`.
- `SLACK_WEBHOOK_ESTIMATES` — Slack incoming webhook for the approved-estimate
  channel, read in `src/lib/notifications/dispatch.ts`.
- `SLACK_ALERTS_ENABLED` — master kill switch for all Slack output. Only the
  exact string `true` enables posting; unset, empty, or any other value (e.g.
  `false`, `1`) disables it. **Do not set this until you have applied and
  verified migration `0006_notifications.sql` — see
  [`docs/SLACK-ROLLOUT.md`](docs/SLACK-ROLLOUT.md).**

## Database

The schema lives in `supabase/migrations/0001_init_schema.sql`. Apply it to a
new, dedicated Supabase project (not the existing `inquiries.trinity.plumbing`
instance):

```bash
npx supabase link --project-ref <your-new-project-ref>
npx supabase db push
```

## Housecall Pro webhook setup

In the Housecall Pro dashboard's webhook settings, point event subscriptions
(customer, job, estimate, invoice, employee create/update events) at:

`https://<your-vercel-domain>/api/webhooks/housecall`

Use the same secret you set for `HOUSECALL_WEBHOOK_SECRET`. The signature is an
HMAC-SHA256 of the raw request body sent in the `X-HousecallPro-Signature`
header — confirm this header name against your account's webhook settings and
update `src/app/api/webhooks/housecall/route.ts` if it differs.

## Slack notifications

Three notification types post to Slack, all gated behind `SLACK_ALERTS_ENABLED`:
a 6:00 a.m. daily schedule digest, a Monday week-ahead digest, and near-real-time
alerts for paid invoices and approved estimates. **Do not enable this without
first reading [`docs/SLACK-ROLLOUT.md`](docs/SLACK-ROLLOUT.md)** — the live
database already holds thousands of paid invoices and approved estimates, and
enabling alerts before the dedupe ledger is seeded and verified will flood the
Slack channels with historical data.

Two behaviors worth understanding before touching this:

- **Digest timing is decided in code, not by the cron schedule.** Every run of
  `GET /api/cron/sync` evaluates the current time in `America/New_York`
  (`src/lib/notifications/schedule.ts`) and sends that day's digest if the
  local time is between 06:00 and 12:00 and one hasn't been sent yet
  (`claim()` in `src/lib/notifications/dedupe.ts` guarantees exactly one per
  day). This runs every day, weekends included — Trinity books Saturday and
  Sunday work — and an empty day still posts "No jobs scheduled today" so
  silence always means the scheduler is broken, never that the day was quiet. Cron expressions can't express "6am Eastern" — only a fixed UTC hour,
  which is wrong for half the year across DST — so the window check runs on
  every invocation instead. A missed 6:00 run self-heals on the next one,
  right up until the 12:00 cutoff.
- **The Vercel cron is the scheduler.** `vercel.json` runs
  `GET /api/cron/sync` every 15 minutes (`*/15 * * * *`), which the account's
  Vercel Pro plan allows; the external scheduler that used to be required was
  retired once that landed. Vercel injects
  `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set. Because a
  run happens every 15 minutes, some run always falls inside the 06:00–12:00
  `America/New_York` digest window regardless of DST, and a missed 6:00 digest
  self-heals on the next run. Paid invoices have no Housecall Pro webhook and are
  only ever picked up by this polling route, so if the Vercel cron stops
  firing, paid-invoice alerts stop with it. Nothing in Slack reports that
  any more — the digest used to carry a `last sync: N min ago` footer as a
  tripwire, and it was removed as noise — so a stalled scheduler now shows up
  as a *missing* 6 a.m. digest rather than a stale-looking one. That is still
  a real signal, since the digest sends every day including weekends and
  empty days, but it needs someone to notice an absence. Estimate approvals,
  by contrast, arrive by webhook and post almost instantly regardless of the
  poller's health.

## Deploy

```bash
vercel link
vercel env add HOUSECALL_API_KEY
vercel env add HOUSECALL_WEBHOOK_SECRET
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add CRON_SECRET
vercel env add SLACK_WEBHOOK_SCHEDULE
vercel env add SLACK_WEBHOOK_INVOICES
vercel env add SLACK_WEBHOOK_ESTIMATES
# Leave SLACK_ALERTS_ENABLED unset for now — see docs/SLACK-ROLLOUT.md.
vercel --prod
```

The Vercel Cron job defined in `vercel.json` runs the sync every 15 minutes
and is the scheduler described above; no external caller is required.
Confirm whether your Vercel plan authorizes cron requests via
a `Bearer $CRON_SECRET` `Authorization` header or the built-in `x-vercel-cron`
header, and adjust the auth check in `src/app/api/cron/sync/route.ts`
accordingly before deploying.
