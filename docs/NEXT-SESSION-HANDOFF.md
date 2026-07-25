# Next-Session Handoff

Paste the prompt below into a fresh Claude Code session (started in this repo) to
continue. It's written to be self-contained.

*Supersedes the Phase 1 handoff (2026-07-23). Phase 1.x items 1–5 are done,
committed, and merged; this covers go-live item 6.*

> **⚠️ READ THIS FIRST (2026-07-24, latest):** Real-time webhook sync is now
> **LIVE and verified end-to-end in production** — see the final section,
> "RESOLVED: real-time sync working". The webhook route envelope fix and the
> signing scheme (both described below as open "first task next session" items)
> are **DONE, committed (`5f793b9`), pushed, and deployed.** Do NOT re-do them.
> Everything between here and that final section is retained for history only.

---

## Copy-paste prompt

> Continue the Trinity Plumbing ↔ Housecall Pro go-live (Next.js 14 + TypeScript +
> Supabase + Vitest, deploying to Vercel). Repo:
> `C:\Users\Ryan\Documents\claude-projects\trinity-housecallpro`, branch `main`.
> Runbook: `docs/GO-LIVE-RUNBOOK.md`. Findings ledger: `docs/PHASE-1.x-BACKLOG.md`
> — **read the "Go-live Step 2 findings" section first**, it is the current state
> of truth.
>
> ### Status: Steps 0–2 COMPLETE. Steps 3–4 remain.
>
> Supabase project `wrvaenkyrfvbooogqhev` ("Trinity Plumbing Housecall", org
> `nganepfbxyolejfbkwpz`) is linked, 4 migrations applied, 7 tables live and
> populated: 1497 customers · 3038 jobs · 922 estimates · 2854 invoices · 6
> technicians · `geocode_cache` · `sync_cursors`. `.env.local` is complete except
> `HOUSECALL_WEBHOOK_SECRET` (set in Step 4). Local backfill verified; the
> dashboard renders correct numbers (Jobs in Progress 91, Open Estimates 453,
> Pending Invoices 25, Revenue Booked $145,708.30).
>
> Tests 57/57, lint + build clean.
>
> ### BLOCKER: two commits are local-only — `git push` FAILED
>
> ```
> a01c105  fix(cron): daily schedule for Vercel Hobby; invoices have no webhook
> 89fa2c8  fix(go-live): correct four defects surfaced by the first live backfill
> ```
>
> Push failed with *"Please make sure you have the correct access rights and the
> repository exists."* The previous handoff recorded this repo as **local-only
> with no remote**, so the remote may never have existed or was added
> incorrectly. Diagnose with `git remote -v` and `gh auth status` before
> anything else. Either fix the remote/credentials, or skip Git entirely —
> `vercel --prod` uploads the local directory directly.
>
> ### Do next
>
> 1. Fix the push (or choose direct upload).
> 2. **Vercel deploy.** The CLI is ALREADY authenticated as `info-31527868` — no
>    login needed. Run `vercel link`, then `vercel env add` for:
>    `HOUSECALL_API_KEY`, `HOUSECALL_WEBHOOK_SECRET`, `NEXT_PUBLIC_SUPABASE_URL`,
>    `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`
>    (values are in `.env.local`). Then `vercel --prod`.
> 3. Subscribe the webhook and resolve the payload shape (below).
>
> ### Webhook: TWO THINGS ARE STILL UNKNOWN — do not guess
>
> The HCP dashboard offers events ONLY for: Jobs, Job Appointments, Estimates,
> Estimate Options, Customers, Leads. **Invoices and Employees have NO webhook.**
>
> The OpenAPI spec (`housecall.v1.yaml`, untracked in repo root, 7465 lines) does
> NOT document the event payload — its `/webhooks/subscription` section is just
> `schema: {type: object}` with no properties. It does show webhooks can be
> subscribed via **API**, not only the dashboard.
>
> These remain open and MUST be determined empirically:
> - Is the event `resource` singular (`job`) or plural (`jobs`)? `syncOneRecord`
>   (`src/lib/sync/syncService.ts`) routes on PLURAL keys; a singular value needs
>   an alias in `TABLE_AND_MAPPER`.
> - Does `data` carry the FULL record or only a DELTA? We upsert whole rows, so a
>   delta would null out columns.
> - Confirm the signature header is `X-HousecallPro-Signature`
>   (`src/app/api/webhooks/housecall/route.ts`).
>
> Plan: add temporary raw-payload logging to the webhook route, point HCP at
> `https://<domain>/api/webhooks/housecall`, trigger one real change in HCP, read
> the payload from Vercel function logs, then adapt the mapper and remove the
> logging.
>
> ### Vercel Hobby constraints (verified against Vercel docs)
>
> - Hobby **rejects sub-daily cron at deploy time**. `vercel.json` is now
>   `0 8 * * *`; the original `*/15 * * * *` would have failed deployment outright.
> - `maxDuration = 300` IS allowed on Hobby (300s is both default and max).
>   Already set on the cron route.
> - Cron precision is ±59 min, so `INVOICE_RECONCILE_HOURS` is **20**, not 24 — a
>   24h threshold would skip the invoice pass on days when runs land ~23h apart,
>   pushing staleness to ~47h.
> - Consequence: customers/jobs/estimates stay real-time via webhooks, but
>   **invoices lag up to ~21h** because they have no webhook. Upgrading to Pro and
>   restoring a 15-minute schedule is a one-line `vercel.json` change.
> - NOTE: Vercel Hobby is licensed for non-commercial use; this is a commercial
>   business dashboard. Flagged to the user; their decision.
>
> ### Open task (approach already decided)
>
> `emergencyCalls` and `commercialJobs` dashboard cards read 0 and **no code
> change can fix them**: they derive from job tag names, but only 22 of 3038 jobs
> carry any tag and none are emergency/commercial (actual names: "HomeServe",
> "My Website", "H-27", "Dylan spiff up sell", "3LD"). The user chose to adopt a
> tagging convention going forward (lowercase `emergency` / `commercial`); a
> client-facing message was drafted and is ready to send. Cards stay 0 until
> tagging begins; no retroactive backfill without manual review.
>
> ### Hard-won gotchas — do not rediscover these
>
> - **Never run `npm run build` while `npm run dev` is running.** The build
>   overwrites `.next` and the dev server dies with *"Cannot find module
>   './chunks/vendor-chunks/next.js'"*. Kill dev first (Stop-Process on the PID
>   listening on port 3000), build, then restart.
> - **Supabase CLI login flaps.** It silently reverted to a different account
>   mid-session (403 *"account does not have the necessary privileges"*). If a
>   `supabase` command 403s, run `npx supabase projects list`; if
>   `wrvaenkyrfvbooogqhev` is absent, re-run `npx supabase login` as the owning
>   account. `supabase db push` is interactive (DB password) — the user must run it.
> - **PostgREST caps every response at 1000 rows.** This silently truncated the
>   dashboard (19 jobs in progress instead of 91). Always paginate with `.range()`.
>   A regression test pins this boundary.
> - **Test fixtures had encoded invented API values** (`"in_progress"`,
>   `"pending"`) that HCP never sends, so the suite passed while production was
>   wrong. Live values are `"in progress"` (with a SPACE) and `"open"`. When
>   touching sync/dashboard logic, verify against live data, not fixtures.
> - **GateGuard hook** fact-forces the first Bash command and every Edit/Write:
>   it blocks the first attempt and demands stated facts (callers, existing-file
>   check, data I/O, the user instruction). State them in the message BEFORE the
>   tool call to avoid a wasted round-trip. Disable with `ECC_GATEGUARD=off` if
>   it becomes obstructive.
> - **config-protection hook** blocks editing `.eslintrc.json` and similar — fix
>   the source to satisfy the linter, don't weaken config.
> - **Strict lint fails the build** on `@typescript-eslint/no-explicit-any` and
>   unused vars (test files included). Type mocks properly; no `any`.
> - **Vitest 4**: `vi.fn().mockImplementation(() => ({...}))` can't be `new`-ed —
>   use `function () { return {...} }` for mocked constructors.
> - Windows + Git Bash; the `LF→CRLF` git warnings are harmless.
>
> ### Cost discipline
>
> The previous session cost ~$84, mostly from repeated 5–8 minute live backfills.
> **Avoid re-running full syncs** — steady-state incremental runs take ~2s. Use
> targeted PostgREST count queries (`Prefer: count=exact`, `Range: 0-0`) instead
> of full-table pulls. Implement directly and run tests; only spin up a review
> subagent for genuinely risky code (migrations, money math, crypto).
>
> ### Loose end
>
> `housecall.v1.yaml` (216K) sits untracked in the repo root — commit it as
> reference or gitignore it. `scripts/` is also untracked (throwaway API probes).

