# Copy-paste prompt for a fresh Claude Code session

Paste everything in the block below into a new session started in this repo.

---

Continue the Trinity Plumbing ↔ Housecall Pro project (Next.js 14 + TypeScript +
Supabase + Vitest, deployed on Vercel). Repo:
`C:\Users\Ryan\Documents\claude-projects\trinity-housecallpro`, branch `main`.

**Phase 1 is COMPLETE** — code and operations both. The remaining scope is one
thing: **the operations dashboard UI redesign.**

**Read first:**
- `docs/NEXT-SESSION-HANDOFF.md` — the bottom section
  "**PHASE 1 IS COMPLETE (2026-07-25)**" is the current state of truth.
- `docs/superpowers/specs/2026-07-24-dashboard-ui-design.md` — the spec.
- `docs/superpowers/plans/2026-07-24-dashboard-ui.md` — the plan you are executing.

## The task — dashboard UI redesign

Execute `docs/superpowers/plans/2026-07-24-dashboard-ui.md`: 7 tasks, Tailwind
v3, responsive. It restyles the existing 8 cards + 2 panels. **No data-layer
changes.**

- **Run it INLINE, not subagent-driven** — cost control. The previous session ran
  to ~$72 and repeated status-polling was a large share of that.
- **Install Tailwind v3** (`tailwindcss@^3.4.0`), NOT v4 — the plan uses the
  `tailwind.config.ts` + `@tailwind` directive model.
- **Ask me for Trinity's real brand colour/logo** before finalising; the plan
  currently uses a placeholder steel-blue token.
- While you're in there: the page `<title>` is still the Next.js default
  **"Create Next App"** — fix it.

## Current state

Phase 1 shipped and is live: Leads + Attachments sync, first-class Tags/Notes,
`*.deleted` delete handling, town-first geographic zones (46 towns), 8 dashboard
cards + 2 panels, Eastern-time date-scoped revenue. Migration 0005 applied.
436 attachments re-hosted (912 MB) into the private `hcp-attachments` bucket.
Webhooks (including `invoice.*`) are enabled and real-time sync is verified.
**112/112 tests, lint + build clean.** Local `main` == `origin/main`.

Production renders: Jobs in Progress 93 · Emergency Calls 0 · Commercial Jobs 0 ·
Open Estimates 453 · Upcoming Estimates 0 · Pending Invoices 25 · Revenue Booked
(This Week) $22,441.89 · Revenue Scheduled (Next Week) $4,334.84.

Emergency/Commercial reading 0 is **expected** — they depend on job tags, and only
22 of 3093 jobs are tagged (none emergency/commercial). Waiting on the tagging
convention; not a bug to fix in the UI work.

## Known follow-ups (NOT part of this task — don't get pulled in)

See the handoff's "Follow-ups" list. Summary: `rehost()` needs a
`storage_path` skip-guard and an `AbortSignal.timeout()`; both dashboard panels
should be re-verified on a weekday; `Upcoming Estimates = 0` is unconfirmed.

## Hard-won gotchas (do not rediscover these)

- **Check your CLI logins FIRST.** Both were on the wrong account last session and
  it was the single biggest time sink. Supabase permissions are per *organization*
  — `npx supabase projects list` must show `wrvaenkyrfvbooogqhev`. For Vercel,
  `npx vercel teams ls` must show `trinity-plumbing-and-drains`. **Never delete
  `.vercel/` and re-link while signed into the wrong account** — it creates a new
  project under the wrong team and orphans the production URL.
- **GateGuard** blocks the **first** Bash command and the **first Edit per file**
  regardless of facts already stated, then allows the retry — budget two attempts
  per new file. Disable with `ECC_GATEGUARD=off` if obstructive.
- **Never run `npm run build` while `npm run dev` is running** — the build kills
  the dev server. Check port 3000 first, kill dev, then build.
- **Strict lint fails the build** on `@typescript-eslint/no-explicit-any` and
  unused vars (test files included). Vitest 4: mocked constructors need
  `function () { return {...} }`, not an arrow.
- **PostgREST caps responses at 1000 rows** — paginate with `.range()`.
- Git Bash `/tmp` is NOT Windows `C:\tmp` — use the scratchpad path in both when
  piping between `curl` and `node`.
- Backgrounded `npm run dev` and `curl` **buffer their output**, so their log
  files stay 0 bytes. Poll the database for progress, never the process.

## Facts

- Supabase project: `wrvaenkyrfvbooogqhev` ("Trinity Plumbing Housecall"), org
  `nganepfbxyolejfbkwpz`. **Now on the Pro plan.**
- Production: https://trinity-housecallpro.vercel.app (Vercel team
  `trinity-plumbing-and-drains`; still on the Hobby plan — no upgrade needed, but
  Hobby is licensed non-commercial and this is a commercial dashboard, which
  remains the owner's open decision).
- `.env.local` holds all credentials.
- Real-time webhook signing is
  `HMAC-SHA256(secret, "${api-timestamp}.${rawBody}")` in the `api-signature`
  header.

Start by reading `docs/NEXT-SESSION-HANDOFF.md`, then execute the dashboard UI
plan.

---
