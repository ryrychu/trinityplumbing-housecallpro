# Slack Notifications — Setup Checklist

One ordered list of everything a human has to do to take Slack notifications
live. Detail and troubleshooting live in [SLACK-ROLLOUT.md](SLACK-ROLLOUT.md);
this is the tracking sheet.

**Order matters.** Steps 1 and 2 are the flood gate — do not set
`SLACK_ALERTS_ENABLED=true` until step 2 passes.

Current state: all code is merged to `main` and pushed. Nothing is enabled.
`SLACK_ALERTS_ENABLED` is unset, no webhook URLs are configured, and the
migration is unapplied.

---

## 1. Apply the database migration — Supabase

- [ ] `npx supabase db push`
- [ ] Confirm the migration applied without error

This creates `notifications_sent` **and seeds it** with every already-paid
invoice and already-approved estimate option, so none of them re-notify.

## 2. Verify the seed — THE FLOOD GATE

- [ ] Run both queries in the Supabase SQL editor:

```sql
select kind, count(*) from notifications_sent group by kind;
select count(*) from invoices where status = 'paid';
```

- [ ] Confirm `invoice_paid` **equals** the second number (currently low 2,200s)
- [ ] Confirm `estimate_approved` is greater than 0

**If `invoice_paid` is 0 or far short — STOP.** The seed did not take, and
enabling alerts would post thousands of Slack messages. Do not continue until
this matches.

## 3. Create the Slack channels and webhooks

- [ ] Create three channels (names are yours — only the URLs matter to the code)
- [ ] api.slack.com/apps → **Create New App** → *From scratch* → pick your workspace
- [ ] Left sidebar → **Incoming Webhooks** → toggle **Activate** on
- [ ] **Add New Webhook to Workspace** — once per channel, three times
- [ ] Label each URL as you copy it — they are indistinguishable afterward

| Channel purpose | Env var it becomes |
|---|---|
| job schedule (6am digest + Monday week-ahead) | `SLACK_WEBHOOK_SCHEDULE` |
| paid invoices | `SLACK_WEBHOOK_INVOICES` |
| approved estimates | `SLACK_WEBHOOK_ESTIMATES` |

Treat these URLs as secrets — anyone holding one can post to that channel.

## 4. Add the env vars to Vercel — with alerts still OFF

Vercel → Project → Settings → Environment Variables:

- [ ] `SLACK_WEBHOOK_SCHEDULE`
- [ ] `SLACK_WEBHOOK_INVOICES`
- [ ] `SLACK_WEBHOOK_ESTIMATES`
- [ ] **Leave `SLACK_ALERTS_ENABLED` unset for now** (only the exact string
      `true` enables posting; unset means off)
- [ ] Redeploy so the new vars take effect

## 5. Subscribe the Housecall Pro events

The webhook endpoint is already live and verified from Phase 1, and
`HOUSECALL_API_KEY` / `HOUSECALL_WEBHOOK_SECRET` are already set. Only the
event subscriptions need checking.

- [ ] In HCP webhook settings, confirm the subscription to
      `https://<your-domain>/api/webhooks/housecall` includes **Estimates**
- [ ] Subscribe **Estimate Options** too, if offered as a separate category

**Nothing to configure for invoices** — HCP has no invoice webhook, so paid
invoices are polled through the API key you already have.

## 6. Verify the estimate-option event name (open question)

Estimate approval lives per-option. If HCP delivers that as an
`estimate_option.*` event rather than `estimate.updated`, the instant path will
not fire — the cron pass still catches it within ~15 minutes, so nothing is
lost, but you want to know which is happening.

- [ ] Approve one test estimate option in HCP
- [ ] Check Vercel logs for `/api/webhooks/housecall` and note the event name
- [ ] If it starts with `estimate_option`, report it — it is a small fix

## 7. Stand up the scheduler

Something must call `GET /api/cron/sync` every ~15 minutes with the header
`Authorization: Bearer <CRON_SECRET>`. Pick **one** path.

### Path A — GitHub Actions (free, available now)

The workflow is already committed at `.github/workflows/cron-sync.yml`.

- [ ] Repo → **Settings** → **Secrets and variables** → **Actions**
- [ ] Add secret `APP_URL` — the Vercel production URL, no trailing slash
- [ ] Add secret `CRON_SECRET` — must match Vercel's value **exactly**
- [ ] Repo → **Actions** → *Sync Housecall Pro* → **Run workflow** to test
- [ ] Confirm the log shows `HTTP 200` and a JSON body