---

## Why Step 2 took the time it did

The first live backfill **failed**, and verifying the result surfaced four
defects that no unit test could have caught — because the fixtures encoded the
same wrong assumptions as the code. Full detail in `docs/PHASE-1.x-BACKLOG.md`;
summary:

| # | Defect | Fix |
|---|--------|-----|
| 1 | Hard FKs aborted the sync on a job assigned to a deactivated technician | `0004_drop_external_fks.sql` drops all six inter-table FKs |
| 2 | Invoices have no `updated_at`, so the cursor never advanced — 58 API calls, ~70s of a ~72s run, every run | Time-gated daily reconcile; steady state now ~2s |
| 3 | Dashboard matched status values that don't exist (`"in_progress"`, `"pending"`) | Use live values `"in progress"`, `"open"` |
| 4 | PostgREST 1000-row cap silently truncated every count | Paginate with `.range()`, select only needed columns |

Defect 2 was independently confirmed by the official OpenAPI spec: the
`JobInvoice` schema (line 6413) has no modification timestamp at all.

---

*Generated at the end of the go-live Step 1–2 session (2026-07-24).*

---

# Step 3 session update (2026-07-24) — DEPLOYED

## Git blocker: resolved

There was no remote configured at all (`git remote -v` was empty), so the push
had nowhere to go — it was never a credentials problem. The remote already
existed on GitHub at `main = f31afab`, an ancestor of local `main`, so the push
was a clean fast-forward with no force.

Remote uses the **SSH host alias**, not github.com directly:

```
origin  git@github-personal:ryrychu/trinityplumbing-housecallpro.git
```

`github-personal` is defined in `C:\Users\Ryan\.ssh\config` → github.com with
key `id_ed25519_personal`. Using `git@github.com:` instead picks the default
`id_ed25519` key and fails auth — that is the original error.

## Production is live and verified

| Item | Value |
|------|-------|
| URL | https://trinity-housecallpro.vercel.app |
| Vercel project | `trinity-plumbing-and-drains/trinity-housecallpro` |
| Cron | `0 8 * * *` accepted (Hobby rejects sub-daily at deploy time) |

Verified against production, not just a green build:

- `GET /dashboard` → 200, renders **91 / 453 / 25 / $145,708.30** — matches local exactly.
- `GET /api/cron/sync` unauthenticated → 401; with `CRON_SECRET` → 200 in **4.9s**,
  `{"ok":true,...,"invoicesReconciled":false}`, upserting 1 each for
  customers/jobs/estimates. This proves `HOUSECALL_API_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` and the Supabase URL all work in production.
