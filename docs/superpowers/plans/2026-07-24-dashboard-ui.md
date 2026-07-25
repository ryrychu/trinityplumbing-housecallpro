# Operations Dashboard UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the existing dashboard (8 metric cards + Today's Schedule + Technician Workload panels) into a polished, responsive Tailwind UI — no new metrics, no data-layer changes.

**Architecture:** Next.js 14 App Router, all server components (no client JS). Introduce Tailwind CSS v3 as the styling system, add a small set of presentational primitives (`Card`, `StatCard`, `ZoneBadge`, `SectionHeading`, `EmptyState`), and recompose `page.tsx` into a header + three grouped KPI bands + a two-panel grid. The data layer (`getDashboardSnapshot`) is untouched.

**Tech Stack:** Next 14, React 18, TypeScript, **Tailwind CSS v3** (+ postcss, autoprefixer), Vitest 4 + React Testing Library (already present), Geist fonts (already wired).

**Spec:** `docs/superpowers/specs/2026-07-24-dashboard-ui-design.md`

## Global Constraints

- **Tailwind v3 specifically** (`tailwindcss@^3.4.0`) — this plan uses the `tailwind.config.ts` + `@tailwind base/components/utilities` directive model. Do NOT install Tailwind v4 (its CSS-first `@import "tailwindcss"` model is incompatible with the config below).
- **Tailwind can only see class strings that appear literally in source.** Never build a class name by string concatenation at runtime. Zone/tone → class maps must hold complete literal class strings (they do below).
- **All components stay server components** — no `"use client"`, no hooks, no event handlers.
- **Strict lint:** no `@typescript-eslint/no-explicit-any`, no unused vars (test files included).
- **Tests assert rendered content/roles, not CSS classes** (prefer an accessible name over a class assertion).
- **No data-layer changes.** `src/lib/dashboard/queries.ts` and `DashboardSnapshot` are read-only here.
- **Every semantic color shade referenced in a component must exist in `tailwind.config.ts`** (see Task 1's theme).
- Test command: `npx vitest run <path>`. Full suite: `npm test`. Lint: `npm run lint`. Build: `npm run build`. **Never run `npm run build` while `npm run dev` is running.**
- Windows + Git Bash; `LF→CRLF` warnings are harmless. Commit after each task.

---

## File Structure

**Create:**
- `tailwind.config.ts`, `postcss.config.js`
- `src/app/dashboard/components/Card.tsx`
- `src/app/dashboard/components/SectionHeading.tsx`
- `src/app/dashboard/components/EmptyState.tsx`
- `src/app/dashboard/components/ZoneBadge.tsx` + `__tests__/ZoneBadge.test.tsx`
- `src/app/dashboard/components/StatCard.tsx` + `__tests__/StatCard.test.tsx`
- `src/app/dashboard/components/__tests__/TodaySchedulePanel.test.tsx`
- `src/app/dashboard/components/__tests__/TechnicianWorkloadPanel.test.tsx`

**Modify:**
- `src/app/globals.css` (replace boilerplate with Tailwind directives + base)
- `src/app/layout.tsx` (metadata title/description)
- `src/app/dashboard/components/TodaySchedulePanel.tsx` (Tailwind redesign)
- `src/app/dashboard/components/TechnicianWorkloadPanel.tsx` (Tailwind redesign)
- `src/app/dashboard/page.tsx` (recomposition)
- `package.json` (dev deps via install)

**Delete:**
- `src/app/dashboard/components/MetricCard.tsx` and `src/app/dashboard/__tests__/MetricCard.test.tsx` (replaced by `StatCard`) — in Task 6, after `page.tsx` stops importing it.

---

## Task 1: Add Tailwind CSS

**Files:**
- Create: `tailwind.config.ts`, `postcss.config.js`
- Modify: `src/app/globals.css`, `src/app/layout.tsx`, `package.json`

**Interfaces:**
- Produces: Tailwind theme tokens `brand`, `danger`, `warn`, `success`, `info` (each with `50`/`600`, `brand` also `700`), font families `sans`/`mono` bound to the Geist CSS variables. Consumed by all later tasks.

- [ ] **Step 1: Install Tailwind v3 + peers**

Confirm `npm run dev` is not running, then run:
```bash
npm install -D tailwindcss@^3.4.0 postcss autoprefixer
```
Expected: `package.json` devDependencies gain the three packages; a lockfile update.

- [ ] **Step 2: Create `postcss.config.js`**

```js
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 3: Create `tailwind.config.ts`**

```ts
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Placeholder brand (deep steel-blue) — swap for Trinity's real color.
        brand: { DEFAULT: "#1e3a5f", 50: "#eef2f7", 600: "#1e3a5f", 700: "#152b47" },
        danger: { DEFAULT: "#c0392b", 50: "#fdf1f0", 600: "#c0392b" },
        warn: { DEFAULT: "#b7791f", 50: "#fdf6e9", 600: "#b7791f" },
        success: { DEFAULT: "#1f8a5b", 50: "#eefaf3", 600: "#1f8a5b" },
        info: { DEFAULT: "#2563eb", 50: "#eff4ff", 600: "#2563eb" },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
```

- [ ] **Step 4: Replace `src/app/globals.css`**

Replace the entire file with:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  html,
  body {
    max-width: 100vw;
    overflow-x: hidden;
  }
  body {
    @apply bg-slate-50 font-sans text-slate-900 antialiased;
  }
}
```

- [ ] **Step 5: Fix `layout.tsx` metadata**

In `src/app/layout.tsx`, replace the `metadata` object:
```ts
export const metadata: Metadata = {
  title: "Trinity Plumbing — Operations",
  description: "Operations dashboard for Trinity Plumbing & Drains.",
};
```

- [ ] **Step 6: Verify the build compiles Tailwind**

Run: `npm run build`
Expected: PASS. The existing (still inline-styled) dashboard renders; Tailwind's base layer now applies the slate background. No route errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tailwind.config.ts postcss.config.js src/app/globals.css src/app/layout.tsx
git commit -m "feat(ui): add Tailwind CSS v3 with brand/semantic theme tokens"
```

---

## Task 2: Presentational primitives (Card, SectionHeading, EmptyState, ZoneBadge)

**Files:**
- Create: `src/app/dashboard/components/Card.tsx`, `SectionHeading.tsx`, `EmptyState.tsx`, `ZoneBadge.tsx`
- Test: `src/app/dashboard/components/__tests__/ZoneBadge.test.tsx`

**Interfaces:**
- Produces:
  - `Card({ children, className? })`
  - `SectionHeading({ children })`
  - `EmptyState({ children })`
  - `ZoneBadge({ zone: string })`

- [ ] **Step 1: Write the failing ZoneBadge test**

Create `src/app/dashboard/components/__tests__/ZoneBadge.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ZoneBadge } from "../ZoneBadge";

