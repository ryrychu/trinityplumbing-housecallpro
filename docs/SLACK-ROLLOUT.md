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
- **Usage hint:** `today | tomorrow | week | next week | thursday | money | declined | traffic preview`

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

## Dave's Fieldy checklist — Slack, ChatGPT and `/trinity fieldy preview`

Each morning between 7 and 11 (Eastern) the bot posts Dave's open Fieldy tasks
as one grouped checklist in a private channel. Ticking a box in Slack, or
telling ChatGPT "done with X" through the **Trinity Tasks** connector, marks the
task completed in Fieldy too. ChatGPT can also rebuild the checklist and add
tasks. Grouping uses the OpenAI API; if that fails the post still goes out,
grouped by date. Spec: `docs/superpowers/specs/2026-11-21-fieldy-checklist-design.md`.

### Go-live (Ryan)

Order matters: the migration goes in **before** the merge, and steps 2 and 3
are done before the first morning after the deploy.

0. **Test Dave's key first** (works with the code before this branch too):
   - **The key:** Dave creates it in the Fieldy app → Settings → Developer
     Settings. It starts with `sk-fieldy-`. He sends it to you privately, never
     in Slack.
   - **The channel:** create a **private** channel, type
     `/invite @<the Trinity bot>` in it, then copy the channel ID from the
     channel name → About (it starts with `C`).
   - Vercel → Production → set `FIELDY_API_KEY`, `SLACK_FIELDY_CHANNEL_ID`,
     `SLACK_FIELDY_ENABLED=true`; redeploy; `/trinity fieldy preview` should
     list his real tasks.

   > **Warning:** on the code before this branch, `SLACK_FIELDY_ENABLED=true`
   > (with `SLACK_ALERTS_ENABLED` on) also turns on the old raw 7am Fieldy
   > post. Either accept that for a day, or do step 0 right after merging.
1. Run `supabase/migrations/0008_task_checklists.sql` in the ops Supabase SQL
   editor, **then** merge. The migration only adds tables and functions, so the
   old code doesn't notice it, and running it first avoids
   `relation does not exist` errors every 15 minutes after the deploy.
2. Vercel → Production:
   - `OPENAI_API_KEY` — from platform.openai.com (billed separately from ChatGPT Business)
   - `OPENAI_MODEL` — optional; default `gpt-6-luna`
   - `MCP_TASKS_ENABLED=true`
   - `MCP_TASKS_OWNER_USER_ID` — Dave's user id (Supabase → Authentication → Users)
   - `SLACK_FIELDY_ALLOWED_USERS` — Dave's Slack member id (profile → ⋮ → Copy member ID)
   - confirm `SLACK_SIGNING_SECRET` is set (the `/trinity` command already uses it)

   Redeploy.
3. Slack app → **Interactivity & Shortcuts** → On → Request URL
   `https://ops.trinity.plumbing/api/slack/interact` → Save.
4. ChatGPT (Trinity workspace) → Plugins → Add custom MCP server: name
   `Trinity Tasks`, URL `https://ops.trinity.plumbing/api/mcp/tasks`, OAuth.
   Publish to the workspace; Dave connects with his ops login.
5. With Dave: "organize my Fieldy tasks" → a checklist appears in the channel;
   tick one box in Slack and say "done with …" in ChatGPT for another → both
   show completed in the Fieldy app; "add: call the Navien rep" → appears in
   Fieldy and under **Added**. A tap by anyone else snaps back with "Only Dave
   can check these off." Next morning: one post, not two.

### Kill switches

- `SLACK_FIELDY_ENABLED` covers the morning post, `/trinity fieldy preview`
  and Slack taps.
- ChatGPT posting and changes go through the connector, controlled by
  `MCP_TASKS_ENABLED`.
- The 15-minute sync (ticks made in the Fieldy app, re-posting a message that
  didn't update) only runs while `SLACK_ALERTS_ENABLED` is on, as well as
  `SLACK_FIELDY_ENABLED`.

### If something's off

| What you see | Cause |
|---|---|
| Preview says Fieldy isn't set up | `FIELDY_API_KEY` missing or not redeployed |
| No morning post | `SLACK_FIELDY_ENABLED` not exactly `true`, `SLACK_ALERTS_ENABLED` off, bot not in the channel, or a checklist already exists today |
| Footer says "AI grouping didn't run" | `OPENAI_API_KEY` missing or OpenAI failed; logs show `[tasks] AI grouping skipped: <code>` |
| Tapping a box does nothing | Interactivity URL not saved, or `SLACK_SIGNING_SECRET` missing |
| "Only Dave can check these off." for Dave | His member id isn't in `SLACK_FIELDY_ALLOWED_USERS` |
| ChatGPT says "only available to Dave's login" for Dave | `MCP_TASKS_OWNER_USER_ID` isn't his Supabase user id |

### Rollback

Set `SLACK_FIELDY_ENABLED` and `MCP_TASKS_ENABLED` to anything but `true` and
redeploy. Nothing in Fieldy is deleted by this feature, ever. Checklist
messages already posted stay in the channel; taps on them do nothing while
`SLACK_FIELDY_ENABLED` is off.

---

## Website traffic — Monday post, `/trinity traffic preview` and ChatGPT

Every Monday morning the bot posts last week's website numbers (Mon–Sun,
Eastern) to a channel of its own, from Google Analytics 4: visitors and visits
on each site with the change from the week before, the top 3 places visitors
came from, and the calls, booking clicks, form requests and email clicks each
site brought in. Totals across all sites come first, then one short section
per site, busiest first. A site Google can't read shows as one line saying why,
and the rest still post. For example, built from the test fixtures:

