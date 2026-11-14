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
and 12:00 p.m. Eastern on any day (Monday if you also want to see the
week-ahead message) — or use the `/admin` page described below, which sends
one at any hour. Paid-invoice and approved-estimate alerts, by contrast,
post any time there's genuinely new data, regardless of the hour — those you
can confirm right now if you have a live one to trigger.

Once you do land a run inside the window (whether by hand or via the
`0 11 * * *` `vercel.json` cron — see the README for why that specific UTC
hour was chosen), confirm the digest arrives in the schedule channel. The
digest carries no sync-age footer, so to check the scheduler itself go to
Vercel → Logs and filter on `requestPath:/api/cron/sync`; runs should appear
every 15 minutes.

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

## Sending a digest by hand — the `/admin` page

The schedule digests only send between 06:00 and 12:00 Eastern. Outside that
window there is no supported way to make one appear — and there is no way to
do it from a laptop either, because every secret in this project is a Vercel
**Sensitive** environment variable. Sensitive values are write-only: `vercel
env pull` returns the literal string `[SENSITIVE]`, and neither the dashboard
nor the CLI will ever hand back the real value. That makes
`scripts/preview-digest.mts` useless against production, and Vercel has no
"run this cron now" button either.

`/admin` closes that gap. It has a **Preview** button (renders the message,
sends nothing) and a **Send to Slack** button for each digest.

Set the token first. Generate one — 256 bits, `base64url` so no `+`, `/` or
`=` survives to be mangled by a shell or an `.env` line:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then paste it in, and **keep a copy**: `vercel env add` marks values Sensitive
by default, and this is the one variable you have to be able to read back in
order to type it into the page. Lose it and the only fix is removing the
variable and adding a new one.

```bash
vercel env add ADMIN_TRIGGER_TOKEN
```

Then redeploy and open `https://<your-domain>/admin`.

**Understand what this page is before you deploy it.** `/dashboard` and
`/admin` now sit behind the Supabase login gate (`src/middleware.ts`), but
signing in only proves you're one of the app's users — it says nothing about
who should be allowed to fire a message into Slack. `ADMIN_TRIGGER_TOKEN` is
still the *only* thing standing between a signed-in account and your Slack
channels; being logged in does not make the token optional. Use a long random
string, not a word. If you'd rather add another layer, Vercel's Deployment
Protection puts the whole site behind your team's login; it needs a bypass
configured for the Housecall Pro webhook path, which is why it isn't turned on
here by default.

Two behaviors worth knowing:

- **Preview is the default.** The API only posts when explicitly asked, so a
  malformed request can't surprise a channel.
- **Sending by hand never consumes the day's digest.** The page deliberately
  skips the `claim()` ledger, so using it at 5 a.m. does not suppress the real
  6 a.m. digest. The trade-off is that sending inside the window can produce
  two messages.

The same thing is available without a browser, using `CRON_SECRET` — useful
from a script, if you happen to know that value:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
  "https://<your-domain>/api/cron/sync?force=digest"   # or force=week
```

---

## Slash commands — `/trinity`

Separate from the notifications above and independently switchable. These read
the same Supabase mirror the digests do and post nothing on their own — they
only answer when someone types.

### Step A — Create the command

In the same Slack app: **Slash Commands → Create New Command**.

- **Command:** `/trinity`
- **Request URL:** `https://<your-vercel-domain>/api/slack/command`
- **Short description:** `Schedule and money, on demand`
- **Usage hint:** `today | tomorrow | week | next week | thursday | money | declined`

Reinstall the app to the workspace if Slack asks.

### Step B — Set the signing secret

**Basic Information → App Credentials → Signing Secret**, then:

```bash
vercel env add SLACK_SIGNING_SECRET
```

This is the only thing authenticating the command route — `/api/slack/*` sits
outside the app's login gate, because a slash command arrives from Slack's
servers with no session cookie. Treat it like the password it is.

### Step C — Flip the switch

```bash
vercel env add SLACK_COMMANDS_ENABLED   # value: true (exactly this string)
```

Redeploy, then type `/trinity today` and compare against `/dashboard`, and
`/trinity week` against the Monday digest. They are rendered by the same code
and should agree exactly.

### What it costs

Nothing per use. There is no AI in this path and no Anthropic API key — the
commands are a fixed vocabulary rendered from Supabase. Why it works that way,
and what was ruled out, is in
`docs/superpowers/specs/2026-08-08-slack-commands-mcp-design.md`.

