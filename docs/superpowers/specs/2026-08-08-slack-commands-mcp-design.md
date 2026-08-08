# Slack Schedule Commands + Trinity MCP Connector — Design

**Date:** 2026-08-08
**Status:** Part A approved, ready for implementation planning.
**Part B (MCP connector) is deferred** — the implementation gate below was run
on 2026-08-08 and did not pass. See "Gate result".
**Depends on:** Phase 1 foundation (HCP → Supabase sync, live), the dashboard
query layer (`src/lib/dashboard/queries.ts`), and the Slack notification layer
(`src/lib/slack/`, `src/lib/notifications/`)

## Goal

Let Dave ask **"what's my schedule for this week"** and get the week back —
without adding a per-question bill.

The request started as "make our Slack an AI chatbot." Investigation found that
a chatbot in Slack costs money on every question, in every available form. This
design delivers the same outcome through two pieces that cost nothing per use:

1. **Slack slash commands** — `/trinity week`, `/trinity today`, `/trinity money`.
   Instant, free, no AI. Answers the literal question, where the digests
   already live.
2. **A Trinity MCP connector** — a read-only remote MCP server that Dave adds
   to his existing Claude Pro account, giving him a genuinely conversational
   assistant over the same data, covered by the subscription he already pays for.

Both halves wrap the **same** existing query functions. There is one source of
truth; the two front doors cannot disagree with each other or with the
dashboard.

## Decisions

Settled during brainstorming; recorded so they are not relitigated.

