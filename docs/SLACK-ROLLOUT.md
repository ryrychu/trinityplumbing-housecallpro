# Slack Notification Rollout

The Slack notification code is complete and merged. Nothing is configured and
nothing is enabled. This is the runbook for turning it on — in order, on a day
you have time to watch it work, not last thing on a Friday before you leave.

**Read this in full before running anything.** The live database already
holds roughly 2,200 invoices marked `paid` and hundreds of already-approved
estimate options. Migration `supabase/migrations/0006_notifications.sql`
seeds all of that history into a dedupe ledger (`notifications_sent`) so the
notifier treats it as "already notified" instead of "brand new" — but that
migration has **not** been applied. Applying it, and verifying the seed took,
is the one gate standing between this feature and every one of those ~2,200
records landing in Slack as a fresh notification the moment alerts go live.
Do not skip Step 2.

---

## Step 1 — Apply the migration

```bash
npx supabase db push
```

Expected: `0006_notifications.sql` applies with no errors and creates the
`notifications_sent` table with its two seed inserts (paid invoices, approved
estimate options — see the migration file for exactly which rows qualify).

---

## Step 2 — Verify the seed (do not skip this)

```sql
select kind, count(*) from notifications_sent group by kind;
```

Compare the `invoice_paid` count against the live table, not against a number
written down in this doc or the migration file:

```sql
select count(*) from invoices where status = 'paid';
```

**These two counts must match exactly.** As of this writing the live count is
in the low 2,200s, but invoices keep getting paid — use whatever `select
count(*)` returns *right now*, not "around 2,200."

**If `invoice_paid` in `notifications_sent` is 0, or is far short of the
`invoices` count, STOP.** Do not proceed to Step 3. Do not set
`SLACK_ALERTS_ENABLED`. A short or empty seed means the dedupe ledger doesn't
know about the already-paid invoices, and the first live run will detect all
of them as new and post roughly 2,200 separate Slack messages (batched into
one message per cron run, but still every historical invoice, all at once).
This is the only cheap moment to catch a seeding mistake — right now, with a
`select count(*)`, before it becomes a flood in a real channel that people
have to scroll past. Once alerts are live, the only fix is deleting the bad
messages by hand.

If the counts don't match, look at why before retrying: a common cause is
seeding against a database that had invoices imported or paid *after*
`0006_notifications.sql` was written — re-run the seed inserts from the
migration file directly (they're `insert ... on conflict do nothing`, so
they're safe to re-run) rather than re-applying the whole migration.

Spot-check `estimate_approved` the same way if you want extra confidence, but
`invoice_paid` is the one with the volume that matters — a short estimate
seed produces dozens of extra messages, not thousands.

---

## Step 3 — Deploy with alerts off

Deploy normally, but **do not set `SLACK_ALERTS_ENABLED`** yet — leave it
unset in Vercel. With it unset, `slackAlertsEnabled()` in
`src/lib/slack/client.ts` returns `false`, and **every** notification pass in
`/api/cron/sync` — the targeted paid-invoice poll, the estimate-approval
safety net, and the schedule digests — checks that flag first and returns
immediately when it's off. Concretely, with alerts off:

- The paid-invoice poll never calls the Housecall Pro API for paid invoices,
  never runs detection, never claims a row in `notifications_sent`, and never
  advances the `invoices_paid` watermark in `sync_cursors`.
- The estimate-approval cron safety net never runs detection or claims
  anything either. The webhook path's own sync (writing the record to
  Supabase) is unaffected by this flag and keeps running either way, but its
  notification call goes through the exact same `slackAlertsEnabled()` gate
  inside `notifyApprovedEstimates` — so estimate approvals are just as silent
  as everything else while this flag is unset.
- No `postSlack` call happens for any of the above.

In other words, this is a **quiet no-op deploy**, not a dry run you can
observe. There is no detector output to watch in the logs at this stage —
because with alerts off, detection itself does not run, not just the Slack
post. **Do not treat an empty log as confirmation the seed is good**; it
confirms nothing here, because nothing ran.

**The seed was already verified in Step 2, and that SQL count comparison is
the only real verification point before going live** — there is no
code-level "detect but don't post" dry-run mode to fall back on here. If you
want extra confidence beyond Step 2's counts, re-run the two `select count(*)`
queries again right before Step 5 (data may have changed between when you
first checked and now) rather than looking for signal in this step's logs.

This step exists to let you deploy the code path and confirm the app still
runs normally (regular sync, dashboard, etc.) with the notifier wired in but
inert — not to re-verify the seed.

---

## Step 4 — Create the Slack webhooks

Create three separate Slack incoming webhooks (Slack app → Incoming
Webhooks → Add New Webhook to Workspace), one per destination channel:

- Job-schedule channel (digest + week-ahead)
- Paid-invoice channel
- Approved-estimate channel

Set the three URLs in Vercel (Project → Settings → Environment Variables):

```bash
vercel env add SLACK_WEBHOOK_SCHEDULE
vercel env add SLACK_WEBHOOK_INVOICES
vercel env add SLACK_WEBHOOK_ESTIMATES
```

`SLACK_ALERTS_ENABLED` should still be unset at this point. A configured
webhook URL with alerts disabled is inert — `postSlack()` is never called
because `slackAlertsEnabled()` still returns `false`.

---

## Step 5 — Flip the kill switch

```bash
vercel env add SLACK_ALERTS_ENABLED
# value: true   (exactly this string — "1", "yes", "TRUE" do not count)
```

Redeploy so the new environment variable takes effect. From here on, every
run of `/api/cron/sync` will post real notifications for genuinely new
paid invoices and approved estimates, plus the daily/weekly schedule digest
when its time window comes around (see the README's "Slack notifications"
section for the digest-timing rule).

Don't wait until tomorrow morning to find out whether the wiring works —
trigger a run by hand right now:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://<your-vercel-domain>/api/cron/sync
```

**This only produces a digest if you run it inside the 06:00–12:00 Eastern
window** (`isDailyDigestDue`/`isWeeklyLookaheadDue` in
`src/lib/notifications/schedule.ts`). Outside that window — say, you're
doing this rollout at 3pm — the call still syncs normally and returns
`{ "ok": true, ... }`, it just correctly declines to post a digest. That is
expected behavior, not a failure; don't take an empty schedule channel at
3pm as a sign anything is broken. If you want to see a digest post
immediately as a smoke test, run the curl command again between 6:00 a.m.
and 12:00 p.m. Eastern on a weekday (Monday if you also want to see the
week-ahead message). Paid-invoice and approved-estimate alerts, by contrast,
post any time there's genuinely new data, regardless of the hour — those you
can confirm right now if you have a live one to trigger.

Once you do land a run inside the window (whether by hand or via the
`0 11 * * *` `vercel.json` cron — see the README for why that specific UTC
hour was chosen), confirm the digest arrives in the schedule channel and
check its `last sync: N min ago` footer; a large number there is your first
sign the external scheduler (Step 6) isn't running yet or has stalled.

---

## Step 6 — Stand up the external scheduler last

Only do this once Steps 1–5 are done and the notifier has proven itself
quiet and correct. Something external — Vercel Cron on a paid plan, GitHub
Actions on a schedule, a third-party pinger, whatever you already use for
this kind of thing — needs to call:

```
GET https://<your-vercel-domain>/api/cron/sync
Authorization: Bearer <CRON_SECRET>
```

roughly every 15 minutes. This is genuinely load-bearing, not a nice-to-have:

- The digest window check in `src/lib/notifications/schedule.ts` only fires
  on whatever run happens to land inside 06:00–12:00 local time. A cron
  expression can't target "6am Eastern" year-round (DST makes the UTC
  equivalent drift), so the app checks the local clock on every invocation
  instead — which only works if invocations happen often enough that one
  reliably falls in the window.
- Paid invoices have **no Housecall Pro webhook**. `notifyPaidInvoices`
  (`src/lib/notifications/dispatch.ts`) only ever runs as part of this
  polling route. If the external scheduler dies silently, paid-invoice
  alerts stop with it, invisibly.
- Estimate approvals arrive by webhook and post independently of this
  poller, so the near-instant path keeps working even if the scheduler goes
  down. This cron route also re-checks the estimate records its own
  incremental sync just touched, as a safety net for a webhook delivery HCP
  never retries (signature mismatch, rotated secret, deploy window) — that
  safety net, unlike the instant webhook path, does depend on the scheduler
  running.

The `vercel.json` cron (`0 11 * * *`, once daily) stays in place as a safety
net — it is not, and was never meant to be, the primary scheduler. It exists
because Vercel's Hobby plan caps cron at once a day; 11:00 UTC is chosen
specifically because it's the only hour that lands inside the 06:00–12:00
`America/New_York` digest window in both DST regimes (06:00 EST in winter,
07:00 EDT in summer), so this safety net can actually produce a digest and
not just a silent sync. It guarantees the sync (and a real chance at the
digest) runs at least once even if the external scheduler is down, but on
Hobby it cannot deliver 15-minute paid-invoice timeliness on its own.

---

## Rollback

Setting `SLACK_ALERTS_ENABLED` to anything other than the exact string
`true` (or deleting the variable) immediately silences all Slack output on
the next deploy/redeploy — no code change and no database change required.
The dedupe ledger (`notifications_sent`) is unaffected either way, so
disabling and re-enabling later does not risk re-notifying anything already
claimed.
