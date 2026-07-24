# Next-Session Handoff

Paste the prompt below into a fresh Claude Code session (started in this repo) to
continue. It's written to be self-contained.

*Supersedes the Phase 1 handoff (2026-07-23). Phase 1.x items 1–5 are done,
committed, and merged; this covers go-live item 6.*

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