| Decision | Choice |
|---|---|
| Read vs write | **Read-only.** No writes to Housecall Pro anywhere in this design |
| Scope of questions | Schedule, customers, money, dispatch — all four |
| Whose schedule | **The whole company's.** "My" means "ours"; no Slack-user → technician mapping |
| Who may use Slack commands | Anyone in the workspace (owner's explicit decision — see Accepted risk) |
| Interaction in Slack | **Slash commands only.** No @mention, no DM, no bot user |
| Conversational AI | Lives in Claude via MCP, **not** in Slack |
| Anthropic API | **Not used.** No `ANTHROPIC_API_KEY`, no per-question billing |
| Response visibility | Ephemeral by default — only the person who typed it sees customer data |

## Why there is no chatbot in Slack

This is the finding that reshaped the design. Recorded so it is not rediscovered
the hard way.

**A Claude Pro or Max subscription does not cover Anthropic API usage.** Pro
covers claude.ai and Claude Code. A Slack bot running on Vercel would call
`api.anthropic.com` with an API key billed separately, pay-per-token. At roughly
20 questions a day that is ~$8/month on Haiku 4.5, ~$16 on Sonnet 5, ~$40 on
Opus 5.

**Claude in Slack (Claude Tag) is not a way around that.** It is available on
**Team and Enterprise plans only** — explicitly not Free, Pro, or Max — and
channel work "is billed by usage… it draws from a **usage balance**, an amount
in your organization's billing currency that an Owner funds." So it would mean a
plan upgrade *and* per-question usage on top: strictly more expensive than the
API bot, not less.

**Custom MCP connectors are the free path.** They are available on Free, Pro,
Max, Team and Enterprise. Dave connects Trinity's server to his own Claude
account and asks whatever he likes, under his existing subscription's usage
limits, with no incremental charge. The trade-off — and it is a real one — is
that the conversation happens **in Claude, not in Slack**.

Sources: [Claude Tag overview](https://claude.com/docs/claude-tag/overview) ·
[Remote MCP custom connectors](https://claude.com/docs/connectors/custom/remote-mcp)

## Constraints (verified against the live docs and this codebase, not assumed)

Each is load-bearing.

- **Slack requires a `200` within 3 seconds.** `getScheduleDays()`
  (`src/lib/dashboard/queries.ts:412`) pages **every** job, customer and
  technician row before filtering in memory — against ~3,038 jobs. That is not
  reliably a sub-3-second operation. Every Slack route must acknowledge first
  and answer second.
- **Slack slash commands POST `application/x-www-form-urlencoded`, not JSON.**
  The signature is computed over the **raw** body. Reading with `req.json()` (or
  `req.formData()`) and re-serializing changes the bytes and makes every
  signature fail, with no useful error message.
- **Slack retries on non-2xx or timeout**, resending with an
  `X-Slack-Retry-Num` header. Unhandled, Dave gets the same schedule three times.
- **MCP transport is Streamable HTTP.** The legacy HTTP+SSE transport is being
  deprecated. Claude.ai's timeout is 300 seconds and its tool-result cap is
  ~150,000 characters — both far beyond anything these tools produce.
- **Fixed-credential MCP auth (`static_headers`) is in beta.** The docs state it
  is "being slowly rolled out to customers; contact Anthropic for early access."
  Header names come from an allowlist (`authorization`, `x-api-key`,
  `x-auth-token`, …), up to four headers, and the value is sent **verbatim** —
  an `Authorization` header value must include the scheme, i.e. `Bearer <token>`.
- **Credentials must not go in the connector URL.** The docs call a
  query-string credential "a security vulnerability… routinely recorded in
  server logs, proxies, and browsing history," and the MCP authorization spec
  prohibits access tokens in the URI query string. A secret path segment is the
  same class of leak and is likewise rejected here.
- **Anthropic's outbound traffic originates from `160.79.104.0/21`.** Useful as
  a second layer, never as the only one — see the gate below.
- **`src/middleware.ts` currently redirects signed-out browser requests to
  `/app/login` and 401s signed-out API requests**, covering `/app/*`,
  `/api/app/*`, `/dispatch`, `/api/dispatch/*`, `/dashboard` and `/admin`. Slack
  and Anthropic are machines with no Supabase session.

## ⚠️ Implementation gate — do this before writing the MCP server

**Confirm the Request headers field appears in the "Add custom connector"
dialog on the Claude account that will hold this connector.**

Open Claude → **Customize → Connectors → Add custom connector**, and look for the
**Request headers** section.

- **Present** → proceed as specified.
- **Absent** → **stop.** Build Part A only, and email Anthropic for early access
  to request-header authentication before building Part B.

### Gate result — 2026-08-08: DID NOT PASS

The dialog on the account that would hold this connector offers **Name**,
**Remote MCP server URL**, and under **Advanced settings** only **OAuth Client
ID** and **OAuth Client Secret**. There is no Request headers section, so the
fixed-credential beta is not enabled for this account.

**Part B is deferred and must not be built as specified.** The remaining routes,
in the order they were judged:

1. **Request early access from Anthropic** (recommended). The documentation
   states request-header auth is "being slowly rolled out to customers; contact
   Anthropic for early access." If granted, Part B builds exactly as written
   below with no redesign.
2. **Implement an OAuth 2.0 authorization server**, which would make the
   dialog's existing OAuth fields usable. This requires protected-resource
   metadata (RFC 9728), authorization-server discovery (RFC 8414), `/authorize`
   with S256 PKCE, a `/token` endpoint accepting `application/x-www-form-urlencoded`,
   refresh with RFC 6749-compliant `invalid_grant` errors, and the
   `https://claude.ai/api/mcp/auth_callback` redirect URI. Several hundred lines
   of security-critical code guarding customer names, addresses and phone
   numbers. Viable, but not proportionate while route 1 is an email.
3. **A local (stdio) MCP server for Claude Desktop** — no public endpoint and no
   auth surface at all, but desktop-only, which does not serve the phone-in-the-field
   use case that motivated this work.

**Part A is unaffected** and proceeds now. Slash commands authenticate with
Slack's signing secret and need nothing from Claude. Slack's mobile app already
runs on the owner's phone, so `/trinity week` in the field — the literal request
that started this — is delivered without Part B.

**Do not ship an unauthenticated `/api/mcp`.** IP-allowlisting Anthropic's range
does not substitute for the token: an attacker who learned the URL would add it
as a connector on *their own* Claude account, and their requests would arrive
from **that same allowlisted range**. The IP check narrows who can reach the
route; only the token establishes that the caller is *us*. An open `/api/mcp` is
every customer name, address and phone number in the database, readable by
anyone who knows the URL.

## Architecture

```
Slack                                    Claude (Dave's Pro account)
  │  /trinity week                          │  "what's my schedule this week"
  ▼                                         ▼
POST /api/slack/command                  POST /api/mcp
  verify HMAC → dedupe retry               verify Bearer token + source IP
  ACK 200 (<3s)                            Streamable HTTP · MCP protocol
  waitUntil( answer → response_url )        │
  │                                         │
  ▼                                         ▼
src/lib/slack/commands.ts               src/lib/mcp/tools.ts
  │                                         │
  └──────────────┬──────────────────────────┘
                 ▼
   EXISTING query layer — unchanged
   dashboard/queries.ts · mobile/customers.ts
   mobile/money.ts · dispatch/nearby.ts
                 ▼
   Supabase (service role, server-only)
```

Both front doors are additive. Nothing in `src/lib/notifications/` or
`/api/cron/sync` is touched, so a bug in either cannot affect the daily digest
or the paid-invoice alerts.

## Part A — Slack slash commands

### Commands

| Command | Returns |
|---|---|
| `/trinity today` | Today's jobs, Eastern |
| `/trinity tomorrow` | Tomorrow's jobs |
| `/trinity week` | This Mon–Sun week, day by day |
| `/trinity next week` | Next Mon–Sun week |
| `/trinity thursday` (any weekday) | The next occurrence of that weekday, **counting today** — asking on a Thursday returns today, not a week out |
| `/trinity money` | Open estimates + pending/overdue invoices |
| `/trinity` or `/trinity help` | The list above |
| anything else | The help text, not an error |

Unrecognized input returns help rather than a failure — a slash command is
discovered by typing at it, and a dead end teaches nothing.

### Files

| File | Purpose |
|---|---|
| `src/app/api/slack/command/route.ts` | Endpoint: verify → dedupe → ACK → `waitUntil` |
| `src/lib/slack/verify.ts` | Signature check + replay guard |
| `src/lib/slack/commands.ts` | Parse subcommand → call query → format → post |
| `src/lib/slack/respond.ts` | POST the answer to Slack's `response_url` |

### Signature verification (`src/lib/slack/verify.ts`)

1. Read `X-Slack-Signature` and `X-Slack-Request-Timestamp`. Missing either → `401`.
2. Reject if the timestamp is more than **5 minutes** from now (replay guard).
3. Compute `v0=` + HMAC-SHA256 of the exact string
   `v0:{timestamp}:{rawBody}` keyed with `SLACK_SIGNING_SECRET`.
4. Compare with `crypto.timingSafeEqual`, never `===`.

The route must read the body **once**, as `await req.text()`, and parse the
form itself with `URLSearchParams`. This is the single most common way this
integration fails silently.

### Ack-then-answer

Return `200` immediately, then finish the work in `waitUntil` from
`@vercel/functions` (a new dependency) and POST the real answer to the
`response_url` Slack supplied. That URL is valid for 30 minutes and 5 uses.

`response_url` needs **only the signing secret** — no bot token, no OAuth
scopes, no bot user. That is a materially smaller Slack install than a chatbot
would have required, and the reason `/api/slack/events` is not in this design.

Set `export const maxDuration` on the route and verify the configured ceiling on
the current Vercel plan; the default may be shorter than the work needs.

### Formatting

Reuse `formatDailyDigest()` and `formatWeeklyLookahead()` from
`src/lib/slack/format.ts` **verbatim**. A command and the 6am digest then render
identically by construction, not by anyone remembering to keep them in step. If
a day's output ever exceeds Slack's message limits, split on day boundaries —
never truncate mid-job, which would silently hide work.

Every schedule command resolves to a single call to `getScheduleDays(anchor,
dayCount)` — `today` is `(now, 1)`, `week` is `(monday, 7)`, and so on. One
entry point, one code path, one place a bug can live.

Date handling reuses `weekRange()`, `dayRange()` and `localParts()` from
`src/lib/dashboard/week.ts`. **No new date arithmetic.** Those functions are
already DST-correct for `America/New_York`; a second implementation is exactly
how the dashboard and the digest would begin disagreeing about which day a job
falls on.

### Response visibility

Ephemeral by default (`response_type: "ephemeral"`) — the reply carries customer
names, street addresses and phone numbers, and only the person who asked needs
to see them. `in_channel` is a one-line change if the owner later decides the
schedule channel should see them.

## Part B — Trinity MCP connector (DEFERRED)

> **Not being built in this pass.** The implementation gate did not pass on
> 2026-08-08 — see "Gate result" above. This section is retained unchanged so
> that if request-header auth becomes available, the work is already specified
> and needs no redesign. Nothing below should be implemented until that gate
> passes.

### Files

| File | Purpose |
|---|---|
| `src/app/api/mcp/route.ts` | Streamable HTTP endpoint + auth |
| `src/lib/mcp/server.ts` | MCP server construction, tool registration |
| `src/lib/mcp/tools.ts` | The five tool handlers |
| `src/lib/mcp/auth.ts` | Bearer token + source-IP checks |

Built on `@modelcontextprotocol/sdk` (new dependency).

### Tools

All read-only. Each is a thin wrapper — **no new query logic**.

| Tool | Input | Wraps |
|---|---|---|
| `get_schedule` | `start_date`, `days`, `technician?` | `getScheduleDays()` |
| `find_customer` | `query` (name or phone) | `src/lib/mobile/customers.ts` |
| `get_customer` | `id` | `src/lib/mobile/customers.ts` (job history) |
| `get_money_summary` | — | `src/lib/mobile/money.ts` + revenue from `getDashboardSnapshot()` |
| `find_nearby_work` | `location`, `days` | `src/lib/dispatch/nearby.ts` |

`get_schedule` returns **both** a `formatted` field (the mrkdwn block
`formatWeeklyLookahead()` builds) and a structured `rows` array. Its tool
description instructs Claude to reproduce `formatted` when the user wants to
*see* a schedule, and to use `rows` when answering a question *about* it
("how many Thursday?", "who's busiest?").

This is deliberate: it means Claude never retypes a customer's name, street
number or phone from memory when listing jobs — it relays a block this codebase
built. Structured data alone would put a hallucination surface directly on top
of customer contact details.

### Authentication (`src/lib/mcp/auth.ts`)

Two layers, in this order, both required:

1. **Bearer token.** Compare the `Authorization` header against `MCP_AUTH_TOKEN`
   with `crypto.timingSafeEqual`. Generate the token the same way `/admin`'s is
   generated — 256 bits, `base64url`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
   Enter it in Claude's Request headers field as `Bearer <token>`, including the
   space — Claude sends the value verbatim and adds no scheme.
2. **Source IP.** Reject requests whose client IP falls outside
   `160.79.104.0/21`. On Vercel, take the **first** entry of `x-forwarded-for`
   (the platform sets it; do not trust a client-supplied full chain).

Failure of either → `401` with no detail in the body. Log the rejection without
the presented token.

The IP check is defense in depth: it does not identify the caller as us (see the
gate), but it does mean a leaked token is unusable from anywhere except
Anthropic's infrastructure.

## Middleware change

**Correction, found while planning: there is nothing to change here.**
`src/middleware.ts:112-119` matches only `/app/:path*`, `/api/app/:path*`,
`/dispatch`, `/api/dispatch/:path*`, `/dashboard` and `/admin`. `/api/slack/*`
is already outside that list, so middleware never runs on it and no exclusion is
needed. The earlier draft of this section was wrong.

What **is** needed is a regression test pinning that boundary. The failure mode
is invisible: a later broad matcher such as `/api/:path*` would answer every
slash command with a `302` to `/app/login`, which Slack surfaces as a bare
"didn't work" with nothing in it to diagnose. The route authenticates itself
with `SLACK_SIGNING_SECRET`; the test is what stops that from being silently
taken away.

`/api/mcp` gets the same treatment at the same time the route is built, never
before — an exclusion for a route that does not exist yet is a hole waiting for
something to fall into it.

This is not a loosening of security: each route authenticates on its own terms
(HMAC signature for Slack, bearer token + IP for MCP), and both are strictly
read-only. But it must be **explicit and tested**, because the failure is
invisible — Slack would receive a `302` to `/app/login`, report nothing useful,
and the commands would simply never work.

The existing README warning still governs everything here: all data access stays
in server-only route handlers via `getSupabaseServerClient()`. Neither new
surface introduces a browser-side Supabase client, and there is still no RLS
underneath to fall back on.

## Error handling

| Failure | Behavior |
|---|---|
| Bad/missing Slack signature | `401`, nothing downstream runs |
| Stale Slack timestamp (>5 min) | `401` |
| Slack retry (`X-Slack-Retry-Num` present) | `200` immediately, do no work — prevents triple-posting |
| Unknown subcommand | Help text, not an error |
| Bad/missing MCP token or IP | `401`, empty body |
| Supabase read fails | Slack: "Couldn't reach the schedule just now." MCP: an MCP tool error. **Never the raw error** — it can carry customer rows |
| Kill switch off | `200` with a short "not enabled" note; no query runs |

Both surfaces are entirely separate modules from `src/lib/notifications/`. A
failure in either cannot affect the cron sync, the daily digest, or the
paid-invoice alerts.

## Testing (Vitest, matching the existing `__tests__` layout)

**`src/lib/slack/__tests__/verify.test.ts`** — a known-good signature passes;
a tampered body fails; a stale timestamp fails; missing headers fail. Use a
fixed secret and a hand-computed digest so the test cannot drift with the
implementation.

**`src/lib/slack/__tests__/commands.test.ts`** — each subcommand maps to the
right date window; `thursday` resolves to the *next* Thursday in Eastern;
**a week spanning a DST transition still returns seven local days**; unknown
input returns help.

**`src/app/api/slack/command/__tests__/route.test.ts`** — ACK is returned
without awaiting the work; a retry header short-circuits; the kill switch
suppresses everything.

**`src/__tests__/middleware.test.ts`** — extend: `/api/slack/command` is **not**
redirected to `/app/login`, while `/api/app/*` and `/dashboard` still are. The
second assertion matters as much as the first — it is what catches an exclusion
pattern written too broadly.

**Deferred with Part B** — `src/lib/mcp/__tests__/auth.test.ts` (correct token +
in-range IP passes; correct token + out-of-range IP fails; wrong token fails;
missing header fails; boundary IPs `160.79.104.0` and `160.79.111.255` in range,
`160.79.112.0` out) and `src/lib/mcp/__tests__/tools.test.ts` (each tool against
a mocked Supabase; `get_schedule` returns both `formatted` and `rows` describing
the same jobs).

## Environment variables

| Variable | Purpose |
|---|---|
| `SLACK_SIGNING_SECRET` | Verify slash-command requests |
| `SLACK_COMMANDS_ENABLED` | Kill switch — commands inert unless exactly `"true"` |
| ~~`MCP_AUTH_TOKEN`~~ | Deferred with Part B — do not set in this pass |
| ~~`MCP_ENABLED`~~ | Deferred with Part B — do not set in this pass |

Both kill switches follow the `slackAlertsEnabled()` pattern in
`src/lib/slack/client.ts`: **default off**, exact string `"true"` only, so a
deploy can land before either surface is reachable. `MCP_AUTH_TOKEN` must be
recorded somewhere retrievable — like `ADMIN_TRIGGER_TOKEN`, Vercel marks it
Sensitive and will not read it back, and it has to be typed into Claude's
connector dialog.

## Rollout

1. Deploy with both kill switches unset. Confirm the app still builds and the
   dashboard, digest and cron are unaffected.
2. Create the Slack app, add the `/trinity` slash command pointing at
   `/api/slack/command`, set `SLACK_SIGNING_SECRET`, redeploy.
3. Set `SLACK_COMMANDS_ENABLED=true`. Run `/trinity today` and compare against
   the dashboard, then `/trinity week` against the Monday digest.
4. ~~Run the implementation gate.~~ **Done 2026-08-08 — did not pass.** Steps 1–3
   are the whole rollout for now. When request-header auth becomes available:
   set `MCP_AUTH_TOKEN` and `MCP_ENABLED=true`, add the connector in Claude, and
   verify with "what's on for this week" — checking the returned jobs against
   `/trinity week`.

Rollback is unsetting the kill switch and redeploying. No database change is
involved, so there is nothing to undo.

Because Part B is deferred, `MCP_AUTH_TOKEN` and `MCP_ENABLED` are **not set in
this pass**, and no `/api/mcp` route is created. The middleware exclusion added
for Slack must therefore cover `/api/slack/*` only — adding `/api/mcp` to it
ahead of time would leave a hole waiting for a future route to fall into.

## Accepted risk

**Slack commands are open to the whole workspace.** The owner chose this over an
allowlist, having been shown that the reply carries customer names, addresses and
phone numbers, and that single-channel guests or future hires would get access by
default. Recorded as a decision, not an oversight.

Mitigations already in the design: replies are ephemeral, so the data is not
left sitting in channel history; and everything is read-only, so the worst case
is disclosure, not damage. Should this change, a `SLACK_ALLOWED_USERS` check in
`src/lib/slack/commands.ts` is a few lines — the command handler already has
`user_id` in hand.

## Out of scope

- **Any write to Housecall Pro.** Read-only throughout.
- **Per-technician identity.** "My schedule" means the company's; no
  Slack-user → technician mapping. `technicianId` is still absent from
  `TodayScheduleRow` (`docs/PHASE-1.x-BACKLOG.md:244`), so `get_schedule`'s
  optional `technician` filter matches on display name, with the same
  same-name caveat the mobile Schedule tab has.
- **A conversational bot inside Slack**, in any form — API-backed or Claude Tag.
- **The Anthropic API.** No `ANTHROPIC_API_KEY` anywhere.
- **Proactive or scheduled messages** beyond the digests that already exist.
- **Query-layer optimization.** Pushing the date range into the Postgres query
  in `getScheduleDays()` would cut latency for both surfaces and the digest, but
  it touches a function the dashboard and digest share. Deliberately left out;
  worth revisiting if `/trinity week` feels slow in practice.
