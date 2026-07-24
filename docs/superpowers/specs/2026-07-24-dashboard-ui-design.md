# Design: Operations Dashboard UI

**Date:** 2026-07-24
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** Redesign the **existing** dashboard (8 metric cards + Today's Schedule
+ Technician Workload panels) into a polished, responsive Tailwind UI. **No new
metrics, no data-layer changes, no nav shell.**

---

## Context

The dashboard (`src/app/dashboard/`) currently renders bare inline-styled server
components: 8 `MetricCard`s in a flex-wrap and two unstyled `<table>`s
(`TodaySchedulePanel`, `TechnicianWorkloadPanel`). The project has **no CSS
framework** — plain inline `style` objects. Geist Sans/Mono are already wired via
`next/font` in `src/app/layout.tsx`; `globals.css` is create-next-app
boilerplate.

Data comes from `getDashboardSnapshot()` (`src/lib/dashboard/queries.ts`), which
after recent work exposes: `jobsInProgress`, `emergencyCalls`, `commercialJobs`,
`openEstimates`, `upcomingEstimates`, `pendingInvoices`,
`revenueBookedThisWeekCents`, `revenueScheduledNextWeekCents`,
`todaySchedule[]` (id, scheduledStart, customerName, technicianName, zone,
compass, miles, driveMinutes), and `technicianWorkload[]` (technicianId,
technicianName, jobCount, scheduledHours).

### Decisions locked during brainstorming
1. **Styling:** Tailwind CSS (added to the project).
2. **Users/device:** Both dispatcher (Ellah) and owner; **responsive** desktop →
   tablet/phone (field use). Mobile-first.
3. **Scope:** Polish the current 8 cards + 2 panels only.
4. **Dark mode:** Deferred (Tailwind `dark:` left available via `class` strategy).
5. **Brand color:** Deep steel-blue placeholder token; swap for Trinity's real
   brand color later (single token change).

---

## 1. Aesthetic direction

Calm, trustworthy operations dashboard — utilitarian but modern; dense without
clutter.

- **Palette (Tailwind theme tokens):**
  - `brand` — deep steel-blue (headers, accents, focus rings). Placeholder;
    swap for the real brand color.
  - `slate` neutral scale — text, borders, surfaces.
  - Semantic: `danger` (red) = emergency/urgent, `warn` (amber) = needs
    attention (pending), `success` (green) = revenue/positive, `info` (blue) =
    scheduled.
- **Type:** Geist Sans for UI, **Geist Mono for numeric values** so figures align
  in cards and tables (both fonts already loaded).
- Soft rounded cards (`rounded-xl`), hairline borders (`border-slate-200`), a
  subtle shadow on elevated surfaces, generous whitespace.
- Light theme only (dark deferred).

## 2. Layout (mobile-first, responsive)

- **Page header (`PageHeader`):** "Trinity Plumbing — Operations", today's date,
  and an "as of <time>" freshness stamp (server render time).
- **KPI grid:** the 8 cards in a responsive grid — `grid-cols-1` → `sm:grid-cols-2`
  → `xl:grid-cols-4`. Grouped under three subtle section labels so both audiences
  scan fast:
  - *Field ops:* Jobs in Progress · Emergency Calls · Commercial Jobs
  - *Pipeline:* Open Estimates · Upcoming Estimates · Pending Invoices
  - *Revenue:* Booked (This Week) · Scheduled (Next Week)
- **Panels:** below the KPIs. Desktop: `lg:grid-cols-3` with Today's Schedule
  spanning 2 columns and Technician Workload 1. Stacked on mobile.
- No horizontal page scroll at any width down to ~360px. Wide tables scroll
  inside their own container, not the page.

## 3. Components (all remain server components — no client JS)

New primitives under `src/app/dashboard/components/`:
- **`Card`** — surface wrapper (border, radius, padding, shadow).
- **`StatCard`** — replaces `MetricCard`: label, big Geist-Mono value, optional
  semantic tint + caption. `tone?: "default" | "danger" | "warn" | "success"`.
  Emergency uses `danger` **plus** an icon/text label — never color alone (a11y).
  Keeps a compatible prop surface (`label`, `value`, and a `tone` replacing the
  old boolean `highlight`).
- **`ZoneBadge`** — colored pill per dispatch zone with a fixed zone→color map
  (Albany Zone, North Route, Vermont Route, Southern Berkshire Route, Extended,
  Outside/Unknown). Unknown zones get a neutral pill.
- **`SectionHeading`** — small uppercase group label for the KPI bands.
- **`EmptyState`** — shared empty-panel message.

Rework existing:
- **`TodaySchedulePanel`** — semantic `<table>` on `md+` (Time · Customer · Tech ·
  Zone · Miles · Drive · Dir), collapsing to stacked **cards** on mobile. Zone via
  `ZoneBadge`; `miles`/`driveMinutes` shown (`—` when null); time formatted from
  `scheduledStart`. Empty state.
- **`TechnicianWorkloadPanel`** — one row per tech: name, job count, scheduled
  hours, and a small horizontal **load bar** (width ∝ hours relative to the
  busiest tech). "Unassigned" bucket styled distinctly. Empty state.

## 4. Tailwind setup

- Add dev deps: `tailwindcss`, `postcss`, `autoprefixer`. `postcss.config.js` +
  `tailwind.config.ts` with `content: ["./src/**/*.{ts,tsx}"]`, `darkMode: "class"`,
  and a `theme.extend.colors` mapping (`brand`, `danger`, `warn`, `success`,
  `info`). Reference the existing Geist CSS variables in `theme.extend.fontFamily`
  (`sans`, `mono`).
- Replace `globals.css` boilerplate with the three `@tailwind` directives plus a
  minimal base layer (background, default text color). Keep the font-variable
  wiring in `layout.tsx`.
- Fix `layout.tsx` metadata title/description (currently "Create Next App").

## 5. Data & behavior

- **No changes to `queries.ts` or the data layer.** UI consumes the existing
  `DashboardSnapshot`. `page.tsx` stays a server component with `force-dynamic`.
- `page.tsx` becomes composition only: `PageHeader` + three grouped KPI bands +
  the two panels.

## 6. Testing & accessibility

- Update `MetricCard.test.tsx` → `StatCard` (new markup/props). Add light RTL
  render tests for `TodaySchedulePanel` (renders a row; renders empty state) and
  `TechnicianWorkloadPanel` (renders a tech row + hours; empty state), and a
  `ZoneBadge` test (known vs unknown zone). Assert real rendered content, not
  styles.
- `npm run lint` and `npm run build` stay green (Tailwind must compile in the
  build).
- **A11y:** semantic table with `<th scope>`; `aria-label`s on panels; WCAG-AA
  contrast on all text/badges; emergency state conveyed by icon+text, not color
  alone; keyboard focus-visible rings; responsive to ~360px.

---

## Out of scope (later)
- Navigation / app shell (header nav, sidebar, multi-page structure).
- New roadmap dashboard elements (the other list.md 10-card items, a schedule
  map, charts beyond the workload bar).
- Dark mode (infrastructure left in place via `darkMode: "class"`).
- Any metric/query/data changes.

## Risks & notes
- **Tailwind + Next 14 App Router** integration is standard; the only real work is
  config + replacing `globals.css`. Verify the production build purges/compiles
  correctly (content globs must cover `src/**`).
- **Brand color** is a placeholder token — one-line swap when the real color is
  known.
- Numeric alignment depends on Geist Mono being applied to values; ensure the
  `mono` font token maps to the existing `--font-geist-mono` variable.