- `POST /api/webhooks/housecall` unsigned → 401 (signature check working).

7 production env vars set. `HOUSECALL_WEBHOOK_SECRET` is currently the
placeholder `pending-hcp-subscription-placeholder` — a placeholder rather than
empty so bad deliveries return 401 rather than 500, since repeated 5xx can cause
a provider to auto-disable a subscription.

## Two of the three webhook unknowns are now neutralised

- **Singular vs plural `resource`** — no longer needs to be discovered. The
  router accepts both and normalises to the plural key. Critically, the
  normalised key is passed to `buildGeocodeTargets` too: `GEOCODE_SPECS` is keyed
  on the same strings and returns `[]` silently for anything else, so aliasing
  only the table lookup would have upserted records with no coordinates and
  reported nothing. A regression test pins this.
- **Signature header name** — will be revealed by the probe. The probe runs
  *before* signature verification precisely so a wrong header name is still
  diagnosable from a 401 rather than being invisible.
- **Full record vs delta** — STILL OPEN. Only a real delivery answers it.

## The probe

`WEBHOOK_DEBUG=1` is set in production. It logs header names and payload **key
names only** — never field values — so no customer PII reaches Vercel logs.

Read it with (the table view truncates the message, `--json` does not):

```bash
vercel logs https://trinity-housecallpro.vercel.app --json | grep -o '\[webhook-probe\].*'
```

Already confirmed working against a synthetic POST.

**If `dataKeys` comes back as a short list** (e.g. just `["id","work_status"]`)
the payload is a delta, and `syncOneRecord`'s whole-row upsert would null out
every unlisted column. The fix in that case is to ignore `data` and re-fetch the
full record from the HCP API by id — one extra call per webhook, and it makes
the question moot permanently.

## Remaining

1. Subscribe the webhook in the HCP dashboard (URL below) and capture the
   signing secret it issues. The OpenAPI spec cannot help here: its
   `/webhooks/subscription` request body is `schema: {type: object}` with no
   properties, so subscribing via API would mean guessing the shape.
   `https://trinity-housecallpro.vercel.app/api/webhooks/housecall`
2. Replace the placeholder secret, redeploy, trigger one real change, read the probe.
3. Remove or leave `WEBHOOK_DEBUG` unset once the shape is confirmed.
4. Vercel↔GitHub push-to-deploy is **not** connected: Vercel could not parse the
   SSH alias URL. Connect the repo from the Vercel dashboard if auto-deploy is
   wanted; `vercel --prod` works regardless.
5. Vercel Hobby is licensed for non-commercial use; this is a commercial
   dashboard. Still the user's call.

---

# Phase-1 gap assessment vs. client roadmap (2026-07-24)

The client's full vision lives in `list.md` at the repo root — a 10-phase
roadmap (Phases 1–10 plus "Future AI Features" and "Long-Term Vision"). **All
work to date is inside Phase 1 only, and Phase 1 itself is not complete.** This
section maps what exists against the Phase-1 list so the next session starts with
an accurate picture. Statuses below were verified against code and live data this
session, not assumed.

## Phase 1 — Foundation

### HCP Integration → Synchronize
| List item | Status | Note |
|-----------|--------|------|
| Secure connection (API) | ✅ | Bearer `HOUSECALL_API_KEY`. The list says "OAuth/API"; we use API-key auth, not OAuth. |
| Customers | ✅ | 1497 synced |
| Jobs | ✅ | 3038 synced |
| Estimates | ✅ | 922 synced |
| Invoices | ✅ | 2854 synced |
| Technicians | ✅ | 6 synced |
| Job status | ✅ | Live `work_status` values censused (see `queries.ts`) |
| **Leads** | ❌ | No `leads` table, no mapper. Not synced at all. HCP *does* emit `lead.*` webhooks. |
| **Tags** | ⚠️ | Column synced, but only 22/3038 jobs carry any tag and none are emergency/commercial. Drives the two 0-value cards. |
| **Notes** | ⚠️ | Customer `notes` present; job-level notes not confirmed synced. |
| **Attachments** | ❌ | Not synced. No table, no mapper. |

### Operations Dashboard
The list names **10 cards**. `DashboardSnapshot` (`src/lib/dashboard/queries.ts`)
implements **6**. The other 4 are not built — confirmed by the interface having
exactly six fields.

| Card (from list) | Status | Note |
|------------------|--------|------|
| Jobs in progress | ✅ | 91 |
| Open estimates | ✅ | 453 (derived; HCP has no "open" estimate status — see `isOpenEstimate`) |
| Pending invoices | ✅ | 25 ("open" = unpaid; there is no "pending" status) |
| Revenue booked this week | ⚠️ | Value renders ($145,708.30) but is **all-time booked, NOT week-scoped**. `revenueBookedCents` is explicitly not date-filtered; a "this week" filter is a noted 1.x fast-follow. |
| Commercial jobs | ❌ | Reads 0 — depends on tags. Tagging convention being adopted; no retroactive backfill. |
| Emergency calls | ❌ | Reads 0 — same tag dependency. |
| Today's schedule | ❌ | Not implemented (no snapshot field). |
| Upcoming estimates | ❌ | Not implemented. |
| Technician workload | ❌ | Not implemented. |
| Revenue scheduled next week | ❌ | Not implemented. |

### Geographic Scheduling Assistant
⚠️ **Infrastructure only, not the feature.** Geocoding exists (`geocode_cache`,
addresses resolved on sync into lat/lng). The described capabilities —
distance-from-Averill-Park, estimated drive time, service-zone assignment,
compass direction, and "already working nearby" recommendations — are **not
built**. This overlaps heavily with Phase 2 (Scheduling Intelligence).