> **Website traffic: Nov 16–22**
> **All sites: 760 visitors** (up 4%) · 961 visits
> 📞 Calls from the site: **13** (same as the week before)
> 📅 Booking clicks: **4** (up 33%)
> 📝 Form requests: **2** (none the week before)
> ✉️ Email clicks: **1** (none the week before)
> ———
> **Trinity Plumbing**
> 620 visitors (up 8%) · 790 visits
> From: Google search 410 · Typed in or bookmarked 220 · Maps 80
> Calls from the site 9 · Booking clicks 3 · Form requests 2 · Email clicks 1
>
> **Albany Rooter**
> 140 visitors (down 13%) · 171 visits
> From: Google Ads 90 · Google search 60 · Typed in or bookmarked 21
> Calls from the site 4 · Booking clicks 1 · Form requests 0 · Email clicks 0
>
> **Troy Water Heaters**
> _Couldn't get this site's numbers from Google: no access. In GA4 Admin, add the service account as a Viewer on this property._
>
> Mon–Sun, Eastern time. Changes compare with Nov 9–15. A person who visits two sites counts once on each. 1 site couldn't be read. From Google Analytics.

What the words mean, against GA's own names: **visitors** are GA4 *active
users* (what GA's home page calls Users), **visits** are *sessions*, the
**places visitors came from** are GA's *default channel group* (Organic Search
shows as "Google search", Direct as "Typed in or bookmarked", Paid Search as
"Google Ads", Organic Maps as "Maps", Referral as "Other websites"), and the four
counts are the sites' `phone_click`, `booking_click`, `generate_lead` (form
requests) and `email_click` events. The all-sites total adds the sites together,
so someone who visited two sites counts on each.

