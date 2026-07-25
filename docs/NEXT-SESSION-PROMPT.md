# Copy-paste prompt for a fresh Claude Code session

Paste everything in the block below into a new session started in this repo.

---

Continue the Trinity Plumbing ↔ Housecall Pro project (Next.js 14 + TypeScript +
Supabase + Vitest, deploying to Vercel). Repo:
`C:\Users\Ryan\Documents\claude-projects\trinity-housecallpro`, branch `main`.

**Two goals, in order:** (1) finish Phase 1 (the operational remainder), then
(2) implement the dashboard UI redesign. Do Goal 1 fully before starting Goal 2.

**Read first (current source of truth):**
- `docs/NEXT-SESSION-HANDOFF.md` — the bottom section "FINISH PHASE 1 —
  implemented (2026-07-24)" is current state.
- `docs/superpowers/plans/2026-07-24-finish-phase-1.md` — the Phase-1 completion
  plan. **Already built, reviewed, and merged to `main`. Do NOT re-implement it.**
- `docs/superpowers/specs/2026-07-24-dashboard-ui-design.md` and
  `docs/superpowers/plans/2026-07-24-dashboard-ui.md` — the UI work for Goal 2.

**Current state:** Phase 1 CODE is complete and merged to `main` — 105/105 tests,
lint + build clean. Shipped: Leads + Attachments sync, first-class Tags/Notes,
`*.deleted` delete handling, town-first geographic zones (46-town table),
dashboard's 4 new elements + Eastern-time date-scoped revenue. What's left for
Phase 1 is **operational only**.

## GOAL 1 — finish the Phase 1 operational steps

1. **Apply migration 0005** — `supabase db push`. This is **interactive** (asks
   for the DB password), so **I (the user) must run it** — guide me, then confirm
   the two new tables (`leads`, `attachments`) and four new columns
   (`jobs.tags/notes`, `customers.tags/notes`) exist. Until this runs, sync of
   leads/attachments/tags/notes has nowhere to write. (The dashboard renders
   without it — its queries use pre-existing columns.)
2. **Create the Supabase Storage bucket `hcp-attachments`**, then probe one real
   HCP attachment URL: find one (`select raw->'attachments' from jobs where
   raw->'attachments' != '[]' limit 1`) and `curl -I <url>`. If it returns the
   file without auth, re-hosting works; if it 401/403s, re-hosting silently
   no-ops (metadata still syncs) — record the outcome in the handoff.
3. **Live dashboard check** — after the migration, open `/dashboard`; confirm the
   8 cards + 2 panels render and "Revenue Booked (This Week)" is week-scoped (not
   the old all-time $145,708.30).
4. **Deploy** — `vercel --prod`. (Vercel↔GitHub push-to-deploy is not connected;
   `vercel --prod` uploads directly. The CLI is already authenticated.)
5. **Enable HCP webhooks** — in the HCP dashboard enable `invoice.*` (closes the
   ~21h invoice lag); delete handling now exists, so `customer.deleted` /
   `job.deleted` are also safe to enable.
6. **Remove `WEBHOOK_DEBUG=1`** from Vercel (it's a no-op now).

## GOAL 2 — dashboard UI redesign (only after Goal 1)

Execute `docs/superpowers/plans/2026-07-24-dashboard-ui.md` — 7 tasks, Tailwind
v3, responsive; redesigns the existing 8 cards + 2 panels into a polished UI with
no data-layer changes. **Run it INLINE (not subagent-driven) to control cost.**
The brand color is a placeholder steel-blue token — ask me for Trinity's real
brand color/logo before finalizing if I have one.

## Hard-won gotchas (do not rediscover these)

- **GateGuard hook** fact-forces the first Bash command and every Edit/Write: it
  blocks the first attempt and demands stated facts (callers, existing-file
  check, data I/O, the user instruction). State them in the message BEFORE the
  tool call. Disable with `ECC_GATEGUARD=off` if obstructive.
- **Supabase CLI login flaps** — if a `supabase` command 403s, run
  `npx supabase projects list`; if `wrvaenkyrfvbooogqhev` is absent, re-run
  `npx supabase login` as the owning account. `supabase db push` is interactive —
  the user runs it.
- **Never run `npm run build` while `npm run dev` is running** — the build kills
  the dev server. Kill dev first.
- **Strict lint fails the build** on `@typescript-eslint/no-explicit-any` and
  unused vars (test files included). Vitest 4: mocked constructors need
  `function () { return {...} }`, not an arrow.
- **Tailwind: install v3** (`tailwindcss@^3.4.0`), NOT v4 — the UI plan uses the
  `tailwind.config.ts` + `@tailwind` directive model.
- **PostgREST caps responses at 1000 rows** — paginate with `.range()`.
- **Cost discipline** — recent sessions ran high. Prefer inline work over
  subagent fan-out; avoid re-running full HCP syncs (steady-state incremental is
  ~2s); use targeted count queries (`Prefer: count=exact`, `Range: 0-0`).

## Facts

- Supabase project: `wrvaenkyrfvbooogqhev` ("Trinity Plumbing Housecall").
- Production: https://trinity-housecallpro.vercel.app
- `.env.local` holds all credentials (HCP API key, Supabase URL/keys,
  `CRON_SECRET`, `HOUSECALL_WEBHOOK_SECRET`).
- Real-time webhook sync is live; signing is
  `HMAC-SHA256(secret, "${api-timestamp}.${rawBody}")` in the `api-signature`
  header.

Start by reading `docs/NEXT-SESSION-HANDOFF.md`, then walk me through Goal 1 step
by step.

---