## Phases 2–10 + Future AI + Long-Term Vision
❌ **Not started.** Scheduling intelligence, inventory integration, SOP/training,
AI job assistant, commercial management, customer portal, marketing automation,
KPI dashboard, predictive scheduling, and the Trinity-OS vision are all future
roadmap. Not in scope for any session to date.

## The live blocker (above everything else on this list)

**Real-time sync does not work yet.** HCP is not delivering webhooks to the
endpoint: two API-triggered test events (`customer.created`, `customer.updated`)
plus a full 5-minute `vercel logs --follow` produced **zero deliveries**. The
webhook *code* is correct and verified (handshake passes, `api-signature` header
read, bad signatures rejected) — the problem is on the subscription/delivery
side. Until resolved, all data refreshes once daily at 08:00 UTC via cron.

**Next session should start with these three cheap checks (no code):**
1. Does HCP show a **delivery/retry log** for the subscription? Attempts with
   error codes → firing-but-failing; empty → not firing.
2. Is the subscription **saved and active** after enabling events? (Saving the
   URL and enabling events may be separate steps.)
3. Does HCP **suppress webhooks for API-originated changes**? If so, only a
   manual UI edit produces an event, and the API-driven tests could never fire.

The signing construction is still unconfirmed (480 offline candidates failed; a
server-side detector is armed behind `WEBHOOK_DEBUG=1` and will name the scheme
on the first real delivery). If real-time proves troublesome, the decided
fallback is to **trust only the record `id` in the payload and re-fetch the
authoritative record from the HCP API** — this makes the signature non-load-
bearing and permanently resolves the still-open delta-vs-full-record question.

## Honest Phase-1 completion checklist (to actually finish Phase 1)
1. Fix webhook delivery (the 3 checks above) — unblocks real-time.
2. Enable `invoice.*` webhooks — closes the documented ~21h invoice lag. (The
   "invoices have no webhook" claim elsewhere in this doc is WRONG; HCP has 9.)
3. Do NOT enable `customer.deleted` / `job.deleted` until delete handling exists
   (`syncOneRecord` only upserts — a delete event would re-insert the record).
4. Sync **Leads** and **Attachments** (both on the Phase-1 list, both missing).
5. Build the 4 missing dashboard cards; date-scope "revenue booked this week".
6. Scope how much Geographic Scheduling Assistant is wanted now vs. Phase 2.
7. Begin the tagging convention so emergency/commercial cards populate.

## Housekeeping left open
- Test record still in **production HCP**: customer `ZZ-Webhook Test-DELETE-ME`
  (`cus_d8924aacf0d24a888280e12187e40f6f`). Delete when convenient.
- `WEBHOOK_DEBUG=1` and the `logPayloadShape` / `detectSignatureScheme` /
  handshake-logging probes are still live in production — remove once the signing
  scheme is pinned and encoded in `verifyWebhookSignature`.

---

# BREAKTHROUGH: real webhook payload captured (2026-07-24)

**Webhooks DO deliver.** The earlier "zero deliveries" was a log-window timing
artifact — HCP fires on API-originated changes, just not instantly (the delivery
landed ~1s after the API call but my snapshot windows had already closed). A
`customer.updated` triggered on the test customer was captured in full. This
answers all three open questions and reveals the code's envelope assumption is
wrong.

## The actual payload envelope (verified from a live delivery)

```json
{
  "event": "customer.updated",
  "event_occurred_at": "2026-07-24T05:38:14Z",
  "company_id": "233b75f9-4b4f-4a83-b21b-c1ed9e571daa",
  "customer": { /* FULL record: id, first_name, ..., tags:[], addresses:[], attachments:[] */ }
}
```

Top-level keys: `["event", "event_occurred_at", "company_id", "customer"]`.

### Three things this breaks / resolves

1. **There is NO `resource` field and NO `data` field.** The record lives under a
   key named after its type (`customer`), and the type is derived from the
   `event` prefix (`customer.updated` → `customer`). The route currently requires
   `resource` and `data`, both of which are absent — so a real event hits the
   **handshake branch** (both null → 200, no sync) and is silently dropped. This
   is THE reason nothing was syncing even once delivery worked. The
   singular/plural `resource` aliasing built earlier is now moot; the resource
   comes from the event name instead.
2. **`data` is the FULL record, not a delta** — previously open, now settled. All
   ~20 customer fields present. Whole-row upsert is safe; no API re-fetch needed
   for correctness. (The re-fetch fallback is therefore optional, not required.)
3. **Attachments arrive in the payload** (`"attachments":[]` on the customer) —
   relevant to the Phase-1 "Attachments" gap; they may be syncable straight from
   the webhook body rather than a separate pull.

### Required route/mapper change (first task next session)
- Parse the envelope as `{ event, <typeKey> }`, not `{ resource, data }`.
- Derive resource from `event.split(".")[0]` (`customer`/`job`/`estimate`/
  `invoice`/`lead`/`pro`...) and normalize to the plural table key (the existing
  `RESOURCE_ALIASES` already maps singular→plural; extend for `pro`→technicians).
- Read the record from `payload[resourceSingular]` (e.g. `payload.customer`).
- Keep the handshake branch, but tighten it: a real event has an `event` key, so
  gate the handshake on `event == null` rather than "resource and data absent",
  otherwise real events keep getting swallowed as handshakes.
- Update `syncOneRecord` callers and the webhook tests to the new shape.

## Signing scheme — now derivable OFFLINE (no more live events needed)

The captured delivery was signed with the CURRENT secret (unlike the stale
handshake sample), so the scheme can be brute-forced offline against this triple.
The body must be the EXACT raw bytes below (no reserialization — whitespace and
key order matter for HMAC):