### Who can use it

Anyone in the workspace. This was a deliberate decision, taken knowing the
replies carry customer names, street addresses and phone numbers. Replies are
**ephemeral** (only the person who typed the command sees them, and nothing is
left in channel history) and everything is read-only, so the exposure is
disclosure rather than damage. To restrict it later, add a `user_id` allowlist
check in `src/app/api/slack/command/route.ts`, after the form body is parsed
with `URLSearchParams` — that is where `user_id` is actually available.
`renderCommand` in `src/lib/slack/commands.ts` only receives `(cmd, now)` and
never sees who asked.

### Rollback

Set `SLACK_COMMANDS_ENABLED` to anything other than `true` (or delete it) and
redeploy. The command then replies "not enabled" and touches no data. The
notification settings above are unaffected either way.

---

## Rollback

Setting `SLACK_ALERTS_ENABLED` to anything other than the exact string
`true` (or deleting the variable) immediately silences all Slack output on
the next deploy/redeploy — no code change and no database change required.
The dedupe ledger (`notifications_sent`) is unaffected either way, so
disabling and re-enabling later does not risk re-notifying anything already
claimed.

---

## Declined calls — #declined-calls and `/trinity declined`

When Trinity turns a call down (crew too busy, or a contract customer too far
away), Ellah forwards the original message from #calls into #declined-calls.
The bot counts those forwards. Every Monday morning it posts last week's calls
in #declined-calls, one line each (like the estimates channel), then the total
against the 15-a-week hiring line, the 4-week average and the month so far:

> **5 calls declined last week (Nov 2–8)**
> • Sandra Sample, Rensselaer: sump pump stopped, pit nearly overflowing
> • Patty, Hillsdale: barn plumbing before winter (called twice)
> • Logged with /trinity: distance — Saratoga contract
> • (518) 555-0167: no details
> • Jordan Example: Water heater leaking in the basement
> Under 15 for the week (10 short). 4-week average: 1.3 a week. November so far: 5.

Each line is picked out of the forwarded message: the name (a short Title Case
line), the town (from an address like "12 Main St, Rensselaer, NY 12144") and
the first sentence of the note, minus @mentions and "Cx called because". It
never guesses: no address means no town, no name means the phone number, and
nothing usable means "(no details)". A repeat caller shows once with "(called
twice)". The list stops at 25 with "… and N more". Customer details in this
post are fine by Dave; it goes only to #declined-calls.

**What counts:** one forwarded (or shared) message posted in #declined-calls is
one declined call, timed by when it was forwarded, Mon–Sun Eastern. Typed
messages don't count: Ellah's own weekly line, Dave's replies, the bot's post,
joins and leaves, and anything inside a thread. If the same phone number is
forwarded twice in a week it counts once.

**Nothing is stored from the channel.** The bot reads the last five weeks of
#declined-calls when it needs them, builds the count and the Monday lines in
memory, and keeps nothing: no text, names, addresses or numbers, in the
database or in logs. A phone number is only turned into a salted hash in memory
to spot repeats.

`/trinity declined busy|distance` still works as a backup (see the usage text
in Slack). Those entries are stored in `declined_calls`, added to the forwards,
and a number logged both ways counts once. They are the only ones with a
busy/distance reason; forwards are just "declined".

**Preview it any time:** `/trinity declined preview` shows the Monday post for
this week so far (Monday to now), headed "Preview: … this week so far", to the
person who typed it only. It doesn't post to the channel, doesn't use up the
week's Monday post and doesn't write anything. If the channel can't be read it
ends with the same error line as `/trinity declined week`.

### Monthly summary — its own channel

On the morning of the 1st the bot posts last calendar month (midnight to
midnight Eastern) to a separate channel, so Dave can see the month at a glance
without scrolling #declined-calls. Same counting and same lines as the Monday
post (forwards plus `/trinity` entries, a repeat caller once per Mon–Sun week,
25 lines then "… and N more"), then the change from the month before and the
calls a week, to read against the 15-a-week line:

> **23 calls declined last month (October 2026)**
> • Sandra Sample, Rensselaer: sump pump stopped, pit nearly overflowing
> • Patty, Hillsdale: barn plumbing before winter (called twice)
> • Logged with /trinity: distance — Saratoga contract
> • …
> Up 4 from September (19). About 5.2 a week.