**When it posts:** the first `/api/cron/sync` run on Monday between 9am and noon
Eastern, once (`analytics_weekly` in `notifications_sent`, keyed by the reported
week's Monday, e.g. `2026-11-16`). That's three hours later than the other
Monday posts to give Google longer to finish processing Sunday. No new Vercel
cron and no migration: `notifications_sent` takes any `kind`. Each run in the
window first checks the ledger and skips Google once the week is posted. If
Google can't be reached at all (no token, or every site fails) nothing is
claimed or posted and the next 15-minute run tries again; if some sites fail,
the post goes out with those sites marked. Nothing from Google is stored.

**Preview any time:** `/trinity traffic preview` shows the post for the last full
week to the person who typed it only. It works as soon as the two GA variables
are set, before the weekly post is switched on. No post, no claim, no writes.

**ChatGPT:** the **Trinity Jobs** connector gains a read-only `get_site_traffic`
tool ("how did the websites do last week?", "Albany Rooter traffic 3 weeks
ago"). It takes `weeks_ago` (0 is the last full week, up to 12) and an optional
`site` (any part of the name) and returns the same numbers as the post. Until
the GA variables are set it answers that analytics isn't set up yet. It's
behind `MCP_JOBS_ENABLED` like the connector's other tools, and needs nothing
else switched on.

### Go-live (Ryan)

Nothing here costs money: the Google Analytics Data API is free at this volume
(three small reports per site per week, plus whatever ChatGPT asks).

1. **Create a Google Cloud project.** console.cloud.google.com → project picker
   → **New project**, e.g. `trinity-analytics`. Use the Google account that
   manages Trinity's GA4 properties.
2. **Enable the Google Analytics Data API.** In that project: **APIs & Services
   → Library**, search "Google Analytics Data API", **Enable**. (Not the
   "Google Analytics API" or the Admin API.)
3. **Create a service account and a JSON key.** **IAM & Admin → Service
   Accounts → Create service account**, e.g. `ga-reader`. Skip the optional
   project roles; it needs none. Open it → **Keys → Add key → Create new key →
   JSON**. A `.json` file downloads. Treat it as a password: don't email it or
   put it in Slack, and delete the file once it's in Vercel. Copy the
   service account's email (`ga-reader@<project>.iam.gserviceaccount.com`).
4. **In GA4, add the service account as a Viewer on each property.**
   analytics.google.com → **Admin** (gear) → pick the property → **Property
   access management** → **+** → **Add users** → paste the service account
   email → role **Viewer** → untick "Notify new users" → **Add**. Repeat for
   every site's property. (Adding it once at the account level covers every
   property under that account.)
5. **Find each property ID.** **Admin → Property details** (or Property
   settings): the **Property ID** is a number like `123456789`. It is *not* the
   `G-XXXXXXX` Measurement ID the sites' tags use. While you're there, check
   the **Reporting time zone** is Eastern; the weeks are counted in it.
6. **Set the Vercel variables** (Production):
   ```bash
   vercel env add GA_SERVICE_ACCOUNT_JSON     # paste the whole key file (or base64 of it)
   vercel env add GA_PROPERTIES               # Trinity Plumbing=123456789,Albany Rooter=987654321,...
   vercel env add SLACK_ANALYTICS_CHANNEL_ID  # the C… id of the traffic channel
   ```
   For the channel: create it (e.g. #website-traffic), add Dave, type
   `/invite @<app name>` in it, then copy the ID from the channel name → About
   (it starts with `C`). It uses the existing `SLACK_BOT_TOKEN`; no new scopes,
   `chat:write` covers it. If pasting multi-line JSON is awkward, base64 the file
   (`base64 -w0 key.json` on Linux, `[Convert]::ToBase64String([IO.File]::ReadAllBytes("key.json"))`
   in PowerShell) and paste that. Site names can't contain commas; they're how
   the sites appear in Slack and ChatGPT.
7. **Redeploy** so the variables take effect.
8. **Check:** `/trinity traffic preview`. Each site should show numbers that
   match GA4 → Reports → Acquisition → Traffic acquisition for the same dates
   (Users there is "visitors" here). A site that says "no access" needs step 4;
   "property not found" needs its ID checked in step 5. "Website traffic isn't
   set up yet" names the variable that's missing or malformed.
9. **Switch on the Monday post** and redeploy:
   ```bash
   vercel env add ANALYTICS_WEEKLY_ENABLED    # value: true (exactly this string)
   ```
   It also needs `SLACK_ALERTS_ENABLED=true`, like the other scheduled posts
   (already on). The first post goes out the next Monday between 9am and noon
   Eastern.
10. **ChatGPT (workspace admin):** Plugins → **Trinity Jobs** → **Refresh**.
    ChatGPT doesn't pick up the new `get_site_traffic` tool until someone does.
    Then ask "how did the websites do last week?" and compare with the preview.

A site added later: give the service account Viewer on its property (step 4),
add `Name=propertyId` to `GA_PROPERTIES`, redeploy.

### Kill switches

- `ANALYTICS_WEEKLY_ENABLED` covers the Monday post only. Off, the cron makes
  no Google call and posts nothing.
- `/trinity traffic preview` and `get_site_traffic` need only
  `GA_SERVICE_ACCOUNT_JSON` and `GA_PROPERTIES` (plus `SLACK_COMMANDS_ENABLED`
  and `MCP_JOBS_ENABLED`, which already gate those surfaces). Remove either GA
  variable and both say analytics isn't set up, without calling Google.

### If something's off

| What you see | Cause |
|---|---|
| "Website traffic isn't set up yet: …" | The named variable is missing or malformed, or not redeployed |
| "Couldn't sign in to Google Analytics: invalid_grant" | The key was deleted in Google Cloud, or the JSON is from another account. Make a new key (step 3) |
| A site says "no access" | The service account isn't a Viewer on that property (step 4) |
| A site says "property not found" | Wrong number in `GA_PROPERTIES`, or a `G-` Measurement ID (step 5) |
| No Monday post | `ANALYTICS_WEEKLY_ENABLED` not exactly `true`, `SLACK_ALERTS_ENABLED` off, `SLACK_ANALYTICS_CHANNEL_ID` unset, bot not in the channel, or Google unreachable all morning. Logs show `[analytics] weekly post skipped: <reason>` or `[cron] website traffic pass failed` |
| Numbers a little lower than GA shows later | GA can take a day or two to finish processing; Monday's post reads Sunday early |
| ChatGPT doesn't know about traffic | Click Refresh on the Trinity Jobs plugin (step 10) |

### Rollback

Set `ANALYTICS_WEEKLY_ENABLED` to anything but `true` and redeploy to stop the
post. Remove `GA_SERVICE_ACCOUNT_JSON` to stop every Google call, and disable or
delete the key in Google Cloud to revoke access entirely. Posts already in the
channel stay.