```
api-signature: 93e493e16de16478fbf4e76eacc0c4aed70212ae755bcf03c36883867839282c
api-timestamp: 1784871495
rawBody: {"event":"customer.updated","event_occurred_at":"2026-07-24T05:38:14Z","company_id":"233b75f9-4b4f-4a83-b21b-c1ed9e571daa","customer":{"id":"cus_d8924aacf0d24a888280e12187e40f6f","first_name":"ZZ-Webhook","last_name":"Test-DELETE-ME","email":"webhook-test@trinity.plumbing","mobile_number":null,"home_number":null,"work_number":null,"company":null,"notifications_enabled":false,"lead_source":null,"notes":"delivery retest 2","kind":"homeowner","created_at":"2026-07-24T04:00:37Z","updated_at":"2026-07-24T04:00:37Z","company_name":"Trinity Plumbing and Drains Inc.","company_id":"233b75f9-4b4f-4a83-b21b-c1ed9e571daa","tags":[],"addresses":[],"attachments":[]}}
```

Signature is 64 hex chars = HMAC-SHA256. Run `scratchpad/derive-sig.mjs` (or the
in-route `detectSignatureScheme`) with the secret from `.env.local` against this
exact body + timestamp. CAVEAT: the raw body above was reconstructed from the
captured log; if no construction matches, it's because a byte differs from what
HCP actually sent — in that case capture a fresh delivery and derive from the
`[webhook-handshake]` log line, which records the byte-exact `rawBody`.

Fallback if the scheme still won't derive: trust only the record `id` from the
payload and re-fetch from the HCP API — signature becomes non-load-bearing.

## Housekeeping update
- The test customer `cus_d8924aacf0d24a888280e12187e40f6f` **could not be deleted
  via API** — `DELETE /customers/{id}` returns 404 (HTML), so HCP does not expose
  customer deletion there. **Delete it manually in the HCP UI** (labelled
  `ZZ-Webhook Test-DELETE-ME`).

---

# RESOLVED: real-time sync working (2026-07-24)

Everything above about the webhook being broken is now **fixed and verified in
production.** Commit `5f793b9` (`fix(webhook): parse real HCP event envelope and
correct signing scheme`) is pushed and deployed.

## Two bugs fixed (both required for a single event to sync)

1. **Envelope parsing** (`src/app/api/webhooks/housecall/route.ts`). The route
   required `resource` + `data`; a real HCP event sends neither, so every
   delivery fell into the URL-validation handshake branch and was silently
   dropped. Now it derives the resource from `event.split(".")[0]`, reads the
   full record from `payload[resource]` (e.g. `payload.customer`), and gates the
   handshake on `event == null`.
2. **Signing scheme** (`src/lib/housecall/webhookVerify.ts`). Derived offline
   from the captured live delivery: HCP signs
   **`HMAC-SHA256(secret_as_utf8, `${api-timestamp}.${rawBody}`)`, hex-encoded**,
   in the `api-signature` header (Stripe-style `timestamp.body`). The old
   verifier hashed the body only, so even with bug 1 fixed every real delivery
   would still have 401'd. The route now reads `api-timestamp` and threads it in.

The temporary probes (`detectSignatureScheme`, `logPayloadShape`,
`SIGNATURE_CANDIDATES`, the `WEBHOOK_DEBUG` handshake logging) are **removed** —
the scheme is pinned, so they served no further purpose. Tests updated to the
real envelope + signing scheme; 71/71 pass, lint + build clean.

## Verified end-to-end in production

- A signed POST to `https://trinity-housecallpro.vercel.app/api/webhooks/housecall`
  (correct secret + scheme) returned **HTTP 200 `{"ok":true}`** and upserted the
  record — proving deployed code, secret, signature verification, envelope
  parsing, and the Supabase upsert all work.
- A real HCP API change (customer notes edit, **no** manual POST) appeared in
  Supabase **~2 seconds** later via a genuine webhook delivery. Real-time sync is
  live.
- The production `HOUSECALL_WEBHOOK_SECRET` is correct (matches HCP); it is **not**
  the old placeholder.

## Gotcha discovered while verifying (avoid re-tripping)

`customers` has **no top-level `notes` column** — `notes` lives inside the `raw`
jsonb blob. Querying `select=...,notes` returns a PostgREST *error object*, which
is easy to mishandle as "row absent" and mistake for a broken sync. Verify via
`select=id,updated_at,notes:raw->>notes`. The same applies to any field not in a
mapper (see `src/lib/sync/mappers.ts` for the actual column set per table).

## Env note

`WEBHOOK_DEBUG=1` is still set in production but is now a **no-op** — the code it
gated was deleted. Remove it from Vercel whenever convenient; harmless if left.

## What's next (Phase 1 remainder — still open, unchanged by this fix)

Real-time sync working does not finish Phase 1. Still outstanding from the
"Honest Phase-1 completion checklist" above:
1. ~~Fix webhook delivery~~ ✅ **DONE.**
2. Enable `invoice.*` webhooks to close the ~21h invoice lag (currently
   invoices reconcile via the daily cron only).
3. Do NOT enable `customer.deleted` / `job.deleted` until delete handling
   exists — `syncOneRecord` only upserts, so a delete event would re-insert the
   record. (Confirmed live: deleting a customer in the HCP UI does **not** remove
   it from Supabase.)
4. Sync **Leads** and **Attachments** (both on the Phase-1 list, both missing).
5. Build the 4 missing dashboard cards; date-scope "revenue booked this week".
6. Scope how much Geographic Scheduling Assistant is wanted now vs. Phase 2.
7. Begin the tagging convention so emergency/commercial cards populate.

---

# FINISH PHASE 1 — implemented (2026-07-24, branch `finish-phase-1`)