**If this repo is private,** `*/15` costs ~2,880 Actions minutes/month against a
2,000-minute free allowance. Change the cron in the workflow to `*/30` (~1,440
min/month). The digest is unaffected — any run in the 06:00–12:00 window sends
it — and paid-invoice latency goes from ~15 to ~30 minutes.

### Path B — Vercel Pro (~$20/mo, do this later)

See [the appendix](#appendix-switching-to-vercel-pro) below. On Pro, Vercel's own
cron does the job and Path A can be deleted entirely.

## 8. Turn it on

- [ ] Confirm step 2 passed
- [ ] Watch a run or two in Vercel logs first — the detector should report zero
      or very few notifications
- [ ] Set `SLACK_ALERTS_ENABLED=true` in Vercel
- [ ] Redeploy

## 9. Confirm it works

- [ ] Trigger a run manually inside the 06:00–12:00 Eastern window and confirm
      the digest arrives in the schedule channel:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://<your-domain>/api/cron/sync
```

  Outside that window the call syncs without posting — that is correct behavior,
  not a failure.

- [ ] Mark one test invoice paid in HCP; confirm it appears in the invoices
      channel within ~15 minutes
- [ ] Approve one test estimate option; confirm it appears in the estimates
      channel (near-instantly via webhook, or within ~15 min via the cron pass)
- [ ] Confirm the next weekday 6 a.m. digest arrives on its own
- [ ] Confirm the digest footer's `last sync: N min ago` reads a few minutes,
      not hours — that line is your scheduler canary

---

## Appendix: switching to Vercel Pro

Two reasons this is worth it beyond convenience:

1. **Cron granularity.** Hobby restricts cron to once-daily schedules. Pro
   allows any expression, so Vercel itself can run every 15 minutes and the
   GitHub Actions workflow becomes redundant.
2. **Function duration.** `src/app/api/cron/sync/route.ts` declares
   `maxDuration = 300`, but **Hobby caps functions at 60 seconds**. The 20-hour
   full invoice reconcile takes ~70s, so on Hobby it is likely timing out — the
   correctness backstop that catches anything the targeted poll missed may not
   be completing. Pro raises the ceiling to what the code was written for.

**Worth verifying before you pay:** check Vercel function logs for a
`/api/cron/sync` invocation roughly 20+ hours after the previous one, and see
whether it completed or timed out.

### The change

Replace the contents of `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/sync",
      "schedule": "*/15 * * * *"
    }
  ]
}
```

Then:

- [ ] Subscribe to Vercel Pro
- [ ] Apply the `vercel.json` change above and deploy
- [ ] Confirm in Vercel → Settings → Cron Jobs that the 15-minute schedule was
      accepted (Hobby would reject it)
- [ ] Watch one 20-hour invoice reconcile complete without timing out
- [ ] Delete `.github/workflows/cron-sync.yml` and remove the `APP_URL` /
      `CRON_SECRET` repository secrets

**Do not delete the GitHub Actions workflow until Vercel's cron is confirmed
firing.** Running both briefly is harmless — the endpoint is idempotent and the
`notifications_sent` ledger prevents duplicate posts.

### Why `0 11 * * *` on Hobby, and why it changes

11:00 UTC is 06:00 EST in winter and 07:00 EDT in summer — the only hour that
lands inside the 06:00–12:00 local digest window year-round. On Hobby that makes
the single daily cron a real digest fallback. On Pro, `*/15` covers the window
many times over and the specific hour stops mattering.

---

## Known gotchas

- **GitHub disables scheduled workflows after 60 days of repo inactivity.** No
  commits for 60 days and the scheduler silently stops, taking invoice alerts and
  digests with it, with no notification. The digest's `last sync` footer is the
  canary. This gotcha disappears on Vercel Pro.
- **Scheduled runs are best-effort.** GitHub delays them 5–30+ minutes under
  load and can drop a tick. The app is built for this: any run in the
  06:00–12:00 window sends that day's digest. A 6:20 arrival is normal.
- **Canceled jobs are excluded** from both the dashboard's today-schedule and
  the digest, as of the change on 2026-07-30. This deliberately altered live
  dashboard behavior.
- **The paid-invoice count in the digest means "claimed," not "confirmed
  delivered."** A Slack outage loses that alert rather than retrying it — a
  deliberate trade-off, since duplicate money alerts are worse than a missed one.