describe("ZoneBadge", () => {
  it("renders the zone name", () => {
    render(<ZoneBadge zone="Albany Zone" />);
    expect(screen.getByText("Albany Zone")).toBeInTheDocument();
  });

  it("renders an unknown zone with the neutral fallback (still shows the text)", () => {
    render(<ZoneBadge zone="Somewhere Else" />);
    expect(screen.getByText("Somewhere Else")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/dashboard/components/__tests__/ZoneBadge.test.tsx`
Expected: FAIL — module `../ZoneBadge` not found.

- [ ] **Step 3: Create the four primitives**

`src/app/dashboard/components/Card.tsx`:
```tsx
export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
}
```

`src/app/dashboard/components/SectionHeading.tsx`:
```tsx
export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</h2>;
}
```

`src/app/dashboard/components/EmptyState.tsx`:
```tsx
export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-10 text-center text-sm text-slate-400">{children}</p>;
}
```

`src/app/dashboard/components/ZoneBadge.tsx` (literal class strings so Tailwind sees them):
```tsx
// Full literal class strings per zone — Tailwind's content scanner only keeps
// classes it finds verbatim in source, so these must not be composed at runtime.
const ZONE_STYLES: Record<string, string> = {
  "Albany Zone": "bg-brand-50 text-brand-700",
  "North Route": "bg-info-50 text-info-600",
  "Vermont Route": "bg-success-50 text-success-600",
  "Southern Berkshire Route": "bg-warn-50 text-warn-600",
  "Extended Service Area": "bg-slate-100 text-slate-600",
};
const UNKNOWN_STYLE = "bg-slate-100 text-slate-500";

export function ZoneBadge({ zone }: { zone: string }) {
  const style = ZONE_STYLES[zone] ?? UNKNOWN_STYLE;
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {zone}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/dashboard/components/__tests__/ZoneBadge.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/components/Card.tsx src/app/dashboard/components/SectionHeading.tsx src/app/dashboard/components/EmptyState.tsx src/app/dashboard/components/ZoneBadge.tsx src/app/dashboard/components/__tests__/ZoneBadge.test.tsx
git commit -m "feat(ui): Card, SectionHeading, EmptyState, ZoneBadge primitives"
```

---

## Task 3: StatCard (replaces MetricCard)

**Files:**
- Create: `src/app/dashboard/components/StatCard.tsx`
- Test: `src/app/dashboard/components/__tests__/StatCard.test.tsx`

**Interfaces:**
- Consumes: `Card` (Task 2).
- Produces: `StatCard({ label, value, tone?, caption? })` where `tone: "default" | "danger" | "warn" | "success"` (default `"default"`). Consumed by `page.tsx` (Task 6).

Note: this task only ADDS `StatCard`; `MetricCard` and its test are removed in Task 6 (after `page.tsx` stops importing `MetricCard`), so the build stays green here.

- [ ] **Step 1: Write the failing test**

Create `src/app/dashboard/components/__tests__/StatCard.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatCard } from "../StatCard";

describe("StatCard", () => {
  it("renders label and value", () => {
    render(<StatCard label="Jobs in Progress" value={4} />);
    expect(screen.getByText("Jobs in Progress")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("shows an accessible attention icon when tone is danger", () => {
    render(<StatCard label="Emergency Calls" value={2} tone="danger" />);
    expect(screen.getByLabelText("Attention")).toBeInTheDocument();
  });

  it("does not show the attention icon for the default tone", () => {
    render(<StatCard label="Commercial Jobs" value={0} />);
    expect(screen.queryByLabelText("Attention")).not.toBeInTheDocument();
  });

  it("renders an optional caption", () => {
    render(<StatCard label="Open Estimates" value={5} caption="awaiting response" />);
    expect(screen.getByText("awaiting response")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/dashboard/components/__tests__/StatCard.test.tsx`
Expected: FAIL — module `../StatCard` not found.

- [ ] **Step 3: Implement**

`src/app/dashboard/components/StatCard.tsx`:
```tsx
import { Card } from "./Card";

type Tone = "default" | "danger" | "warn" | "success";

// Literal per-tone value colors (Tailwind must see them verbatim).
const VALUE_TONE: Record<Tone, string> = {
  default: "text-slate-900",
  danger: "text-danger-600",
  warn: "text-warn-600",
  success: "text-success-600",
};

export function StatCard({
  label,
  value,
  tone = "default",
  caption,
}: {
  label: string;
  value: number | string;
  tone?: Tone;
  caption?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-500">{label}</span>
        {tone === "danger" && (
          <svg
            role="img"
            aria-label="Attention"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4 text-danger-600"
          >
            <path
              fillRule="evenodd"
              d="M8.257 3.1c.765-1.36 2.72-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.492-1.646-1.743-2.98l5.58-9.92zM10 7a1 1 0 00-1 1v2a1 1 0 002 0V8a1 1 0 00-1-1zm0 6a1 1 0 100 2 1 1 0 000-2z"
              clipRule="evenodd"
            />
          </svg>
        )}
      </div>
      <div className={`mt-1 font-mono text-3xl font-bold ${VALUE_TONE[tone]}`}>{value}</div>
      {caption && <div className="mt-1 text-xs text-slate-400">{caption}</div>}
    </Card>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/dashboard/components/__tests__/StatCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/components/StatCard.tsx src/app/dashboard/components/__tests__/StatCard.test.tsx
git commit -m "feat(ui): StatCard with semantic tones and accessible emergency icon"
```

---

## Task 4: Redesign TodaySchedulePanel

**Files:**
- Modify: `src/app/dashboard/components/TodaySchedulePanel.tsx`
- Test: `src/app/dashboard/components/__tests__/TodaySchedulePanel.test.tsx`

**Interfaces:**
- Consumes: `Card`, `ZoneBadge`, `EmptyState` (Task 2). Same prop signature as today (`{ jobs: DashboardSnapshot["todaySchedule"] }`), so `page.tsx` keeps working.

- [ ] **Step 1: Write the test**

Create `src/app/dashboard/components/__tests__/TodaySchedulePanel.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TodaySchedulePanel } from "../TodaySchedulePanel";

const job = {
  id: "j1",
  scheduledStart: "2026-07-24T14:00:00Z",
  customerName: "Jane Doe",
  technicianName: "Sam Tech",
  zone: "Albany Zone",
  compass: "N",
  miles: 12,
  driveMinutes: 23,
};

describe("TodaySchedulePanel", () => {
  it("renders a job's customer, tech, and zone", () => {
    render(<TodaySchedulePanel jobs={[job]} />);
    // Customer/tech/zone appear once per layout (desktop table + mobile list),
    // so use getAllByText and assert at least one match.
    expect(screen.getAllByText("Jane Doe").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sam Tech").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Albany Zone").length).toBeGreaterThan(0);
  });

  it("renders the empty state when there are no jobs", () => {
    render(<TodaySchedulePanel jobs={[]} />);
    expect(screen.getByText("No jobs scheduled today.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test against the current component**

Run: `npx vitest run src/app/dashboard/components/__tests__/TodaySchedulePanel.test.tsx`
This is a **visual refactor guarded by content tests**, not a new-behavior TDD cycle: the current single-table component already satisfies both assertions (it renders each value once, and `getAllByText(...).length > 0` holds; it has the same empty-state text). So expect PASS here. The point of the test is to guarantee the redesign in Step 3 preserves content and the empty state — run it again after Step 3 and confirm it still passes.

- [ ] **Step 3: Redesign the component**

Replace `src/app/dashboard/components/TodaySchedulePanel.tsx` with:
```tsx
import type { DashboardSnapshot } from "@/lib/dashboard/queries";
import { Card } from "./Card";
import { ZoneBadge } from "./ZoneBadge";
import { EmptyState } from "./EmptyState";

function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
}

export function TodaySchedulePanel({ jobs }: { jobs: DashboardSnapshot["todaySchedule"] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-700">Today&apos;s Schedule</h3>
      </div>

      {jobs.length === 0 ? (
        <EmptyState>No jobs scheduled today.</EmptyState>
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th scope="col" className="px-4 py-2 font-medium">Time</th>
                  <th scope="col" className="px-4 py-2 font-medium">Customer</th>
                  <th scope="col" className="px-4 py-2 font-medium">Tech</th>
                  <th scope="col" className="px-4 py-2 font-medium">Zone</th>
                  <th scope="col" className="px-4 py-2 font-medium">Dir</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Miles</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Drive</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b border-slate-50 last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-slate-700">{fmtTime(j.scheduledStart)}</td>
                    <td className="px-4 py-2 text-slate-800">{j.customerName ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-600">{j.technicianName ?? "Unassigned"}</td>
                    <td className="px-4 py-2"><ZoneBadge zone={j.zone} /></td>
                    <td className="px-4 py-2 text-slate-500">{j.compass || "—"}</td>
                    <td className="px-4 py-2 text-right font-mono text-slate-700">{j.miles ?? "—"}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right font-mono text-slate-700">
                      {j.driveMinutes != null ? `${j.driveMinutes} min` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile stacked cards */}
          <ul className="divide-y divide-slate-100 md:hidden">
            {jobs.map((j) => (
              <li key={j.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-slate-700">{fmtTime(j.scheduledStart)}</span>
                  <ZoneBadge zone={j.zone} />
                </div>
                <div className="mt-1 text-sm font-medium text-slate-800">{j.customerName ?? "—"}</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {j.technicianName ?? "Unassigned"}
                  {j.miles != null && ` · ${j.miles} mi`}
                  {j.driveMinutes != null && ` · ${j.driveMinutes} min`}
                  {j.compass && ` · ${j.compass}`}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/app/dashboard/components/__tests__/TodaySchedulePanel.test.tsx`
Expected: PASS (content + empty state).
Then `npm run build` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/components/TodaySchedulePanel.tsx src/app/dashboard/components/__tests__/TodaySchedulePanel.test.tsx
git commit -m "feat(ui): redesign Today's Schedule (responsive table + mobile cards, zone badges)"
```

---

## Task 5: Redesign TechnicianWorkloadPanel

**Files:**
- Modify: `src/app/dashboard/components/TechnicianWorkloadPanel.tsx`
- Test: `src/app/dashboard/components/__tests__/TechnicianWorkloadPanel.test.tsx`

**Interfaces:**
- Consumes: `Card`, `EmptyState` (Task 2). Same prop signature (`{ rows: DashboardSnapshot["technicianWorkload"] }`).

- [ ] **Step 1: Write the test**

Create `src/app/dashboard/components/__tests__/TechnicianWorkloadPanel.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TechnicianWorkloadPanel } from "../TechnicianWorkloadPanel";

describe("TechnicianWorkloadPanel", () => {
  it("renders a technician row with combined job count and hours", () => {
    render(
      <TechnicianWorkloadPanel
        rows={[{ technicianId: "t1", technicianName: "Sam Tech", jobCount: 3, scheduledHours: 6.5 }]}
      />
    );
    expect(screen.getByText("Sam Tech")).toBeInTheDocument();
    expect(screen.getByText(/3 jobs · 6\.5h/)).toBeInTheDocument();
  });

  it("labels the unassigned bucket", () => {
    render(
      <TechnicianWorkloadPanel
        rows={[{ technicianId: null, technicianName: "Unassigned", jobCount: 1, scheduledHours: 2 }]}
      />
    );
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("renders the empty state when there are no rows", () => {
    render(<TechnicianWorkloadPanel rows={[]} />);
    expect(screen.getByText("No assigned work today.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/dashboard/components/__tests__/TechnicianWorkloadPanel.test.tsx`
Expected: the combined "3 jobs · 6.5h" assertion FAILS against the current component (it renders `3` and `6.5` in separate `<td>`s, not one combined string). Genuine RED for the new format.

- [ ] **Step 3: Redesign the component**

Replace `src/app/dashboard/components/TechnicianWorkloadPanel.tsx` with:
```tsx
import type { DashboardSnapshot } from "@/lib/dashboard/queries";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";

export function TechnicianWorkloadPanel({ rows }: { rows: DashboardSnapshot["technicianWorkload"] }) {
  // Scale each load bar against the busiest tech; guard against divide-by-zero.
  const maxHours = Math.max(1, ...rows.map((r) => r.scheduledHours));

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-700">Technician Workload · Today</h3>
      </div>

      {rows.length === 0 ? (
        <EmptyState>No assigned work today.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => {
            const isUnassigned = r.technicianId === null;
            const pct = Math.round((r.scheduledHours / maxHours) * 100);
            return (
              <li key={r.technicianId ?? "unassigned"} className="px-4 py-3">
                <div className="flex items-center justify-between text-sm">
                  <span className={isUnassigned ? "italic text-slate-400" : "font-medium text-slate-800"}>
                    {r.technicianName ?? "Unassigned"}
                  </span>
                  <span className="font-mono text-slate-500">
                    {r.jobCount} jobs · {r.scheduledHours}h
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100">
                  <div
                    className={`h-1.5 rounded-full ${isUnassigned ? "bg-slate-300" : "bg-brand-600"}`}
                    style={{ width: `${pct}%` }}
                    aria-hidden="true"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/app/dashboard/components/__tests__/TechnicianWorkloadPanel.test.tsx`
Expected: PASS.
Then `npm run build` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/components/TechnicianWorkloadPanel.tsx src/app/dashboard/components/__tests__/TechnicianWorkloadPanel.test.tsx
git commit -m "feat(ui): redesign Technician Workload with load bars and unassigned bucket"
```

---

## Task 6: Recompose the dashboard page

**Files:**
- Modify: `src/app/dashboard/page.tsx`
- Delete: `src/app/dashboard/components/MetricCard.tsx`, `src/app/dashboard/__tests__/MetricCard.test.tsx`

**Interfaces:**
- Consumes: `StatCard` (Task 3), `SectionHeading` (Task 2), `TodaySchedulePanel` (Task 4), `TechnicianWorkloadPanel` (Task 5).

- [ ] **Step 1: Rewrite `page.tsx`**

Replace `src/app/dashboard/page.tsx` with:
```tsx
import { getDashboardSnapshot } from "@/lib/dashboard/queries";
import { StatCard } from "./components/StatCard";
import { SectionHeading } from "./components/SectionHeading";
import { TodaySchedulePanel } from "./components/TodaySchedulePanel";
import { TechnicianWorkloadPanel } from "./components/TechnicianWorkloadPanel";

export const dynamic = "force-dynamic";

const money = (cents: number) => `$${(cents / 100).toLocaleString()}`;

export default async function DashboardPage() {
  const snapshot = await getDashboardSnapshot();
  const now = new Date();

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">Trinity Plumbing — Operations</h1>
        <p className="mt-1 text-sm text-slate-500">
          {now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          {" · as of "}
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      </header>

      <section className="mb-6">
        <SectionHeading>Field Ops</SectionHeading>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard label="Jobs in Progress" value={snapshot.jobsInProgress} />
          <StatCard
            label="Emergency Calls"
            value={snapshot.emergencyCalls}
            tone={snapshot.emergencyCalls > 0 ? "danger" : "default"}
          />
          <StatCard label="Commercial Jobs" value={snapshot.commercialJobs} />
        </div>
      </section>

      <section className="mb-6">
        <SectionHeading>Pipeline</SectionHeading>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard label="Open Estimates" value={snapshot.openEstimates} />
          <StatCard label="Upcoming Estimates" value={snapshot.upcomingEstimates} />
          <StatCard
            label="Pending Invoices"
            value={snapshot.pendingInvoices}
            tone={snapshot.pendingInvoices > 0 ? "warn" : "default"}
          />
        </div>
      </section>

      <section className="mb-8">
        <SectionHeading>Revenue</SectionHeading>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <StatCard label="Revenue Booked · This Week" value={money(snapshot.revenueBookedThisWeekCents)} tone="success" />
          <StatCard label="Revenue Scheduled · Next Week" value={money(snapshot.revenueScheduledNextWeekCents)} tone="success" />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TodaySchedulePanel jobs={snapshot.todaySchedule} />
        </div>
        <div>
          <TechnicianWorkloadPanel rows={snapshot.technicianWorkload} />
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Delete the obsolete MetricCard + its test**

```bash
git rm src/app/dashboard/components/MetricCard.tsx src/app/dashboard/__tests__/MetricCard.test.tsx
```

- [ ] **Step 3: Build + full suite**

Run: `npm run build`
Expected: PASS, `/dashboard` route present, no reference to the deleted `MetricCard`.
Run: `npm test`
Expected: all pass (the removed `MetricCard.test` is gone; `StatCard`/`ZoneBadge`/panel tests pass).

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/page.tsx
git commit -m "feat(ui): recompose dashboard — header, grouped KPI bands, panel grid; drop MetricCard"
```

---

## Task 7: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: ALL PASS.

- [ ] **Step 2: Lint + build**

Run: `npm run lint` then `npm run build` (confirm `npm run dev` is not running).
Expected: both clean; Tailwind compiles; `/dashboard` renders.

- [ ] **Step 3: Manual visual check**

Start `npm run dev`, open `/dashboard` at desktop width and at ~375px (dev-tools device toolbar). Confirm: grouped KPI bands, emergency card shows the attention icon when non-zero, Today's Schedule is a table on desktop and stacked cards on mobile with zone badges + miles/drive, Technician Workload shows load bars, and there is no horizontal page scroll on mobile. Stop the dev server when done.

- [ ] **Step 4 (optional): Update the handoff**

If tracking UI status in `docs/NEXT-SESSION-HANDOFF.md`, note the dashboard UI redesign shipped (Tailwind, responsive). Commit if changed.

---

## Self-Review

**Spec coverage:**
- Tailwind setup + tokens → Task 1 ✅
- Aesthetic (palette, Geist Mono values, cards) → Tasks 1–3 ✅
- Layout (header, grouped KPI bands, responsive grid, panel split) → Task 6 ✅
- Components (Card, StatCard, ZoneBadge, SectionHeading, EmptyState) → Tasks 2–3 ✅
- Today's Schedule responsive table→cards + distance/drive → Task 4 ✅
- Technician Workload load bars → Task 5 ✅
- No data changes → honored (queries.ts untouched) ✅
- Testing + a11y (semantic table `scope`, accessible emergency icon, empty states) → Tasks 2–6 ✅
- Dark mode deferred (infra via `darkMode: "class"`) → Task 1 ✅

**Placeholder scan:** No "TBD". Task 4 Step 2 is explicitly framed as a content-survival refactor (not a strict RED cycle) with reasoning, not a vague placeholder. All component code is complete.

**Type consistency:** `StatCard` `tone` union (`default|danger|warn|success`) matches its use in `page.tsx` (`"danger"`, `"warn"`, `"success"`). Panel prop types reuse `DashboardSnapshot["todaySchedule"]`/`["technicianWorkload"]` verbatim, so field names (`scheduledStart`, `customerName`, `technicianName`, `zone`, `compass`, `miles`, `driveMinutes`; `technicianId`, `technicianName`, `jobCount`, `scheduledHours`) match the data layer. `ZoneBadge` takes `zone: string`, fed by `j.zone`. Semantic color shades used in components (`brand-50/600/700`, `danger-600`, `warn-600`, `success-600`, `info-50/600`) all exist in Task 1's theme.