Items 2–7 above are now **code-complete** on the branch (item 3's delete handling
shipped, so `customer.deleted`/`job.deleted` are now safe to enable). Spec:
`docs/superpowers/specs/2026-07-24-finish-phase-1-design.md`. Plan:
`docs/superpowers/plans/2026-07-24-finish-phase-1.md` (13 tasks, TDD,
subagent-driven; each task committed + reviewed). Suite **99/99**, lint + build
clean. NOT yet merged; migration NOT yet applied (see below).

## What shipped (code complete, on branch)

| Phase-1 gap | Status | Where |
|-------------|--------|-------|
| **Leads** sync | ✅ | `mapLead`, `client.listLeads`, cron incremental pass, `lead→leads` alias |
| **Attachments** sync | ✅ code | `src/lib/sync/attachments.ts` — metadata always + best-effort copy to Supabase Storage (`hcp-attachments`) |
| **Tags/Notes** first-class | ✅ | `jobs.tags/notes`, `customers.tags/notes`; mappers populate them |
| **Delete handling** | ✅ | `syncOneRecord(...,action)` — `*.deleted` deletes (+ attachment cascade); webhook threads the action |
| **Geo computed fields** | ✅ | `distance.ts`/`zones.ts` now town-first via `townZones.ts`; shown in Today's-schedule panel |
| **Dashboard: 4 missing + panels** | ✅ | Upcoming Estimates, Revenue Scheduled (Next Week), Today's Schedule panel, Technician Workload panel |
| **Revenue booked date-scoped** | ✅ | `revenueBookedThisWeekCents` (Mon–Sun, was all-time); `week.ts` helper |

`TOWN_ZONES` finalized from a live census of customer cities with the owner's
routing decisions (46 towns).

## REQUIRED human/operational steps before this is live

1. **Apply migration 0005** — `supabase db push` (interactive; owner runs it).
   Adds `leads` + `attachments` tables and the 4 tags/notes columns. Until
   applied, sync of leads/attachments/tags/notes has nowhere to write. (The
   dashboard renders without it — its queries use pre-existing columns.)
2. **Create the `hcp-attachments` Storage bucket** + run the Task-4 probe
   (`curl -I` a real HCP attachment URL). If it needs auth, re-hosting silently
   no-ops (metadata still syncs) — note as follow-up. Plan Task 4 Step 6.
3. **Live dashboard check** after 0005: open `/dashboard`; confirm 8 cards, the
   two panels, and week-scoped "Revenue Booked (This Week)".
4. **Merge `finish-phase-1`** and redeploy (`vercel --prod`).
5. **Enable HCP `invoice.*` webhooks**; delete handling now exists, so
   `customer.deleted`/`job.deleted` are also safe to enable.
6. **Remove `WEBHOOK_DEBUG=1`** from Vercel (no-op).

## Deferred / fast-follow (from task reviews — not blocking)

- `todaySchedule` resolves customer via `raw.customer.id` not the typed
  `jobs.customer_id` column (marginal — `raw` fetched anyway for address city).
- Attachment cascade-delete error unchecked (silent); jobs delete-cascade branch
  and attachment success/storage-fail branch untested.
- Week/day windows are UTC; business-local timezone is a follow-up.

---

# PHASE 1 IS COMPLETE (2026-07-25)

All six operational steps are done and verified. **Goal 2 (the dashboard UI
redesign) has NOT been started** — that is the entire remaining scope. Plan:
`docs/superpowers/plans/2026-07-24-dashboard-ui.md`.

| # | Step | Status |
|---|------|--------|
| 1 | Apply migration 0005 | ✅ verified via PostgREST (2 tables + 4 columns) |
| 2 | Storage bucket + attachment probe | ✅ bucket private; probe done; **3 real defects found and fixed** |
| 3 | Live dashboard check | ✅ 8 cards + 2 panels; revenue week-scoped |
| 4 | `vercel --prod` | ✅ run by the owner |
| 5 | Enable HCP `invoice.*` + `*.deleted` webhooks | ✅ done by the owner |
| 6 | Remove `WEBHOOK_DEBUG=1` | ✅ done by the owner |

## Production verification (2026-07-25)

`GET /dashboard` → 200, and **Revenue Booked (This Week) = $22,441.89** — the key
assertion, since the old value was all-time `$145,708.30`.

```
Jobs in Progress 93 · Emergency Calls 0 · Commercial Jobs 0 · Open Estimates 453
Upcoming Estimates 0 · Pending Invoices 25
Revenue Booked (This Week) $22,441.89 · Revenue Scheduled (Next Week) $4,334.84
Panels: "No jobs scheduled today." / "No assigned work today."
```

`POST /api/webhooks/housecall` unsigned → 401 (signature check still correct).

## The attachment probe changed the design — read this before touching attachments

The Task-4 probe was specified as `curl -I`. **`curl -I` gives a false negative:**
HCP attachment URLs are presigned S3 links signed for GET, so `HEAD` returns
**403**. Use a ranged GET instead. Measured on a live URL:

```
HEAD        -> 403 Forbidden
GET (range) -> 206  image/png  bytes 0-1023/2208388
GET (full)  -> 200  2,208,388 bytes      <- no auth header needed
upload into private hcp-attachments bucket -> 200
```

`hcp_url` carries `X-Amz-Expires=3600`, so **the stored URL string dies after one
hour.** An earlier note in this doc concluded from that "metadata-only is
permanently unrecoverable" — **that was WRONG and is corrected here.** The URL
expires; the *file* does not. HCP re-mints a fresh presigned URL on every API
call (verified: the same attachment id was fetched twice minutes apart, both
returning working URLs). The stored metadata (`id`, `parent_id`, `file_name`) is
all you need to ask for a new one.

