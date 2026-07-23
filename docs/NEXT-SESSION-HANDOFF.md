# Next-Session Handoff

Paste the prompt below into a fresh Claude Code session (started in this repo) to
continue. It's written to be self-contained.

---

## Copy-paste prompt

> You're picking up **Phase 1.x** of the Trinity Plumbing ↔ Housecall Pro
> integration (Next.js 14 + TypeScript + Supabase + Vitest, deployed on Vercel).
> **Phase 1 is complete and committed on `main`** (34/34 tests, clean build).
> Do NOT rebuild it.
>
> **Read these first, in order:**
> 1. `.superpowers/sdd/progress.md` — the build ledger: every task, commit, and
>    decision, plus the Task 0 live-API findings.
> 2. `docs/PHASE-1.x-BACKLOG.md` — the prioritized follow-up list (start at the
>    "Confirmed by Task 0" section).
> 3. `docs/GO-LIVE-RUNBOOK.md` — credential-gated deploy steps.
> 4. `docs/superpowers/plans/2026-07-23-housecall-pro-phase1-foundation.md` — the
>    original plan (for architecture/interfaces).
>
> **Do the work in this priority order** (each is independent; confirm scope with
> me before large ones):
> 1. **Geocoding for the Geographic Scheduling Assistant (highest value).** HCP
>    addresses have no lat/lng, so the geo module currently produces nothing on
>    real data. Add a geocoding step (street/city/state/zip → lat/lng, cached)
>    that populates `customers.lat/lng` and `jobs.service_address_lat/lng` during
>    sync. Pick a geocoder (US Census Geocoder is free/no-key; Google needs a
>    key) — ask me which.
> 2. **Tests for the corrected estimate/invoice mappers** in
>    `src/lib/sync/__tests__/mappers.test.ts` (mapEstimate: `work_status`→status,
>    `options[0].total_amount`→amount_cents; mapInvoice: `amount`→amount_cents).
> 3. **Redefine the dashboard `openEstimates` metric** — real estimates use
>    `work_status`, not `status: "open"`; likely key off `options[].approval_status`.
> 4. **Incremental (cursor-based) cron** — full resync of ~3k jobs / ~2.9k
>    invoices every 15 min is heavy. Check if the list endpoints support an
>    `updated_after` filter; if so add a `sync_cursors` table + incremental sync.
> 5. **Estimate/invoice → job linkage** — derive `estimates.job_id`/`invoices.job_id`
>    during job sync (job holds `original_estimate_id` + `invoice_number`).
> 6. **Provisioning** (needs my credentials): Supabase `db push`, Vercel deploy,
>    webhook subscription — follow `docs/GO-LIVE-RUNBOOK.md`. Also confirm the
>    webhook `resource` value (singular vs plural) and full-vs-delta payload from
>    the HCP dashboard webhook docs, then harden the sync accordingly.
>
> **Working agreement / cost:** the last session cost ~$210, mostly from
> per-task review subagents and an Opus final review. Prefer a **lean approach**:
> implement directly, run tests, commit per change; only spin up a review
> subagent for genuinely risky code (crypto, money math, migrations). Use cheap
> models (Haiku/Sonnet) for implementation and reviews; reserve Opus for the
> final gate only if needed. TDD throughout (Vitest).
>
> **Environment gotchas that will bite you (all real, all confirmed):**
> - **GateGuard hook** fact-forces every Bash and file write: it blocks the first
>   attempt and demands you state facts (callers, existing-file check, data I/O,
>   the user instruction) — then you retry the identical call and it passes.
>   Budget for the retry; keep the facts terse.
> - **config-protection hook** blocks editing `.eslintrc.json` and similar config
>   — fix the source to satisfy the linter, don't weaken config.
> - **Strict lint fails the build** on `@typescript-eslint/no-explicit-any` and
>   unused vars (test files included). Type mocks properly; no `any`.
> - **Vitest 4**: `vi.fn().mockImplementation(() => ({...}))` can't be `new`-ed —
>   use `function () { return {...} }` for mocked constructors.
> - **Vite resolves import paths at transform time**, so a module referenced by a
>   test must exist on disk even if `vi.mock`'d — build dependencies before
>   dependents.
> - Windows + Git Bash; the `LF→CRLF` git warnings are harmless.
>
> **Credentials:** `.env.local` (git-ignored) holds a working `HOUSECALL_API_KEY`.
> Supabase/Vercel are not provisioned yet. The throwaway `scripts/verify-hcp-api.mjs`
> is untracked — re-run it (`set -a; source .env.local; set +a; node scripts/verify-hcp-api.mjs`)
> to inspect live payloads.
>
> The repo is local-only on `main` (no remote). Start by reading the four files
> above, then propose an ordered plan for items 1–5 and wait for my go-ahead.

---

*Generated at the end of the Phase 1 build session (2026-07-24).*
