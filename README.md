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
- **This makes an external scheduler load-bearing.** For the digest to arrive
  anywhere near 6am, and for paid-invoice alerts to be timely, something must
  call `GET /api/cron/sync` with an `Authorization: Bearer $CRON_SECRET` header
  roughly every 15 minutes. The `vercel.json` cron (`0 11 * * *`, once a day)
  is **not** that scheduler — it's a safety net, because Vercel's Hobby plan
  caps cron invocations at once per day. It is scheduled for 11:00 UTC
  specifically because that is the only hour that lands inside the 06:00–12:00
  `America/New_York` digest window year-round (06:00 EST in winter, 07:00 EDT
  in summer) — any earlier UTC hour, including the previous `0 8 * * *`, falls
  before 06:00 Eastern in both DST regimes and can only ever run the sync,
  never produce a digest. Paid invoices have no Housecall Pro webhook and are
  only ever picked up by this polling route, so if the external scheduler dies
  silently, paid-invoice alerts stop with it — that's why the daily digest
  footer includes `last sync: N min ago`, as a tripwire. Estimate approvals,
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

The Vercel Cron job defined in `vercel.json` runs the sync once a day as a
safety net — it is not a substitute for the external 15-minute scheduler
described above. Confirm whether your Vercel plan authorizes cron requests via
a `Bearer $CRON_SECRET` `Authorization` header or the built-in `x-vercel-cron`
header, and adjust the auth check in `src/app/api/cron/sync/route.ts`
accordingly before deploying.