**Consequence:** re-hosting is an *archive*, not a durability requirement. HCP is
already the durable store. If storage ever becomes a constraint again, deleting
re-hosted files is safe and reversible — refetch with
`GET /jobs?expand[]=attachments` and match on attachment `id`.

## Three real defects found and fixed — commit `eedf801`

The Attachments feature shipped "code complete" but was **completely inert**.

| # | Defect | Fix |
|---|--------|-----|
| 1 | HCP omits attachments unless expanded (`expand[]=attachments`); `client.request()` never sent it, so **3038/3038 jobs had no `attachments` key at all** | `client.ts` `request()` takes an `expand` array; `listJobs`/`listCustomers` pass `["attachments"]` |
| 2 | Live attachments are `{id, file_name, url, file_type}` — there is **no `content_type`** — but the mapper read `att.content_type`, so the column was always null and uploads had no content type | `content_type: att.file_type ?? att.content_type ?? null` |
| 3 | Metadata-only mode stored a URL dead within the hour | Re-hosting is now default, bounded by a run-scoped `RehostBudget` (mirrors `GeocodeBudget`) |

`expand` is a general mechanism — the jobs endpoint also supports
`expand[]=appointments`. Enum values live in `housecall.v1.yaml` near line 630.

## Data state after the backfill

One full local sync (26 min, 10:57–11:23Z, `ATTACHMENT_REHOST_MAX_PER_RUN=3000`),
re-paging customers (1498 / 30 pages) and jobs (3093 / 62 pages):

| Table | Count |
|-------|-------|
| `attachments` | **436** — all re-hosted, 0 metadata-only |
| Storage used | **912.1 MB** across 436 objects, avg 2.1 MB |
| Types | 386 `image/jpeg`, 8 `application/pdf`, 1 `image/png` |
| `jobs.notes` | 319 |
| `jobs.tags` | **22** — matches the earlier census exactly |
| `leads` | **0 — legitimately.** The HCP account has no leads; sync works, there is simply nothing to sync. Not a bug. |

Largest files are 8–12 MB technician phone photos (`IMG_*.jpeg`,
`ios_*.jpg`). 436 is the COMPLETE set — an earlier extrapolation of "~800 files /
1.5–2 GB" was wrong; don't trust it.

**Cursors were reset for the backfill and are RESTORED:**
`customers=2026-07-23T21:30:49+00:00`, `jobs=2026-07-23T22:55:14+00:00`.
If you ever null them again, restore them afterwards or the daily production cron
re-pages all 92 pages every run.

**Supabase is now on the Pro plan** (100 GB storage). At 912 MB the backfill would
have consumed **89% of the free tier's 1 GB** — it was killed mid-run and resumed
after the upgrade.

## Follow-ups — none blocking, all real

1. **`rehost()` re-copies files it already has.** There is no
   `if (row.storage_path) continue` guard, so the resumed run spent **16 minutes**
   re-downloading and re-uploading the 388 files already present before reaching
   new ones (visible in the watchdog log: count frozen at 395 from 11:04→11:20).
   A skip-guard makes repeat runs nearly free.
2. **`rehost()` has no fetch timeout — a genuine hang vector.** Node's `fetch`
   has no default timeout, so a stalled S3 socket blocks the whole run
   indefinitely. Add `AbortSignal.timeout(...)` to both the download and the
   upload. The function already swallows errors, so it degrades to
   `storage_path: null`.
3. **Keep `ATTACHMENT_REHOST_MAX_PER_RUN` at 25 in production.** The cap exists
   for the 300 s function limit, NOT for storage — Supabase Pro does not make it
   safe to raise. Only raise it for local runs, which have no timeout.
4. **Both dashboard panels rendered empty**, but that was Saturday 2026-07-25 —
   plausible, yet unproven. Re-check on a weekday, especially given the known
   quirk that `todaySchedule` resolves customers via `raw.customer.id` rather
   than the typed `jobs.customer_id` column.
5. **`Upcoming Estimates` reads 0** — not confirmed against underlying data.
6. **Page `<title>` is still "Create Next App"** — fix during the UI redesign.
7. **Unverified:** that the owner's `vercel --prod` shipped commit `eedf801`.
   The week-scoped revenue proves the earlier dashboard code is live, but the
   attachment fix only touches client/cron and isn't observable externally.
   Confirm with `npx vercel ls` or the commit shown in the Vercel dashboard.
8. Emergency/Commercial cards still read 0 — unchanged tag dependency, waiting on
   the tagging convention. Not a code issue.

## BOTH CLIs WERE LOGGED INTO THE WRONG ACCOUNT — the biggest time sink today

This cost more than any technical problem. Check both *before* starting work.

**Supabase** — billing and permissions are per **organization**, and this account
has two:

| Org | Contains |
|-----|----------|
| `nganepfbxyolejfbkwpz` | **`wrvaenkyrfvbooogqhev`** — "Trinity Plumbing Housecall" ← the project |
| `fwdsxsgiulcuodmqsjhz` | "Trinity Plumbing Inventory", `trinity.plumbing.ny@gmail.com's Project` |

`npx supabase projects list` initially showed only the *second* org, so
`db push` would have 403'd. Verify `wrvaenkyrfvbooogqhev` appears in that list
before running anything.

**Vercel** — `vercel --prod` failed with *"Could not retrieve Project Settings"*.
`.vercel/project.json` points at org `team_xeYCTfns0UGL7Vj9JwDOC8NT` (team
`trinity-plumbing-and-drains`), but `vercel teams ls` listed only `dragonfly-ai`
and `ryan-8593s-projects`, and `whoami` returned `Not authorized`. The fix is
`npx vercel login` as the owning account.