It runs inside the same `/api/cron/sync` run as the Monday post (same
`CRON_SECRET`, no new Vercel cron): any run on the 1st between 6am and noon
Eastern posts it, once (`declined_monthly` in `notifications_sent`, keyed by
the reported month, e.g. `2026-10`). DST is handled the same way as the
digests, by checking Eastern time in code. Same switches as the Monday post:
`SLACK_DECLINED_ENABLED=true` and `SLACK_ALERTS_ENABLED=true`. It reads two
months of #declined-calls, keeps nothing, and on a Slack or database error
posts nothing and retries on the next run. Until
`SLACK_DECLINED_MONTHLY_CHANNEL_ID` is set it is skipped (logged as a warning:
`monthly_channel_not_set`) and nothing is claimed.

**Preview:** `/trinity declined preview month` shows this month so far (the 1st
to now) against last month in full, to the person who typed it only. No post,
no claim, no writes.

**Go-live (Ryan).** The bot token and #declined-calls setup above must already
work. No new scopes: `chat:write` covers it.

1. In Slack, create the channel (for example #declined-monthly) and add Dave.
2. In that channel, type `/invite @<app name>`. The bot can't post where it
   isn't a member.
3. Get its channel ID: click the channel name; the ID (`C…`) is at the bottom
   of the About tab.
4. Set it in Vercel (Production), then redeploy:
   ```bash
   vercel env add SLACK_DECLINED_MONTHLY_CHANNEL_ID  # the C… id
   ```
5. Check: `/trinity declined preview month`. The first real post goes out on
   the next 1st, between 6am and noon Eastern.

To stop only the monthly post, remove `SLACK_DECLINED_MONTHLY_CHANNEL_ID` and
redeploy; the Monday post and `/trinity declined` carry on.

### Ellah changes nothing

Keep forwarding declined calls to #declined-calls exactly as now. The weekly
line is optional once the bot posts; nothing breaks if she keeps writing it.

### Go-live (Ryan)

The `declined_calls` table (migration 0007), `DECLINED_PHONE_SALT` and
`SLACK_DECLINED_ENABLED=true` are already live. This adds a bot token.

1. **api.slack.com/apps → the Trinity app → OAuth & Permissions → Scopes → Bot
   Token Scopes**, add:
   - `channels:history` (read #declined-calls)
   - `groups:history`, only if #declined-calls is a private channel
   - `chat:write` (post the Monday summary)
2. **Reinstall to Workspace** (banner at the top of that page). Slack may need a
   workspace admin to approve the new scopes.
3. Still on **OAuth & Permissions**, copy the **Bot User OAuth Token**
   (`xoxb-…`). Treat it as a password.
4. In Slack, in #declined-calls, type `/invite @<app name>`. The bot can't read
   or post in a channel it isn't in.
5. Get the channel ID: click the channel name at the top of #declined-calls; the
   ID (`C…`) is at the bottom of the About tab.
6. Set both in Vercel (Production), then redeploy:
   ```bash
   vercel env add SLACK_BOT_TOKEN            # the xoxb- token
   vercel env add SLACK_DECLINED_CHANNEL_ID  # the C… id
   ```
7. Check: `/trinity declined week` should show this week's forwards, and
   `/trinity declined preview` how Monday's post will look. If it
   can't read the channel, the reply (only you see it) ends with Slack's error
   code and the fix, for example:
   - `token_not_set` / `channel_not_set`: the Vercel variable is missing (step 6).
   - `token_not_bot`: that's not the `xoxb-` Bot User OAuth Token (step 3).
   - `not_in_channel`: invite the bot (step 4).
   - `missing_scope (needs groups:history)`: add that scope and reinstall (steps 1–2).
   - `invalid_auth` / `token_revoked`: copy the current token again (step 3).
   - `channel_not_found`: wrong channel ID, or a private channel the bot can't see (steps 4–5).

The first summary posts the next Monday between 6am and noon Eastern, once
(`declined_weekly` in `notifications_sent`). It needs `SLACK_ALERTS_ENABLED=true`
as well, like the other scheduled posts. If Slack or the database can't be read
it posts nothing and tries again on the next 15-minute run; it never posts a
partial count. Until the token and channel ID are set, the Monday post is
skipped (logged as a warning) and nothing is claimed.

**Rate limits:** this is an internal app installed only in Trinity's
workspace, so `conversations.history` keeps its normal limit (Tier 3, 50+
requests a minute). Slack's 2025 limit of 1 request a minute and 15 messages
applies only to commercially distributed apps outside the Marketplace
(https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps).
A report reads a few pages at most.

**Rollback:** set `SLACK_DECLINED_ENABLED` to anything but `true` and
redeploy. Removing `SLACK_BOT_TOKEN` alone stops the channel count and the
Monday post but leaves `/trinity declined` working on its own entries.

---

## Dave's Fieldy tasks — morning post and `/trinity fieldy preview`

Fieldy (Dave's recording pendant) turns his conversations into tasks. Every
morning between 7 and 11 Eastern the bot posts them to one channel: the open
ones, oldest first, and the ones he marked done yesterday:

> **Dave's Fieldy tasks, Sat Nov 14**
> **Pending: 3**, oldest first
> • Call back about the boiler (12 days)
> • Order PRV valve (3 days)
> • Quote for the bathroom (due Nov 20)
> **Completed yesterday (Fri Nov 13): 1**
> • Return Ferguson parts
> _A task only shows as completed here once Dave marks it done in Fieldy._

- **Pending** = Fieldy status `new` (not reviewed yet) or `approved`. Rejected,
  skipped, cancelled and expired tasks are not shown.
- **Completed** = status `completed` with a completion time between midnight
  and midnight Eastern yesterday. A task ticked off at 8am today, after the
  post, shows tomorrow; nothing is listed twice.
- **Age** counts calendar days from the task's Fieldy `date`. The API has no
  "created" time and documents `date` as the due date, so a future date shows
  as "due Nov 20" and a task with no date shows no age. If real tasks show this
  is the wrong field, it's one line: `taskAgeAnchor()` in
  `src/lib/fieldy/report.ts`.
- 25 tasks per section at most, then "… and N more". A day with nothing open
  and nothing done says so in one line.
- **Done means tapped done in Fieldy.** Everything else stays pending. No AI
  guesses what got done.

**Nothing is stored.** The bot reads Fieldy (three GETs, by status) when it
posts or previews, and keeps nothing: no task text in the database or logs.
Task titles can hold customer names and addresses, so pick a channel only
Dave and the office can read. `/trinity fieldy preview` shows the same text to
whoever types it (ephemeral, like every `/trinity` reply).

**Once a day:** `fieldy_daily` in `notifications_sent`, keyed by the Eastern
date. No migration. If Fieldy can't be reached it posts nothing and tries
again on the next 15-minute run, until 11am.

### Go-live (Ryan)

1. **Dave makes an API key:** Fieldy app → Settings → Developer Settings. It
   starts `sk-fieldy-` and is shown once. Check with Fieldy (hey@fieldy.ai)
   whether his plan includes the Public API if the key is refused.
2. Pick or create the channel (private is best). Type `/invite @<app name>`
   there, then copy its ID (`C…`) from the bottom of the About tab.
3. The bot token (`SLACK_BOT_TOKEN`) and its `chat:write` scope are already set
   up for #declined-calls; nothing changes in the Slack app. If the channel is
   private, the bot only needs to be invited.
4. Set in Vercel (Production), then redeploy:
   ```bash
   vercel env add FIELDY_API_KEY           # sk-fieldy-…
   vercel env add SLACK_FIELDY_CHANNEL_ID  # C…
   vercel env add SLACK_FIELDY_ENABLED     # true
   ```
5. Check: `/trinity fieldy preview` shows this morning's post, only to you. If
   Fieldy fails, the reply names the HTTP status and the fix (`http_401`: the
   key was refused; `key_not_set`: step 4).

The first post goes out the next morning between 7 and 11. It also needs
`SLACK_ALERTS_ENABLED=true`, like the other scheduled posts. With the switch on
but the key, token or channel ID missing, each run in the window logs
`[fieldy] daily post skipped: … is not set` and does nothing else.

**Fieldy API** (checked 2026-11-14, https://api.fieldy.ai/docs): base
`https://api.fieldy.ai/api/public/v2`, `Authorization: Bearer sk-fieldy-…`,
`GET /tasks?status=…` (one status per call) returning `{ items: [...] }`,
100 requests a minute per key. `/tasks` documents no date filter and no
paging; if Fieldy adds paging the client follows `nextCursor` (the convention
of its other list endpoints), up to 10 pages.

**Rollback:** set `SLACK_FIELDY_ENABLED` to anything but `true` and redeploy.
Removing `FIELDY_API_KEY` alone also stops it (with a warning each morning).