⚠️ **Do NOT follow the CLI's suggestion to delete `.vercel/` and re-link while
signed into the wrong account** — that creates a *new* project under the wrong
team with a different URL and orphans `trinity-housecallpro.vercel.app`.

## Vercel plan: no upgrade needed

Hobby does not block deploys, webhooks, real-time sync, or `maxDuration = 300`.
The one functional cost was daily-only cron causing the ~21 h invoice lag — and
enabling `invoice.*` webhooks (step 5, now done) makes invoices real-time, so the
main reason to upgrade is gone. **Still open (non-technical):** Hobby is licensed
for non-commercial use and this is a commercial dashboard. Owner's call.

## Session mechanics worth repeating

- **Poll the database, not the process.** `npm run dev | tail` and backgrounded
  `curl` both buffer their output, so their log files stay 0 bytes and tell you
  nothing. Row counts are the reliable progress signal.
- **A background watchdog beats repeated manual polling** — one 60 s-interval
  sampler with a stall detector, read once at the end, replaces dozens of
  expensive check-in round trips. Repeated polling was a large share of this
  session's cost.
- Git Bash `/tmp` is NOT Windows `C:\tmp`. `curl -o /tmp/x` then `node` reading
  `/tmp/x` fails with ENOENT; use the scratchpad path in both.
- GateGuard blocks the **first** Edit per file regardless of facts already stated,
  then allows the retry — budget two attempts per new file.

## Next session: Goal 2 only

Execute `docs/superpowers/plans/2026-07-24-dashboard-ui.md` (7 tasks, Tailwind
**v3** not v4, responsive, no data-layer changes). Run it **inline, not
subagent-driven**, for cost control. Ask the owner for Trinity's real brand
colour/logo before finalising — the plan currently uses a placeholder steel-blue
token. Fold in follow-up 6 (the page title) while you're there.

---

# GOAL 2 COMPLETE — dashboard UI redesign shipped (2026-07-25)

All 7 plan tasks done. Suite **130/130** (was 112: +20 new, −2 from the deleted
`MetricCard` test), lint + build clean, `/dashboard` still **138 B** of client JS
— everything stayed a server component. NOT yet deployed (`vercel --prod` is the
owner's step).

## The plan's placeholder palette was NOT used

The plan specified a light theme (slate-50 page, white cards) on a placeholder
steel-blue `#1e3a5f`. The owner pointed to **`docs/color-scheme.md`**, which is
the real identity shared by trinity.plumbing and trinityplumbingny:
**dark surfaces + a single gold accent `#f2c400` + warm off-white text + Inter.**
The dashboard was built on that instead. Structure, tasks, and tests followed the
plan; only the palette and typography changed.

Token naming departs from the plan deliberately. A 50→900 ramp reads backwards on
a dark surface, so each semantic colour exposes two slots:

| Class | Meaning |
|---|---|
| `<name>` | bright foreground (text, icons, bars) |
| `<name>-tint` | dark desaturated background (badge/chip fill) |

plus `surface-{page,card,raised,elevated,divider,border}` and
`ink-{primary,muted,faint,inverse}`. Inter is loaded via `next/font/google`
(build-time fetch); **Geist Mono is retained for all numerals** — Geist Sans is
gone. `tailwind.config.ts` cites `docs/color-scheme.md` as source of truth.

## Three fixes beyond the plan's scope

1. **`ZoneBadge` was missing a zone.** The plan's `ZONE_STYLES` had 5 keys, but
   `classifyZone()` (`src/lib/geo/zones.ts:28`) can also return
   **`"Outside Service Area"`**, which would have fallen through to the neutral
   unknown style. It now gets a danger tint. A parametrised test pins all six.
2. **Times rendered in UTC.** Both panels and the page header used bare
   `toLocaleTimeString`, so on Vercel (UTC) a 10:00 Eastern job displayed as
   14:00. Now pinned to `America/New_York`, matching the Eastern-scoped revenue
   windows already in the data layer. Verified: 12:30Z renders as 08:30 AM.
3. **Money now always shows 2 decimals** (`$1,000.00`, not `$1,000`).

## Visual verification — both panels WERE checked with data

Live at 1440px and 375px against real production numbers (93 · 0 · 0 · 453 · 0 ·
25 · $22,441.89 · $4,334.84), 0 console errors. Because both panels are
legitimately empty on a Saturday, a **throwaway preview route with synthetic rows**
was used to confirm the parts the empty state hides: the desktop table, the
mobile card stack, all six zone badge colours, gold load bars vs. grey for the
Unassigned bucket, an empty bar at 0h (no divide-by-zero), and em-dash fallbacks
for null time/miles/drive. That scaffold was deleted and never committed —
confirm with `git log --oneline` that no `zzpreview` route exists.

⚠️ **App Router gotcha:** a folder named `_preview`/`__preview` returns **404** —
leading-underscore folders are private and opted out of routing. Use a plain name.

## Still open (unchanged by this work)

- Handoff follow-ups **1–5, 7, 8** below are untouched: `rehost()` skip-guard and
  `AbortSignal.timeout()`, weekday panel re-verification, `Upcoming Estimates = 0`
  unconfirmed, and whether the owner's `vercel --prod` shipped `eedf801`.
  Follow-up **6 (page title) is DONE** — now "Trinity Plumbing — Operations".
- **No logo.** `public/` does not exist; the header is a gold-rule + wordmark. Drop
  a PNG/SVG in `public/` and add it to the header in `page.tsx` if one is wanted.
- Emergency/Commercial still read 0 — tag dependency, not a UI issue.
- A light-theme variant, if ever wanted, is a `tailwind.config.ts` + `globals.css`
  change only; no component touches it (all colours go through tokens).

