# Trinity Ops Mobile — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an installable, password-protected iPhone PWA at `/app/*` that renders all five modules (Today, Schedule, Customers, Money, Dispatch) from the existing Supabase mirror, opens instantly from cache, and always states how fresh its data is.

**Architecture:** A client-rendered shell under `/app/*` fetching JSON from `/api/app/*`. Route handlers reuse the existing query modules (`getDashboardSnapshot`, `getScheduleDays`, `findNearbyWork`) and the existing service-role Supabase client, so the service key never reaches the browser and no RLS work is required. Supabase Auth guards both trees via `src/middleware.ts`. A service worker precaches the shell and serves `/api/app/*` stale-while-revalidate.

**Tech Stack:** Next.js 14.2.35 (App Router), React 18, TypeScript, Tailwind, Supabase (`@supabase/supabase-js` + new `@supabase/ssr`), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-06-mobile-pwa-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Route prefix is `/app/*`.** `src/app/dispatch/page.tsx` already owns `/dispatch`. Never mount the mobile app at the root.
- **The service-role key never reaches the browser.** Only route handlers call `getSupabaseServerClient()`. Client components fetch `/api/app/*`.
- **Never `select("*")` and never an unbounded query.** PostgREST caps responses at 1000 rows and truncates silently — this already caused a real bug (19 jobs reported instead of 91). Use the existing `fetchAllRows` pattern or an explicit `.range()`.
- **Live status strings, always.** Jobs: `"in progress"` (SPACE, not underscore), `"complete rated"`, `"complete unrated"`, `"scheduled"`, `"needs scheduling"`, `"pro canceled"`, `"user canceled"`. Invoices: `paid` / `canceled` / `voided` / `open` — there is **no** `pending`. Test fixtures MUST use these exact strings; a suite once passed green while production read zero because fixtures encoded invented values.
- **Display status labels come from `scheduleStatus()`:** `Scheduled`, `En Route`, `In Progress`, `Completed`, `Needs Scheduling`, `Canceled`. `En Route` is derived from `raw.work_timestamps.on_my_way_at`.
- **Reuse, don't reimplement.** `isOpenEstimate`, `buildScheduleRow`, `getScheduleDays`, `findNearbyWork` already exist and are load-bearing for the Slack digest. A second implementation of any of them is how the dashboard and the digest silently drift apart.
- **Business timezone is `America/New_York`.** Use `localDateKey` / `dayRange` / `weekRange` from the existing modules; never format dates with the server's local zone.
- **Every `/api/app/*` JSON response carries `generated_at`** (ISO 8601, server time).
- **Dark + gold only.** `surface.*`, `ink.*`, `brand`, `danger`, `warn`, `success`, `info` from `tailwind.config.ts`. No new colors.
- **No status-change control anywhere.** HCP has no endpoint for it (`'/jobs/{id}'` is GET only). Status is read-only in Phase 1.
- **Tap targets ≥ 44×44 px** (iOS Human Interface minimum), primary actions within thumb reach at the bottom of the screen.
- **Phase 1 adds no database tables and no migrations.**
- Run `npm test` before every commit. Run `npm run build` before the final commit of each task that touches a page or route.

---

## File Structure

**New — auth and shared plumbing**
- `src/middleware.ts` — guards `/app/*` and `/api/app/*`
- `src/lib/mobile/session.ts` — `@supabase/ssr` server client, `requireUser()`
- `src/lib/mobile/envelope.ts` — `appJson()`, `appError()`, the `generated_at` contract
- `src/lib/mobile/phone.ts` — `normalizePhone()`, `formatPhone()`

**New — data access (server-only, thin wrappers over existing queries)**
- `src/lib/mobile/customers.ts` — `searchCustomers()`, `getCustomerDetail()`
- `src/lib/mobile/jobDetail.ts` — `getJobDetail()`
- `src/lib/mobile/money.ts` — `listOpenEstimates()`, `listUnpaidInvoices()`

**New — API routes**
- `src/app/api/app/today/route.ts`
- `src/app/api/app/schedule/route.ts`
- `src/app/api/app/jobs/[id]/route.ts`
- `src/app/api/app/customers/route.ts`
- `src/app/api/app/customers/[id]/route.ts`
- `src/app/api/app/money/route.ts`

**New — UI**
- `src/app/app/layout.tsx` — shell + tab bar
- `src/app/app/login/page.tsx`
- `src/app/app/today/page.tsx`
- `src/app/app/schedule/page.tsx`
- `src/app/app/jobs/[id]/page.tsx`
- `src/app/app/customers/page.tsx`
- `src/app/app/customers/[id]/page.tsx`
- `src/app/app/money/page.tsx`
- `src/app/app/dispatch/page.tsx`
- `src/components/mobile/TabBar.tsx`
- `src/components/mobile/StatusPill.tsx`
- `src/components/mobile/JobRow.tsx`
- `src/components/mobile/FreshnessStamp.tsx`
- `src/components/mobile/EmptyState.tsx`
- `src/components/mobile/useAppData.ts` — fetch hook: data, freshness, offline, refresh

**New — PWA assets**
- `public/manifest.webmanifest`
- `public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`
- `public/sw.js`
- `src/components/mobile/ServiceWorkerRegistrar.tsx`

**Modified**
- `package.json` — add `@supabase/ssr`
- `.env.example` — no new vars in Phase 1 (documented as such)
- `README.md` — install + auth section
- `docs/PHASE-1.x-BACKLOG.md` — strike the stale estimates item

---

## Task 1: PWA foundation — manifest, icons, viewport

**Files:**
- Create: `public/manifest.webmanifest`
- Create: `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/icon-maskable-512.png`, `public/icons/apple-touch-icon.png`
- Create: `src/app/app/layout.tsx`
- Test: `src/app/app/__tests__/manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `/app` route tree exists and is installable; `src/app/app/layout.tsx` exports the mobile `metadata` and `viewport`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/app/__tests__/manifest.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = () =>
  JSON.parse(readFileSync(path.join(root, "public/manifest.webmanifest"), "utf8"));

describe("PWA manifest", () => {
  // start_url and scope decide what the installed icon opens and what the
  // service worker may control. Getting scope wrong silently un-installs push
  // later, so both are pinned.
  it("scopes the installed app to /app", () => {
    const m = manifest();
    expect(m.start_url).toBe("/app/today");
    expect(m.scope).toBe("/app/");
    expect(m.display).toBe("standalone");
  });

  it("uses the Trinity dark surface so iOS does not flash white on launch", () => {
    const m = manifest();
    expect(m.background_color).toBe("#121212");
    expect(m.theme_color).toBe("#121212");
  });

  // iOS needs a real PNG apple-touch-icon; an SVG will not install.
  it("ships every icon file it declares", () => {
    for (const icon of manifest().icons) {
      const rel = icon.src.replace(/^\//, "");
      expect(existsSync(path.join(root, "public", rel.replace(/^public\//, "")))).toBe(true);
    }
    expect(existsSync(path.join(root, "public/icons/apple-touch-icon.png"))).toBe(true);
  });

  it("declares a maskable icon so Android does not letterbox it", () => {
    expect(manifest().icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/app/__tests__/manifest.test.ts`
Expected: FAIL — `ENOENT: no such file or directory ... public/manifest.webmanifest`

- [ ] **Step 3: Create the manifest**

```json
// public/manifest.webmanifest
{
  "name": "Trinity Plumbing — Operations",
  "short_name": "Trinity Ops",
  "description": "Schedule, customers, estimates and invoices for Trinity Plumbing & Drains.",
  "start_url": "/app/today",
  "scope": "/app/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#121212",
  "theme_color": "#121212",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 4: Produce the icon PNGs (manual asset step)**

This is an asset export, not code. `public/trinity-logo.svg` is a raster PNG inside an SVG wrapper (see the comment in `src/app/dashboard/page.tsx`), so export from the original logo artwork at these exact sizes onto a `#121212` background:

| File | Size | Notes |
|---|---|---|
| `public/icons/icon-192.png` | 192×192 | logo centred, small padding |
| `public/icons/icon-512.png` | 512×512 | same composition |
| `public/icons/icon-maskable-512.png` | 512×512 | logo inside the centre 80% safe zone — Android crops to a circle |
| `public/icons/apple-touch-icon.png` | 180×180 | **no transparency**; iOS composites transparent pixels onto black and the gold goes muddy |

- [ ] **Step 5: Create the mobile layout with iOS-correct viewport**

```tsx
// src/app/app/layout.tsx
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Trinity Ops",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Trinity Ops",
    // "black-translucent" would let content slide under the notch; the app is
    // a dark surface already, so plain black keeps the status bar legible.
    statusBarStyle: "black",
  },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#121212",
  // Required on iOS: without it the whole UI zooms when an input is focused,
  // and viewport-fit=cover is what makes safe-area insets available at all.
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-surface-page text-ink-primary">
      {children}
    </div>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/app/app/__tests__/manifest.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Verify the build**

Run: `npm run build`
Expected: compiles; `/app` appears in the route list.

- [ ] **Step 8: Commit**

```bash
git add public/manifest.webmanifest public/icons src/app/app
git commit -m "feat(pwa): installable manifest, icons and iOS viewport for /app"
```

---

## Task 2: Auth — Supabase session, middleware guard, login screen

**Files:**
- Modify: `package.json` (add `@supabase/ssr`)
- Create: `src/lib/mobile/session.ts`
- Create: `src/middleware.ts`
- Create: `src/app/app/login/page.tsx`
- Test: `src/lib/mobile/__tests__/session.test.ts`, `src/__tests__/middleware.test.ts`

**Interfaces:**
- Consumes: Task 1's `/app` tree.
- Produces:
  - `getSupabaseAuthClient(): SupabaseClient` — anon-key client bound to request cookies
  - `requireUser(): Promise<{ id: string; email: string | null } | null>`
  - `middleware(req: NextRequest): Promise<NextResponse>` guarding `/app/*` and `/api/app/*`

- [ ] **Step 1: Install the dependency**

```bash
npm install @supabase/ssr
```

- [ ] **Step 2: Write the failing middleware test**

```ts
// src/__tests__/middleware.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getUserMock } = vi.hoisted(() => ({ getUserMock: vi.fn() }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: getUserMock } }),
}));

import { middleware } from "../middleware";

const req = (url: string) => new NextRequest(new Request(`https://ops.trinity.plumbing${url}`));

describe("middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  describe("signed out", () => {
    beforeEach(() => getUserMock.mockResolvedValue({ data: { user: null } }));

    it("redirects a page request to login", async () => {
      const res = await middleware(req("/app/today"));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/app/login");
    });

    // Losing your place on session expiry is the difference between an app
    // that feels careful and one that feels careless.
    it("remembers where the user was going", async () => {
      const res = await middleware(req("/app/jobs/job_123"));
      expect(res.headers.get("location")).toContain("next=%2Fapp%2Fjobs%2Fjob_123");
    });

    // A fetch() must never receive an HTML login page — the client would try
    // to JSON.parse it and report a parse error instead of "signed out".
    it("returns 401 JSON for an API request, never a redirect", async () => {
      const res = await middleware(req("/api/app/today"));
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/json");
    });

    it("lets the login page itself through", async () => {
      const res = await middleware(req("/app/login"));
      expect(res.status).toBe(200);
    });
  });

  describe("signed in", () => {
    it("passes the request through", async () => {
      getUserMock.mockResolvedValue({ data: { user: { id: "u1", email: "info@trinity.plumbing" } } });
      const res = await middleware(req("/app/today"));
      expect(res.status).toBe(200);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/__tests__/middleware.test.ts`
Expected: FAIL — cannot resolve `../middleware`

- [ ] **Step 4: Write the session helper**

```ts
// src/lib/mobile/session.ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// The ANON key, not the service key. This client exists only to read and
// refresh the signed-in user's session; every data query still goes through
// getSupabaseServerClient() inside a route handler. Keeping the two clients
// separate is what lets the app skip RLS entirely — see the spec.
export function getSupabaseAuthClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new Error("Missing env var: NEXT_PUBLIC_SUPABASE_URL");
  if (!anonKey) throw new Error("Missing env var: NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      get: (name: string) => cookieStore.get(name)?.value,
      set: (name: string, value: string, options: Record<string, unknown>) => {
        // Server Components cannot set cookies; middleware refreshes the
        // session instead, so a throw here is expected and harmless.
        try {
          cookieStore.set({ name, value, ...options });
        } catch {}
      },
      remove: (name: string, options: Record<string, unknown>) => {
        try {
          cookieStore.set({ name, value: "", ...options });
        } catch {}
      },
    },
  });
}

export async function requireUser(): Promise<{ id: string; email: string | null } | null> {
  const { data } = await getSupabaseAuthClient().auth.getUser();
  if (!data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
```

- [ ] **Step 5: Write the middleware**

```ts
// src/middleware.ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const LOGIN_PATH = "/app/login";

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // The login page must stay reachable while signed out or the redirect loops.
  if (pathname === LOGIN_PATH) return NextResponse.next();

  const res = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (name: string) => req.cookies.get(name)?.value,
        // Written onto the response so a refreshed token actually reaches the
        // browser — this is the whole reason session refresh lives here.
        set: (name: string, value: string, options: Record<string, unknown>) => {
          res.cookies.set({ name, value, ...options });
        },
        remove: (name: string, options: Record<string, unknown>) => {
          res.cookies.set({ name, value: "", ...options });
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) return res;

  // An API caller is a fetch(), not a browser navigation. Redirecting it would
  // hand JSON.parse an HTML login page.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = LOGIN_PATH;
  url.search = "";
  url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/app/:path*", "/api/app/:path*"],
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/__tests__/middleware.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: Write the login page**

```tsx
// src/app/app/login/page.tsx
"use client";

import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      // Deliberately not "no account with that email" — that would confirm
      // which addresses exist to anyone who finds this page.
      setError("Email or password is incorrect.");
      setBusy(false);
      return;
    }
    router.replace(params.get("next") ?? "/app/today");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-bold tracking-tight">Trinity Ops</h1>
      <p className="mt-1 text-sm text-ink-faint">Sign in to continue.</p>

      <form onSubmit={onSubmit} className="mt-8 space-y-3">
        <input
          type="email"
          inputMode="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          className="min-h-[44px] w-full rounded-xl border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint"
        />
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="min-h-[44px] w-full rounded-xl border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint"
        />
        {error && (
          <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="min-h-[44px] w-full rounded-xl bg-brand text-base font-bold text-ink-inverse disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="mt-8 text-xs leading-relaxed text-ink-faint">
        On iPhone, open this page in <strong className="text-ink-muted">Safari</strong> and choose
        Share → Add to Home Screen. Notifications only work from the installed app, and the
        installed app signs in separately from the browser.
      </p>
    </main>
  );
}
```

> **Note:** the `text-base` (16px) on both inputs is deliberate — iOS Safari zooms the viewport when a focused input's font size is under 16px.

- [ ] **Step 8: Create the two accounts manually**

In the Supabase dashboard → Authentication → Users → Add user, create the owner and office accounts with **Auto Confirm User** enabled. Then Authentication → Providers → Email: **disable "Enable sign ups"**. There is no public registration in this app.

- [ ] **Step 9: Run the full suite and build**

Run: `npm test && npm run build`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/lib/mobile/session.ts src/middleware.ts src/app/app/login src/__tests__/middleware.test.ts
git commit -m "feat(app): Supabase Auth session, route guard and login screen"
```

---

## Task 3: The read pipeline — JSON envelope, fetch hook, freshness

**Files:**
- Create: `src/lib/mobile/envelope.ts`
- Create: `src/components/mobile/useAppData.ts`
- Create: `src/components/mobile/FreshnessStamp.tsx`
- Create: `src/components/mobile/EmptyState.tsx`
- Test: `src/lib/mobile/__tests__/envelope.test.ts`, `src/components/mobile/__tests__/FreshnessStamp.test.tsx`, `src/components/mobile/__tests__/useAppData.test.tsx`

**Interfaces:**
- Consumes: Task 2's middleware (returns 401 JSON when signed out).
- Produces:
  - `appJson<T>(data: T): NextResponse` — body `{ data, generated_at }`
  - `appError(message: string, status: number): NextResponse` — body `{ error }`
  - `useAppData<T>(path: string): { data: T | null; generatedAt: string | null; loading: boolean; error: string | null; fromCache: boolean; refresh: () => void }`
  - `<FreshnessStamp generatedAt={string | null} fromCache={boolean} />`
  - `<EmptyState>{children}</EmptyState>`

- [ ] **Step 1: Write the failing envelope test**

```ts
// src/lib/mobile/__tests__/envelope.test.ts
import { describe, it, expect } from "vitest";
import { appJson, appError } from "../envelope";

describe("appJson", () => {
  // Every screen shows "updated N min ago". That is only possible if freshness
  // is a property of the payload rather than a guess made by the client.
  it("stamps generated_at on every payload", async () => {
    const body = await appJson({ jobs: [] }).json();
    expect(body.data).toEqual({ jobs: [] });
    expect(Date.parse(body.generated_at)).not.toBeNaN();
  });

  // The service worker owns caching. Letting an intermediary cache these would
  // produce stale data the UI cannot detect or date.
  it("forbids HTTP caching so only the service worker caches", () => {
    expect(appJson({}).headers.get("cache-control")).toBe("no-store");
  });
});

describe("appError", () => {
  it("returns the message and status given", async () => {
    const res = appError("Job not found", 404);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Job not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/mobile/__tests__/envelope.test.ts`
Expected: FAIL — cannot resolve `../envelope`

- [ ] **Step 3: Write the envelope**

```ts
// src/lib/mobile/envelope.ts
import { NextResponse } from "next/server";

export interface AppEnvelope<T> {
  data: T;
  generated_at: string;
}

export function appJson<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(
    { data, generated_at: new Date().toISOString() },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export function appError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mobile/__tests__/envelope.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing FreshnessStamp test**

```tsx
// src/components/mobile/__tests__/FreshnessStamp.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { FreshnessStamp } from "../FreshnessStamp";

const NOW = new Date("2026-08-06T14:00:00Z");

describe("FreshnessStamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("says 'just now' under a minute", () => {
    render(<FreshnessStamp generatedAt="2026-08-06T13:59:30Z" fromCache={false} />);
    expect(screen.getByText(/just now/i)).toBeInTheDocument();
  });

  it("counts whole minutes", () => {
    render(<FreshnessStamp generatedAt="2026-08-06T13:48:00Z" fromCache={false} />);
    expect(screen.getByText(/12 min ago/i)).toBeInTheDocument();
  });

  // The whole point of the feature: offline must be stated, not implied by
  // data that merely looks normal.
  it("says so plainly when the data came from cache while offline", () => {
    render(<FreshnessStamp generatedAt="2026-08-06T12:42:00Z" fromCache />);
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });

  it("renders nothing before the first successful load", () => {
    const { container } = render(<FreshnessStamp generatedAt={null} fromCache={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/components/mobile/__tests__/FreshnessStamp.test.tsx`
Expected: FAIL — cannot resolve `../FreshnessStamp`

- [ ] **Step 7: Write FreshnessStamp and EmptyState**

```tsx
// src/components/mobile/FreshnessStamp.tsx
"use client";

const BUSINESS_TIME_ZONE = "America/New_York";

function relative(generatedAt: string): string {
  const ageMs = Date.now() - Date.parse(generatedAt);
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function FreshnessStamp({
  generatedAt,
  fromCache,
}: {
  generatedAt: string | null;
  fromCache: boolean;
}) {
  if (!generatedAt) return null;

  if (fromCache) {
    const clock = new Date(generatedAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: BUSINESS_TIME_ZONE,
    });
    return (
      <p className="text-xs text-warn">Offline — showing data from {clock}</p>
    );
  }
  return <p className="text-xs text-ink-faint">Updated {relative(generatedAt)}</p>;
}
```

```tsx
// src/components/mobile/EmptyState.tsx
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-surface-divider bg-surface-card px-4 py-8 text-center text-sm text-ink-faint">
      {children}
    </p>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/components/mobile/__tests__/FreshnessStamp.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 9: Write the failing useAppData test**

```tsx
// src/components/mobile/__tests__/useAppData.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAppData } from "../useAppData";

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("useAppData", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("exposes data and its generated_at", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: { count: 7 }, generated_at: "2026-08-06T14:00:00Z" })
      )
    );

    const { result } = renderHook(() => useAppData<{ count: number }>("/api/app/today"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ count: 7 });
    expect(result.current.generatedAt).toBe("2026-08-06T14:00:00Z");
    expect(result.current.fromCache).toBe(false);
  });

  // The service worker marks a stale-cache reply with this header; without it
  // the UI cannot tell a live fetch from a cached one and would lie.
  it("reports a service-worker cache hit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: {}, generated_at: "2026-08-06T12:42:00Z" }, { "X-Trinity-Cache": "hit" })
      )
    );

    const { result } = renderHook(() => useAppData("/api/app/today"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.fromCache).toBe(true);
  });

  it("surfaces a 401 as a signed-out error rather than a parse failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 })
      )
    );

    const { result } = renderHook(() => useAppData("/api/app/today"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/signed in/i);
  });

  it("refetches on refresh()", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: {}, generated_at: "2026-08-06T14:00:00Z" }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAppData("/api/app/today"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run src/components/mobile/__tests__/useAppData.test.tsx`
Expected: FAIL — cannot resolve `../useAppData`

- [ ] **Step 11: Write useAppData**

```tsx
// src/components/mobile/useAppData.ts
"use client";

import { useCallback, useEffect, useState } from "react";

export interface AppData<T> {
  data: T | null;
  generatedAt: string | null;
  loading: boolean;
  error: string | null;
  fromCache: boolean;
  refresh: () => void;
}

export function useAppData<T>(path: string): AppData<T> {
  const [data, setData] = useState<T | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const res = await fetch(path, { credentials: "same-origin" });

        if (res.status === 401) {
          if (!cancelled) setError("You are not signed in.");
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled) setError(body.error ?? `Request failed (${res.status}).`);
          return;
        }

        const body = await res.json();
        if (cancelled) return;
        setData(body.data as T);
        setGeneratedAt(body.generated_at ?? null);
        // Set by the service worker when it serves a stale cached copy.
        setFromCache(res.headers.get("X-Trinity-Cache") === "hit");
        setError(null);
      } catch {
        // A thrown fetch means no network AND no cached copy — the only case
        // where the screen genuinely has nothing to show.
        if (!cancelled) setError("Offline, and nothing saved for this screen yet.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  return { data, generatedAt, loading, error, fromCache, refresh };
}
```

- [ ] **Step 12: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add src/lib/mobile/envelope.ts src/components/mobile src/lib/mobile/__tests__
git commit -m "feat(app): JSON envelope with generated_at, fetch hook and freshness stamp"
```

---

## Task 4: Shared UI — tab bar, status pill, job row

**Files:**
- Create: `src/components/mobile/TabBar.tsx`, `src/components/mobile/StatusPill.tsx`, `src/components/mobile/JobRow.tsx`
- Modify: `src/app/app/layout.tsx`
- Test: `src/components/mobile/__tests__/StatusPill.test.tsx`, `src/components/mobile/__tests__/JobRow.test.tsx`, `src/components/mobile/__tests__/TabBar.test.tsx`

**Interfaces:**
- Consumes: `TodayScheduleRow` from `@/lib/dashboard/queries`.
- Produces:
  - `<TabBar />` — five fixed tabs, active state from `usePathname()`
  - `<StatusPill status={string | null} />`
  - `<JobRow job={TodayScheduleRow} />` — links to `/app/jobs/[id]`

- [ ] **Step 1: Write the failing StatusPill test**

```tsx
// src/components/mobile/__tests__/StatusPill.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "../StatusPill";

describe("StatusPill", () => {
  // These are scheduleStatus()'s exact output labels. Inventing others here is
  // how the dashboard and this app would start disagreeing.
  it.each([
    ["Scheduled", "text-info"],
    ["En Route", "text-brand"],
    ["In Progress", "text-brand"],
    ["Completed", "text-success"],
    ["Canceled", "text-danger"],
    ["Needs Scheduling", "text-warn"],
  ])("renders %s with its tone", (status, toneClass) => {
    const { container } = render(<StatusPill status={status} />);
    expect(screen.getByText(status)).toBeInTheDocument();
    expect(container.querySelector(`.${toneClass}`)).not.toBeNull();
  });

  // scheduleStatus() returns null for an unmapped HCP status rather than
  // echoing it raw; the pill must not invent a label for that.
  it("renders nothing for a null status", () => {
    const { container } = render(<StatusPill status={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/mobile/__tests__/StatusPill.test.tsx`
Expected: FAIL — cannot resolve `../StatusPill`

- [ ] **Step 3: Write StatusPill**

```tsx
// src/components/mobile/StatusPill.tsx
// Labels come from scheduleStatus() in src/lib/dashboard/queries.ts. "En Route"
// is derived from raw.work_timestamps.on_my_way_at — HCP's work_status enum has
// no en-route value.
const TONES: Record<string, string> = {
  Scheduled: "bg-info-tint text-info",
  "En Route": "bg-brand-tint text-brand",
  "In Progress": "bg-brand-tint text-brand",
  Completed: "bg-success-tint text-success",
  Canceled: "bg-danger-tint text-danger",
  "Needs Scheduling": "bg-warn-tint text-warn",
};

export function StatusPill({ status }: { status: string | null }) {
  if (!status) return null;
  const tone = TONES[status] ?? "bg-surface-elevated text-ink-muted";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${tone}`}>
      {status}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/mobile/__tests__/StatusPill.test.tsx`
Expected: PASS (7 tests)

- [ ] **Step 5: Write the failing JobRow test**

```tsx
// src/components/mobile/__tests__/JobRow.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JobRow } from "../JobRow";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";

const job: TodayScheduleRow = {
  id: "job_3417",
  scheduledStart: "2026-08-06T12:00:00Z", // 8:00a America/New_York
  customerName: "Margaret Kowalski",
  technicianName: "Dylan",
  zone: "Averill Park",
  compass: "",
  miles: 2.1,
  driveMinutes: 4,
  address: "14 Sliter Rd, Averill Park",
  service: "Water Heater Replacement",
  customerPhone: "5185550142",
  status: "In Progress",
  lat: 42.63,
  lng: -73.55,
};

describe("JobRow", () => {
  it("shows time, customer, address and service", () => {
    render(<JobRow job={job} />);
    expect(screen.getByText("Margaret Kowalski")).toBeInTheDocument();
    expect(screen.getByText("14 Sliter Rd, Averill Park")).toBeInTheDocument();
    expect(screen.getByText(/Water Heater Replacement/)).toBeInTheDocument();
  });

  // The server renders in UTC on Vercel. A job at 12:00Z is 8:00a Eastern, and
  // showing "12:00 PM" to a dispatcher would be actively dangerous.
  it("renders the time in America/New_York, not UTC", () => {
    render(<JobRow job={job} />);
    expect(screen.getByText("8:00 AM")).toBeInTheDocument();
  });

  it("links to the job detail screen", () => {
    render(<JobRow job={job} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/app/jobs/job_3417");
  });

  it("copes with a job that has no time, address or service", () => {
    render(<JobRow job={{ ...job, scheduledStart: null, address: null, service: null }} />);
    expect(screen.getByText("Margaret Kowalski")).toBeInTheDocument();
    expect(screen.getByText("Unscheduled")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/components/mobile/__tests__/JobRow.test.tsx`
Expected: FAIL — cannot resolve `../JobRow`

- [ ] **Step 7: Write JobRow**

```tsx
// src/components/mobile/JobRow.tsx
import Link from "next/link";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { StatusPill } from "./StatusPill";

const BUSINESS_TIME_ZONE = "America/New_York";

function clock(iso: string | null): string {
  if (!iso) return "Unscheduled";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
  });
}

export function JobRow({ job }: { job: TodayScheduleRow }) {
  return (
    <Link
      href={`/app/jobs/${job.id}`}
      className="mb-2 flex min-h-[44px] flex-col rounded-xl border border-surface-divider bg-surface-card px-3 py-2.5"
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs font-bold text-brand">{clock(job.scheduledStart)}</span>
        <span className="flex-1 truncate text-sm font-semibold">
          {job.customerName ?? "Unknown customer"}
        </span>
        <StatusPill status={job.status} />
      </div>
      {job.address && <p className="mt-1 text-xs text-ink-muted">{job.address}</p>}
      {(job.service || job.technicianName) && (
        <p className="mt-0.5 text-xs text-ink-faint">
          {[job.service, job.technicianName].filter(Boolean).join(" · ")}
        </p>
      )}
    </Link>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/components/mobile/__tests__/JobRow.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 9: Write the failing TabBar test**

```tsx
// src/components/mobile/__tests__/TabBar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { pathnameMock } = vi.hoisted(() => ({ pathnameMock: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

import { TabBar } from "../TabBar";

describe("TabBar", () => {
  it("renders all five tabs", () => {
    pathnameMock.mockReturnValue("/app/today");
    render(<TabBar />);
    for (const label of ["Today", "Schedule", "Customers", "Money", "Dispatch"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("marks the current tab as current for screen readers", () => {
    pathnameMock.mockReturnValue("/app/money");
    render(<TabBar />);
    expect(screen.getByRole("link", { name: /Money/ })).toHaveAttribute("aria-current", "page");
  });

  // A job detail screen is reached from Today; the tab must stay lit while the
  // user is down inside that branch.
  it("keeps Today lit on a job detail route", () => {
    pathnameMock.mockReturnValue("/app/jobs/job_3417");
    render(<TabBar />);
    expect(screen.getByRole("link", { name: /Today/ })).toHaveAttribute("aria-current", "page");
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run src/components/mobile/__tests__/TabBar.test.tsx`
Expected: FAIL — cannot resolve `../TabBar`

- [ ] **Step 11: Write TabBar and mount it in the layout**

```tsx
// src/components/mobile/TabBar.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/app/today", label: "Today", icon: "📋", owns: ["/app/today", "/app/jobs"] },
  { href: "/app/schedule", label: "Schedule", icon: "📅", owns: ["/app/schedule"] },
  { href: "/app/customers", label: "Customers", icon: "👤", owns: ["/app/customers"] },
  { href: "/app/money", label: "Money", icon: "💵", owns: ["/app/money"] },
  { href: "/app/dispatch", label: "Dispatch", icon: "📍", owns: ["/app/dispatch"] },
];

export function TabBar() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      // pb-[env(safe-area-inset-bottom)] keeps the tabs above the iPhone home
      // indicator; without it the bottom row is half-swallowed on every modern
      // iPhone. It only resolves because layout.tsx sets viewportFit: "cover".
      className="sticky bottom-0 z-10 flex border-t border-surface-divider bg-surface-raised pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map((tab) => {
        const active = tab.owns.some((p) => pathname.startsWith(p));
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-[44px] flex-1 flex-col items-center justify-center py-1.5 text-[10px] ${
              active ? "text-brand" : "text-ink-faint"
            }`}
          >
            <span aria-hidden className={`text-lg ${active ? "" : "opacity-60 grayscale"}`}>
              {tab.icon}
            </span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

Then modify `src/app/app/layout.tsx` — replace the returned JSX (keep `metadata` and `viewport` untouched):

```tsx
export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-surface-page text-ink-primary">
      <div className="flex-1 pb-2">{children}</div>
      <TabBar />
    </div>
  );
}
```

and add `import { TabBar } from "@/components/mobile/TabBar";` at the top.

> The login page renders inside this layout too. That is acceptable — the tab bar links are all guarded by middleware, so tapping one while signed out returns to login.

- [ ] **Step 12: Run tests to verify they pass**

Run: `npx vitest run src/components/mobile`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add src/components/mobile src/app/app/layout.tsx
git commit -m "feat(app): tab bar, status pill and job row"
```

---

## Task 5: Today tab

**Files:**
- Create: `src/app/api/app/today/route.ts`, `src/app/app/today/page.tsx`
- Test: `src/app/api/app/today/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `appJson` (Task 3), `useAppData` (Task 3), `JobRow` / `FreshnessStamp` / `EmptyState` (Tasks 3–4), `getDashboardSnapshot` (existing).
- Produces: `GET /api/app/today` → `{ data: TodayPayload, generated_at }` where

```ts
interface TodayPayload {
  dateLabel: string;         // "Thursday, August 6"
  jobsInProgress: number;
  emergencyCalls: number;
  pendingInvoices: number;
  jobs: TodayScheduleRow[];  // already canceled-filtered and time-sorted
}
```

- [ ] **Step 1: Write the failing route test**

```ts
// src/app/api/app/today/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";

const { snapshotMock } = vi.hoisted(() => ({ snapshotMock: vi.fn() }));
vi.mock("@/lib/dashboard/queries", () => ({ getDashboardSnapshot: snapshotMock }));

import { GET } from "../route";

const row = (over: Partial<TodayScheduleRow> = {}): TodayScheduleRow => ({
  id: "job_1",
  scheduledStart: "2026-08-06T12:00:00Z",
  customerName: "M. Kowalski",
  technicianName: "Dylan",
  zone: "Averill Park",
  compass: "",
  miles: 2.1,
  driveMinutes: 4,
  address: "14 Sliter Rd, Averill Park",
  service: "Water Heater Replacement",
  customerPhone: "5185550142",
  status: "In Progress",
  lat: 42.63,
  lng: -73.55,
  ...over,
});

describe("GET /api/app/today", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshotMock.mockResolvedValue({
      jobsInProgress: 3,
      emergencyCalls: 1,
      commercialJobs: 0,
      openEstimates: 12,
      pendingInvoices: 25,
      upcomingEstimates: 4,
      revenueBookedThisWeekCents: 1_450_000,
      revenueScheduledNextWeekCents: 920_000,
      todaySchedule: [row(), row({ id: "job_2", status: "Scheduled" })],
      technicianWorkload: [],
    });
  });

  it("returns the counters and today's jobs", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.jobsInProgress).toBe(3);
    expect(body.data.emergencyCalls).toBe(1);
    expect(body.data.pendingInvoices).toBe(25);
    expect(body.data.jobs).toHaveLength(2);
    expect(Date.parse(body.generated_at)).not.toBeNaN();
  });

  // The counters this screen shows are the ones getDashboardSnapshot already
  // computes. Recomputing them here is how two surfaces silently disagree.
  it("delegates entirely to getDashboardSnapshot", async () => {
    await GET();
    expect(snapshotMock).toHaveBeenCalledTimes(1);
  });

  // A dead Supabase must not render as an empty, normal-looking day.
  it("surfaces a query failure with its cause", async () => {
    snapshotMock.mockRejectedValue(new Error("supabase unreachable"));
    const res = await GET();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/supabase unreachable/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/app/today`
Expected: FAIL — cannot resolve `../route`

- [ ] **Step 3: Write the route**

```ts
// src/app/api/app/today/route.ts
import { getDashboardSnapshot } from "@/lib/dashboard/queries";
import { appJson, appError } from "@/lib/mobile/envelope";

export const dynamic = "force-dynamic";

const BUSINESS_TIME_ZONE = "America/New_York";

export async function GET() {
  try {
    const snapshot = await getDashboardSnapshot();
    return appJson({
      dateLabel: new Date().toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: BUSINESS_TIME_ZONE,
      }),
      jobsInProgress: snapshot.jobsInProgress,
      emergencyCalls: snapshot.emergencyCalls,
      pendingInvoices: snapshot.pendingInvoices,
      jobs: snapshot.todaySchedule,
    });
  } catch (err) {
    return appError(
      `Couldn't load today: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/app/today`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the Today page**

```tsx
// src/app/app/today/page.tsx
"use client";

import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { EmptyState } from "@/components/mobile/EmptyState";
import { JobRow } from "@/components/mobile/JobRow";

interface TodayPayload {
  dateLabel: string;
  jobsInProgress: number;
  emergencyCalls: number;
  pendingInvoices: number;
  jobs: TodayScheduleRow[];
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="flex-1 rounded-xl border border-surface-divider bg-surface-card px-2 py-2 text-center">
      <div className={`font-mono text-lg font-bold ${tone ?? "text-ink-primary"}`}>{n}</div>
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}

export default function TodayPage() {
  const { data, generatedAt, loading, error, fromCache, refresh } =
    useAppData<TodayPayload>("/api/app/today");

  return (
    <main className="px-3 pt-3">
      <header className="mb-3 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Today</h1>
          <p className="text-xs text-ink-faint">{data?.dateLabel ?? "\u00a0"}</p>
          <FreshnessStamp generatedAt={generatedAt} fromCache={fromCache} />
        </div>
        <button
          onClick={refresh}
          aria-label="Refresh"
          className="min-h-[44px] min-w-[44px] rounded-xl border border-surface-border text-ink-muted"
        >
          ↻
        </button>
      </header>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {data && (
        <>
          <div className="mb-4 flex gap-2">
            <Stat n={data.jobsInProgress} label="In prog" />
            <Stat
              n={data.emergencyCalls}
              label="Emerg"
              tone={data.emergencyCalls > 0 ? "text-danger" : undefined}
            />
            <Stat
              n={data.pendingInvoices}
              label="Unpaid"
              tone={data.pendingInvoices > 0 ? "text-warn" : undefined}
            />
          </div>

          <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Schedule
          </h2>
          {data.jobs.length === 0 ? (
            <EmptyState>No jobs scheduled today.</EmptyState>
          ) : (
            data.jobs.map((job) => <JobRow key={job.id} job={job} />)
          )}
        </>
      )}

      {loading && !data && <p className="text-sm text-ink-faint">Loading…</p>}
    </main>
  );
}
```

> **Note on the counters:** `emergencyCalls` counts only jobs tagged since the tagging convention began (see `docs/PHASE-1.x-BACKLOG.md`). The short label "Emerg" is honest about being a count, not a claim about all history.

- [ ] **Step 6: Run the suite and build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/api/app/today src/app/app/today
git commit -m "feat(app): Today tab — counters and today's schedule"
```

---

## Task 6: Schedule tab

**Files:**
- Create: `src/app/api/app/schedule/route.ts`, `src/app/app/schedule/page.tsx`
- Test: `src/app/api/app/schedule/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `getScheduleDays(startAnchor: Date, dayCount: number)` (existing), `weekRange` from `@/lib/dashboard/week`.
- Produces: `GET /api/app/schedule?offset=<int>` → `{ data: SchedulePayload, generated_at }`

```ts
interface ScheduleDay { dateKey: string; label: string; rows: TodayScheduleRow[] }
interface SchedulePayload {
  weekLabel: string;                    // "Week of Aug 3"
  offset: number;                       // 0 = this week, 1 = next, -1 = last
  days: ScheduleDay[];                  // always 7
  technicians: { id: string; name: string }[];
}
```

- [ ] **Step 1: Write the failing route test**

```ts
// src/app/api/app/schedule/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { scheduleDaysMock, supabaseMock } = vi.hoisted(() => ({
  scheduleDaysMock: vi.fn(),
  supabaseMock: vi.fn(),
}));

vi.mock("@/lib/dashboard/queries", () => ({ getScheduleDays: scheduleDaysMock }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { GET } from "../route";

const request = (qs = "") => new Request(`https://example.com/api/app/schedule${qs}`);

describe("GET /api/app/schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduleDaysMock.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({ dateKey: `2026-08-0${3 + i}`, rows: [] }))
    );
    supabaseMock.mockReturnValue({
      from: () => ({
        select: () => ({
          range: () =>
            Promise.resolve({
              data: [{ id: "t1", first_name: "Dylan", last_name: "R" }],
              error: null,
            }),
        }),
      }),
    });
  });

  it("returns seven days, empty ones included", async () => {
    const body = await (await GET(request())).json();
    expect(body.data.days).toHaveLength(7);
  });

  // An empty day must still render as a day. Dropping it would make a quiet
  // Sunday indistinguishable from a broken query.
  it("keeps a day with no jobs", async () => {
    const body = await (await GET(request())).json();
    expect(body.data.days.every((d: { rows: unknown[] }) => Array.isArray(d.rows))).toBe(true);
  });

  it("shifts a week forward when offset=1", async () => {
    await GET(request("?offset=1"));
    const [anchor, count] = scheduleDaysMock.mock.calls[0];
    expect(count).toBe(7);
    expect(anchor).toBeInstanceOf(Date);
  });

  // Unbounded user input reaching a date constructor is how you get an
  // Invalid Date and a 500 on a screen that should never fail.
  it("clamps a nonsense offset instead of throwing", async () => {
    const res = await GET(request("?offset=banana"));
    expect(res.status).toBe(200);
  });

  it("returns the technician list for the filter", async () => {
    const body = await (await GET(request())).json();
    expect(body.data.technicians).toEqual([{ id: "t1", name: "Dylan R" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/app/schedule`
Expected: FAIL — cannot resolve `../route`

- [ ] **Step 3: Write the route**

```ts
// src/app/api/app/schedule/route.ts
import { getScheduleDays } from "@/lib/dashboard/queries";
import { weekRange } from "@/lib/dashboard/week";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import { appJson, appError } from "@/lib/mobile/envelope";

export const dynamic = "force-dynamic";

const BUSINESS_TIME_ZONE = "America/New_York";
const MAX_OFFSET_WEEKS = 26;

function clampOffset(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_OFFSET_WEEKS, Math.max(-MAX_OFFSET_WEEKS, Math.trunc(n)));
}

export async function GET(req: Request) {
  const offset = clampOffset(new URL(req.url).searchParams.get("offset"));

  try {
    // weekRange gives this week's Monday; step whole weeks from there. Anchored
    // at 16:00 UTC (noon-ish Eastern under either DST offset) so the calendar
    // date is never ambiguous — the same trick getScheduleDays uses internally.
    const monday = new Date(weekRange(new Date(), "this").startIso);
    const anchor = new Date(
      Date.UTC(
        monday.getUTCFullYear(),
        monday.getUTCMonth(),
        monday.getUTCDate() + offset * 7,
        16,
        0,
        0
      )
    );

    const [days, technicians] = await Promise.all([
      getScheduleDays(anchor, 7),
      listTechnicians(),
    ]);

    return appJson({
      weekLabel: `Week of ${anchor.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: BUSINESS_TIME_ZONE,
      })}`,
      offset,
      days: days.map((d) => ({
        ...d,
        label: new Date(`${d.dateKey}T16:00:00Z`).toLocaleDateString("en-US", {
          weekday: "short",
          timeZone: BUSINESS_TIME_ZONE,
        }),
      })),
      technicians,
    });
  } catch (err) {
    return appError(
      `Couldn't load the schedule: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}

async function listTechnicians(): Promise<{ id: string; name: string }[]> {
  // Six employees on the live account, so one bounded page is plenty — but the
  // range is explicit rather than relying on PostgREST's silent 1000-row cap.
  const { data, error } = await getSupabaseServerClient()
    .from("technicians")
    .select("id, first_name, last_name")
    .range(0, 999);
  if (error) throw new Error(`technicians query failed: ${error.message}`);
  return (data ?? []).map((t: { id: string; first_name: string | null; last_name: string | null }) => ({
    id: t.id,
    name: [t.first_name, t.last_name].filter(Boolean).join(" ") || "Unnamed",
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/app/schedule`
Expected: PASS (5 tests)

- [ ] **Step 5: Write the Schedule page**

```tsx
// src/app/app/schedule/page.tsx
"use client";

import { useState } from "react";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { EmptyState } from "@/components/mobile/EmptyState";
import { JobRow } from "@/components/mobile/JobRow";

interface ScheduleDay { dateKey: string; label: string; rows: TodayScheduleRow[] }
interface SchedulePayload {
  weekLabel: string;
  offset: number;
  days: ScheduleDay[];
  technicians: { id: string; name: string }[];
}

export default function SchedulePage() {
  const [offset, setOffset] = useState(0);
  const [dayIndex, setDayIndex] = useState<number | null>(null);
  const [tech, setTech] = useState<string>("all");

  const { data, generatedAt, error, fromCache } = useAppData<SchedulePayload>(
    `/api/app/schedule?offset=${offset}`
  );

  const days = data?.days ?? [];
  const selected = dayIndex == null ? null : days[dayIndex];
  const visible = (selected?.rows ?? days.flatMap((d) => d.rows)).filter(
    (r) => tech === "all" || r.technicianName === tech
  );

  return (
    <main className="px-3 pt-3">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Schedule</h1>
          <p className="text-xs text-ink-faint">{data?.weekLabel ?? "\u00a0"}</p>
          <FreshnessStamp generatedAt={generatedAt} fromCache={fromCache} />
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => { setOffset((o) => o - 1); setDayIndex(null); }}
            aria-label="Previous week"
            className="min-h-[44px] min-w-[44px] rounded-xl border border-surface-border text-ink-muted"
          >‹</button>
          <button
            onClick={() => { setOffset((o) => o + 1); setDayIndex(null); }}
            aria-label="Next week"
            className="min-h-[44px] min-w-[44px] rounded-xl border border-surface-border text-ink-muted"
          >›</button>
        </div>
      </header>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mb-3 flex gap-1">
        {days.map((d, i) => (
          <button
            key={d.dateKey}
            onClick={() => setDayIndex(dayIndex === i ? null : i)}
            className={`min-h-[44px] flex-1 rounded-lg border px-0.5 py-1 ${
              dayIndex === i
                ? "border-brand bg-brand-tint"
                : "border-surface-divider bg-surface-card"
            }`}
          >
            <div className="text-[9px] uppercase text-ink-faint">{d.label}</div>
            <div className="text-xs font-bold">{d.dateKey.slice(-2)}</div>
            <div className="text-[9px] text-brand">{d.rows.length || "—"}</div>
          </button>
        ))}
      </div>

      {data && data.technicians.length > 0 && (
        <select
          value={tech}
          onChange={(e) => setTech(e.target.value)}
          className="mb-3 min-h-[44px] w-full rounded-lg border border-surface-divider bg-surface-card px-3 text-base text-ink-primary"
        >
          <option value="all">All technicians</option>
          {data.technicians.map((t) => (
            <option key={t.id} value={t.name}>{t.name}</option>
          ))}
        </select>
      )}

      {visible.length === 0 ? (
        <EmptyState>
          {selected ? "No jobs scheduled this day." : "No jobs scheduled this week."}
        </EmptyState>
      ) : (
        visible.map((job) => <JobRow key={job.id} job={job} />)
      )}
    </main>
  );
}
```

- [ ] **Step 6: Run the suite and build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/api/app/schedule src/app/app/schedule
git commit -m "feat(app): Schedule tab — week strip, day drill-down, technician filter"
```

---

## Task 7: Job detail

**Files:**
- Create: `src/lib/mobile/jobDetail.ts`, `src/app/api/app/jobs/[id]/route.ts`, `src/app/app/jobs/[id]/page.tsx`
- Test: `src/lib/mobile/__tests__/jobDetail.test.ts`

**Interfaces:**
- Consumes: `buildScheduleRow` behaviour via the shared query module; `formatPhone` is introduced in Task 8 and is **not** used here — job detail shows the phone as a `tel:` link with the digits HCP stores.
- Produces:

```ts
interface JobNote { content: string; author: string | null; createdAt: string | null }
export interface JobDetail {
  id: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;      // digits only
  scheduledStart: string | null;
  scheduledEnd: string | null;
  address: string | null;
  technicianName: string | null;
  service: string | null;
  status: string | null;             // scheduleStatus() label
  amountCents: number | null;        // BOOKED, not paid
  invoice: { id: string; status: string | null; amountCents: number | null } | null;
  notes: JobNote[];
}
export function getJobDetail(id: string): Promise<JobDetail | null>;
```

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/mobile/__tests__/jobDetail.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { getJobDetail } from "../jobDetail";

const JOB = {
  id: "job_3417",
  work_status: "scheduled",
  total_amount_cents: 248_000,
  scheduled_start: "2026-08-06T12:00:00Z",
  scheduled_end: "2026-08-06T14:00:00Z",
  technician_id: "tech_1",
  service_address_lat: 42.63,
  service_address_lng: -73.55,
  raw: {
    customer: { id: "cus_1", mobile_number: "(518) 555-0142" },
    address: { street: "14 Sliter Rd", city: "Averill Park" },
    job_fields: { job_type: { name: "Water Heater Replacement" } },
    work_timestamps: { on_my_way_at: "2026-08-06T11:40:00Z" },
    notes: [{ content: "Dog is friendly but loud.", created_by: "Ryan", created_at: "2026-07-30T15:00:00Z" }],
  },
};

function mockTables(tables: Record<string, { data: unknown; error: unknown }>) {
  supabaseMock.mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(tables[table] ?? { data: null, error: null }),
          limit: () => Promise.resolve(tables[table] ?? { data: [], error: null }),
        }),
      }),
    }),
  });
}

describe("getJobDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for an unknown job", async () => {
    mockTables({ jobs: { data: null, error: null } });
    expect(await getJobDetail("job_nope")).toBeNull();
  });

  it("maps the job's core fields", async () => {
    mockTables({
      jobs: { data: JOB, error: null },
      customers: { data: { id: "cus_1", first_name: "Margaret", last_name: "Kowalski", phone: "5185550142", address_line1: "14 Sliter Rd", city: "Averill Park" }, error: null },
      technicians: { data: { id: "tech_1", first_name: "Dylan", last_name: "R" }, error: null },
      invoices: { data: [], error: null },
    });

    const detail = await getJobDetail("job_3417");

    expect(detail?.customerName).toBe("Margaret Kowalski");
    expect(detail?.technicianName).toBe("Dylan R");
    expect(detail?.address).toBe("14 Sliter Rd, Averill Park");
    expect(detail?.service).toBe("Water Heater Replacement");
    expect(detail?.amountCents).toBe(248_000);
  });

  // HCP's work_status says "scheduled" here; on_my_way_at is what makes it
  // En Route. Reading only work_status would lose the state entirely.
  it("reports En Route when HCP stamped on_my_way_at", async () => {
    mockTables({
      jobs: { data: JOB, error: null },
      customers: { data: null, error: null },
      technicians: { data: null, error: null },
      invoices: { data: [], error: null },
    });
    expect((await getJobDetail("job_3417"))?.status).toBe("En Route");
  });

  it("stores the customer phone as digits for a tel: link", async () => {
    mockTables({
      jobs: { data: JOB, error: null },
      customers: { data: null, error: null },
      technicians: { data: null, error: null },
      invoices: { data: [], error: null },
    });
    expect((await getJobDetail("job_3417"))?.customerPhone).toBe("5185550142");
  });

  it("links the invoice, which HCP does populate with job_id", async () => {
    mockTables({
      jobs: { data: JOB, error: null },
      customers: { data: null, error: null },
      technicians: { data: null, error: null },
      invoices: { data: [{ id: "inv_4482", status: "open", amount_cents: 248_000 }], error: null },
    });
    expect((await getJobDetail("job_3417"))?.invoice).toEqual({
      id: "inv_4482",
      status: "open",
      amountCents: 248_000,
    });
  });

  it("returns notes oldest-first from the raw payload", async () => {
    mockTables({
      jobs: { data: JOB, error: null },
      customers: { data: null, error: null },
      technicians: { data: null, error: null },
      invoices: { data: [], error: null },
    });
    const notes = (await getJobDetail("job_3417"))?.notes;
    expect(notes).toHaveLength(1);
    expect(notes?.[0].content).toBe("Dog is friendly but loud.");
    expect(notes?.[0].author).toBe("Ryan");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/mobile/__tests__/jobDetail.test.ts`
Expected: FAIL — cannot resolve `../jobDetail`

- [ ] **Step 3: Write jobDetail.ts**

```ts
// src/lib/mobile/jobDetail.ts
import { getSupabaseServerClient } from "@/lib/supabase/client";

export interface JobNote {
  content: string;
  author: string | null;
  createdAt: string | null;
}

export interface JobDetail {
  id: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  address: string | null;
  technicianName: string | null;
  service: string | null;
  status: string | null;
  amountCents: number | null;
  invoice: { id: string; status: string | null; amountCents: number | null } | null;
  notes: JobNote[];
}

const CANCELED = new Set(["pro canceled", "user canceled"]);

// Mirrors scheduleStatus() in src/lib/dashboard/queries.ts, which is private to
// that module. HCP's work_status has no en-route value — "On my way" only
// stamps work_timestamps.on_my_way_at, so a dispatched job still reads
// "scheduled" and must be upgraded here.
function statusLabel(workStatus: string | null, ts?: { on_my_way_at?: string | null }): string | null {
  const s = (workStatus ?? "").toLowerCase();
  if (s.startsWith("complete")) return "Completed";
  if (CANCELED.has(s)) return "Canceled";
  if (s === "in progress") return "In Progress";
  if (s === "scheduled") return ts?.on_my_way_at ? "En Route" : "Scheduled";
  if (s === "needs scheduling") return "Needs Scheduling";
  return null;
}

const fullName = (r?: { first_name?: string | null; last_name?: string | null } | null) =>
  r ? [r.first_name, r.last_name].filter(Boolean).join(" ") || null : null;

export async function getJobDetail(id: string): Promise<JobDetail | null> {
  const supabase = getSupabaseServerClient();

  const { data: job, error } = await supabase
    .from("jobs")
    .select(
      "id, work_status, total_amount_cents, scheduled_start, scheduled_end, technician_id, service_address_lat, service_address_lng, raw"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`job query failed: ${error.message}`);
  if (!job) return null;

  const raw = (job.raw ?? {}) as {
    customer?: { id?: string; mobile_number?: string; home_number?: string; work_number?: string };
    address?: { street?: string; city?: string };
    description?: string;
    job_fields?: { job_type?: { name?: string } };
    work_timestamps?: { on_my_way_at?: string | null };
    notes?: Array<{ content?: string; created_by?: string; created_at?: string }>;
  };

  const customerId = raw.customer?.id ?? null;

  const [{ data: customer }, { data: technician }, { data: invoices }] = await Promise.all([
    customerId
      ? supabase
          .from("customers")
          .select("id, first_name, last_name, phone, address_line1, city")
          .eq("id", customerId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    job.technician_id
      ? supabase
          .from("technicians")
          .select("id, first_name, last_name")
          .eq("id", job.technician_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Estimates are deliberately absent: HCP exposes csr_-prefixed ids on
    // /estimates and est_-prefixed ids on the job, so there is no key to join
    // on. Invoices DO carry job_id. See the spec's constraints.
    supabase.from("invoices").select("id, status, amount_cents").eq("job_id", id).limit(1),
  ]);

  const street = raw.address?.street?.trim() || customer?.address_line1?.trim() || null;
  const town = raw.address?.city?.trim() || customer?.city?.trim() || null;

  const phoneRaw =
    customer?.phone ||
    raw.customer?.mobile_number ||
    raw.customer?.home_number ||
    raw.customer?.work_number ||
    "";
  const digits = phoneRaw.replace(/\D/g, "");

  const firstInvoice = (invoices ?? [])[0];

  return {
    id: job.id,
    customerId,
    customerName: fullName(customer),
    customerPhone: digits || null,
    scheduledStart: job.scheduled_start,
    scheduledEnd: job.scheduled_end,
    address: [street, town].filter(Boolean).join(", ") || null,
    technicianName: fullName(technician),
    service: raw.job_fields?.job_type?.name?.trim() || raw.description?.split("\n")[0]?.trim() || null,
    status: statusLabel(job.work_status, raw.work_timestamps),
    amountCents: job.total_amount_cents,
    invoice: firstInvoice
      ? { id: firstInvoice.id, status: firstInvoice.status, amountCents: firstInvoice.amount_cents }
      : null,
    notes: (raw.notes ?? []).map((n) => ({
      content: n.content ?? "",
      author: n.created_by ?? null,
      createdAt: n.created_at ?? null,
    })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mobile/__tests__/jobDetail.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the route**

```ts
// src/app/api/app/jobs/[id]/route.ts
import { getJobDetail } from "@/lib/mobile/jobDetail";
import { appJson, appError } from "@/lib/mobile/envelope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const detail = await getJobDetail(params.id);
    if (!detail) return appError("Job not found.", 404);
    return appJson(detail);
  } catch (err) {
    return appError(
      `Couldn't load the job: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
```

- [ ] **Step 6: Write the job detail page**

```tsx
// src/app/app/jobs/[id]/page.tsx
"use client";

import Link from "next/link";
import type { JobDetail } from "@/lib/mobile/jobDetail";
import { useAppData } from "@/components/mobile/useAppData";
import { StatusPill } from "@/components/mobile/StatusPill";

const BUSINESS_TIME_ZONE = "America/New_York";

const money = (cents: number | null) =>
  cents == null
    ? "—"
    : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function timeRange(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "Unscheduled";
  const opts = { hour: "numeric", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE } as const;
  const start = new Date(startIso).toLocaleTimeString("en-US", opts);
  if (!endIso) return start;
  return `${start} – ${new Date(endIso).toLocaleTimeString("en-US", opts)}`;
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between border-b border-surface-divider py-2 text-sm">
      <span className="text-ink-faint">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  );
}

export default function JobPage({ params }: { params: { id: string } }) {
  const { data: job, error } = useAppData<JobDetail>(`/api/app/jobs/${params.id}`);

  if (error) {
    return (
      <main className="px-3 pt-3">
        <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      </main>
    );
  }
  if (!job) return <main className="px-3 pt-3 text-sm text-ink-faint">Loading…</main>;

  return (
    <main className="px-3 pt-3">
      <header className="mb-3 flex items-center gap-2">
        <Link href="/app/today" aria-label="Back" className="min-h-[44px] px-1 text-xl text-brand">
          ‹
        </Link>
        <div className="flex-1">
          <h1 className="text-lg font-bold tracking-tight">
            {job.customerName ?? "Unknown customer"}
          </h1>
          <p className="text-xs text-ink-faint">{timeRange(job.scheduledStart, job.scheduledEnd)}</p>
        </div>
        <StatusPill status={job.status} />
      </header>

      {/* tel: and maps: are plain links — no API call, and they work offline. */}
      <div className="mb-4 flex gap-2">
        <a
          href={job.customerPhone ? `tel:${job.customerPhone}` : undefined}
          aria-disabled={!job.customerPhone}
          className={`min-h-[44px] flex-1 rounded-xl py-3 text-center text-sm font-bold ${
            job.customerPhone ? "bg-brand text-ink-inverse" : "bg-surface-elevated text-ink-faint"
          }`}
        >
          📞 Call
        </a>
        <a
          href={job.address ? `maps:?q=${encodeURIComponent(job.address)}` : undefined}
          aria-disabled={!job.address}
          className="min-h-[44px] flex-1 rounded-xl border border-surface-border py-3 text-center text-sm font-bold"
        >
          🧭 Directions
        </a>
      </div>

      <Row k="Address" v={job.address ?? "—"} />
      <Row k="Technician" v={job.technicianName ?? "Unassigned"} />
      <Row k="Service" v={job.service ?? "—"} />
      {/* Booked, not paid — the mirror has no line items. Labelled so nobody
          reads it as revenue collected. */}
      <Row k="Booked amount" v={<span className="text-success">{money(job.amountCents)}</span>} />
      <Row
        k="Invoice"
        v={
          job.invoice ? (
            <span className={job.invoice.status === "paid" ? "text-success" : "text-warn"}>
              {money(job.invoice.amountCents)} · {job.invoice.status}
            </span>
          ) : (
            "—"
          )
        }
      />

      <h2 className="mb-2 mt-5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        Notes
      </h2>
      {job.notes.length === 0 ? (
        <p className="text-sm text-ink-faint">No notes on this job.</p>
      ) : (
        job.notes.map((n, i) => (
          <div key={i} className="mb-2 rounded-xl border border-surface-divider bg-surface-card p-3">
            <p className="text-sm text-ink-muted">{n.content}</p>
            {(n.author || n.createdAt) && (
              <p className="mt-1 text-[10px] text-ink-faint">
                {[n.author, n.createdAt?.slice(0, 10)].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        ))
      )}
    </main>
  );
}
```

- [ ] **Step 7: Run the suite and build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/lib/mobile/jobDetail.ts src/app/api/app/jobs src/app/app/jobs src/lib/mobile/__tests__/jobDetail.test.ts
git commit -m "feat(app): job detail with En Route, linked invoice and notes"
```

---

## Task 8: Customers — forgiving search and detail

**Files:**
- Create: `src/lib/mobile/phone.ts`, `src/lib/mobile/customers.ts`
- Create: `src/app/api/app/customers/route.ts`, `src/app/api/app/customers/[id]/route.ts`
- Create: `src/app/app/customers/page.tsx`, `src/app/app/customers/[id]/page.tsx`
- Test: `src/lib/mobile/__tests__/phone.test.ts`, `src/lib/mobile/__tests__/customers.test.ts`

**Interfaces:**
- Produces:
  - `normalizePhone(input: string): string` — digits only, US country code stripped
  - `formatPhone(digits: string | null): string | null` — `"(518) 555-0142"`
  - `searchCustomers(query: string, limit?: number): Promise<CustomerHit[]>`
  - `getCustomerDetail(id: string): Promise<CustomerDetail | null>`

```ts
interface CustomerHit { id: string; name: string; phone: string | null; address: string | null }
interface CustomerDetail extends CustomerHit {
  company: string | null;
  email: string | null;
  lifetimeCents: number;
  jobs: { id: string; scheduledStart: string | null; service: string | null; status: string | null; amountCents: number | null }[];
}
```

- [ ] **Step 1: Write the failing phone test**

```ts
// src/lib/mobile/__tests__/phone.test.ts
import { describe, it, expect } from "vitest";
import { normalizePhone, formatPhone } from "../phone";

describe("normalizePhone", () => {
  // All three of these are how a person actually types the same customer.
  it.each(["5185550142", "(518) 555-0142", "518-555-0142", "518.555.0142", "518 555 0142"])(
    "reduces %s to bare digits",
    (input) => expect(normalizePhone(input)).toBe("5185550142")
  );

  // A pasted number from a contact card often carries +1.
  it("strips a US country code", () => {
    expect(normalizePhone("+1 (518) 555-0142")).toBe("5185550142");
    expect(normalizePhone("15185550142")).toBe("5185550142");
  });

  // "518" must stay a usable prefix search, not become nothing.
  it("keeps a partial number as-is", () => {
    expect(normalizePhone("518")).toBe("518");
  });

  it("returns empty for text with no digits", () => {
    expect(normalizePhone("Kowalski")).toBe("");
  });
});

describe("formatPhone", () => {
  it("formats ten digits for display", () => {
    expect(formatPhone("5185550142")).toBe("(518) 555-0142");
  });

  // Never mangle something that isn't a 10-digit US number.
  it("passes anything else through untouched", () => {
    expect(formatPhone("5551234")).toBe("5551234");
    expect(formatPhone(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/mobile/__tests__/phone.test.ts`
Expected: FAIL — cannot resolve `../phone`

- [ ] **Step 3: Write phone.ts**

```ts
// src/lib/mobile/phone.ts

// HCP stores phone numbers in whatever shape they were entered. Search has to
// meet the user wherever they type, so both sides are reduced to digits.
export function normalizePhone(input: string): string {
  const digits = (input ?? "").replace(/\D/g, "");
  // 11 digits starting with 1 is a US number with its country code attached.
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

export function formatPhone(digits: string | null): string | null {
  if (!digits) return null;
  if (digits.length !== 10) return digits;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mobile/__tests__/phone.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Write the failing customers test**

```ts
// src/lib/mobile/__tests__/customers.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { orMock, supabaseMock } = vi.hoisted(() => ({ orMock: vi.fn(), supabaseMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { searchCustomers } from "../customers";

beforeEach(() => {
  vi.clearAllMocks();
  orMock.mockReturnValue({
    limit: () =>
      Promise.resolve({
        data: [
          {
            id: "cus_1",
            first_name: "Margaret",
            last_name: "Kowalski",
            company: null,
            phone: "5185550142",
            address_line1: "14 Sliter Rd",
            city: "Averill Park",
          },
        ],
        error: null,
      }),
  });
  supabaseMock.mockReturnValue({ from: () => ({ select: () => ({ or: orMock }) }) });
});

describe("searchCustomers", () => {
  it("returns a formatted hit", async () => {
    const hits = await searchCustomers("kowalski");
    expect(hits).toEqual([
      {
        id: "cus_1",
        name: "Margaret Kowalski",
        phone: "5185550142",
        address: "14 Sliter Rd, Averill Park",
      },
    ]);
  });

  // The whole point of forgiving search: a typed-out phone number must reach
  // the digits stored in the column.
  it("searches phone columns with the digits, not the punctuation", async () => {
    await searchCustomers("(518) 555-0142");
    expect(orMock.mock.calls[0][0]).toContain("5185550142");
    expect(orMock.mock.calls[0][0]).not.toContain("(518)");
  });

  it("searches name, company and address for a text query", async () => {
    await searchCustomers("sliter");
    const filter = orMock.mock.calls[0][0];
    for (const col of ["first_name", "last_name", "company", "address_line1", "city"]) {
      expect(filter).toContain(col);
    }
  });

  // A comma is PostgREST's `or()` separator; letting one through would corrupt
  // the filter and could widen the query beyond what was asked for.
  it("strips characters that would break the PostgREST filter", async () => {
    await searchCustomers("smith,*(");
    expect(orMock.mock.calls[0][0]).not.toContain(",*(");
  });

  it("returns nothing for a blank query rather than every customer", async () => {
    expect(await searchCustomers("   ")).toEqual([]);
    expect(orMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/lib/mobile/__tests__/customers.test.ts`
Expected: FAIL — cannot resolve `../customers`

- [ ] **Step 7: Write customers.ts**

```ts
// src/lib/mobile/customers.ts
import { getSupabaseServerClient } from "@/lib/supabase/client";
import { normalizePhone } from "./phone";

export interface CustomerHit {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
}

export interface CustomerDetail extends CustomerHit {
  company: string | null;
  email: string | null;
  lifetimeCents: number;
  jobs: {
    id: string;
    scheduledStart: string | null;
    service: string | null;
    status: string | null;
    amountCents: number | null;
  }[];
}

const DEFAULT_LIMIT = 25;

// PostgREST's or() takes a comma-separated filter list, so a comma, parenthesis
// or asterisk in user input would change the query's meaning rather than being
// searched for. Strip them instead of escaping — none are meaningful in a name,
// address or phone number.
function sanitize(term: string): string {
  return term.replace(/[,()*"\\]/g, " ").trim();
}

export async function searchCustomers(query: string, limit = DEFAULT_LIMIT): Promise<CustomerHit[]> {
  const term = sanitize(query);
  // A blank query must not become "select everything" — that is 1,497 rows and
  // a pointless round trip on every keystroke before the user has typed.
  if (!term) return [];

  const digits = normalizePhone(term);
  const textCols = ["first_name", "last_name", "company", "address_line1", "city"];
  const filters = textCols.map((c) => `${c}.ilike.%${term}%`);
  if (digits.length >= 3) filters.push(`phone.ilike.%${digits}%`);

  const { data, error } = await getSupabaseServerClient()
    .from("customers")
    .select("id, first_name, last_name, company, phone, address_line1, city")
    .or(filters.join(","))
    .limit(limit);

  if (error) throw new Error(`customer search failed: ${error.message}`);

  return (data ?? []).map(toHit);
}

interface CustomerRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  email?: string | null;
}

function toHit(c: CustomerRow): CustomerHit {
  return {
    id: c.id,
    name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company || "Unnamed customer",
    phone: c.phone ? normalizePhone(c.phone) : null,
    address: [c.address_line1, c.city].filter(Boolean).join(", ") || null,
  };
}

export async function getCustomerDetail(id: string): Promise<CustomerDetail | null> {
  const supabase = getSupabaseServerClient();

  const { data: customer, error } = await supabase
    .from("customers")
    .select("id, first_name, last_name, company, phone, email, address_line1, city")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`customer query failed: ${error.message}`);
  if (!customer) return null;

  // Bounded: one customer's history, newest first. No customer in the account
  // is anywhere near 500 jobs, and the range keeps the 1000-row cap explicit.
  const { data: jobs, error: jobsError } = await supabase
    .from("jobs")
    .select("id, work_status, scheduled_start, total_amount_cents, raw")
    .eq("customer_id", id)
    .order("scheduled_start", { ascending: false })
    .range(0, 499);

  if (jobsError) throw new Error(`customer jobs query failed: ${jobsError.message}`);

  const rows = (jobs ?? []) as Array<{
    id: string;
    work_status: string | null;
    scheduled_start: string | null;
    total_amount_cents: number | null;
    raw?: { job_fields?: { job_type?: { name?: string } }; description?: string };
  }>;

  const CANCELED = new Set(["pro canceled", "user canceled"]);

  return {
    ...toHit(customer),
    company: customer.company,
    email: customer.email ?? null,
    // Canceled work never happened, so it must not inflate lifetime value.
    lifetimeCents: rows
      .filter((j) => !CANCELED.has((j.work_status ?? "").toLowerCase()))
      .reduce((sum, j) => sum + (j.total_amount_cents ?? 0), 0),
    jobs: rows.map((j) => ({
      id: j.id,
      scheduledStart: j.scheduled_start,
      service:
        j.raw?.job_fields?.job_type?.name?.trim() || j.raw?.description?.split("\n")[0]?.trim() || null,
      status: j.work_status,
      amountCents: j.total_amount_cents,
    })),
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/lib/mobile/__tests__/customers.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 9: Write both routes**

```ts
// src/app/api/app/customers/route.ts
import { searchCustomers } from "@/lib/mobile/customers";
import { appJson, appError } from "@/lib/mobile/envelope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  try {
    return appJson({ query: q, hits: await searchCustomers(q) });
  } catch (err) {
    return appError(
      `Search failed: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
```

```ts
// src/app/api/app/customers/[id]/route.ts
import { getCustomerDetail } from "@/lib/mobile/customers";
import { appJson, appError } from "@/lib/mobile/envelope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const detail = await getCustomerDetail(params.id);
    if (!detail) return appError("Customer not found.", 404);
    return appJson(detail);
  } catch (err) {
    return appError(
      `Couldn't load the customer: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
```

- [ ] **Step 10: Write the search page**

```tsx
// src/app/app/customers/page.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatPhone } from "@/lib/mobile/phone";
import { EmptyState } from "@/components/mobile/EmptyState";

interface CustomerHit { id: string; name: string; phone: string | null; address: string | null }

const RECENT_KEY = "trinity.recentCustomers";

function readRecent(): CustomerHit[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export default function CustomersPage() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CustomerHit[] | null>(null);
  const [recent, setRecent] = useState<CustomerHit[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setRecent(readRecent()), []);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setHits(null);
      return;
    }
    // 250ms is long enough that a typist does not fire a query per character,
    // short enough that it still feels instant.
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/app/customers?q=${encodeURIComponent(term)}`, {
          credentials: "same-origin",
        });
        const body = await res.json();
        if (!res.ok) {
          setError(body.error ?? "Search failed.");
          return;
        }
        setHits(body.data.hits);
        setError(null);
      } catch {
        setError("Offline — search needs a connection.");
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  const list = hits ?? recent;

  return (
    <main className="px-3 pt-3">
      <h1 className="mb-3 text-xl font-bold tracking-tight">Customers</h1>

      <input
        type="search"
        inputMode="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Name, phone or address"
        className="mb-3 min-h-[44px] w-full rounded-full border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint"
      />

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {!hits && recent.length > 0 && (
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          Recently viewed
        </h2>
      )}

      {list.length === 0 ? (
        <EmptyState>
          {hits ? `No customer matches "${query}".` : "Search by name, phone or address."}
        </EmptyState>
      ) : (
        list.map((c) => (
          <Link
            key={c.id}
            href={`/app/customers/${c.id}`}
            className="mb-2 block min-h-[44px] rounded-xl border border-surface-divider bg-surface-card px-3 py-2.5"
          >
            <div className="text-sm font-semibold">{c.name}</div>
            <div className="mt-0.5 text-xs text-ink-muted">
              {[formatPhone(c.phone), c.address].filter(Boolean).join(" · ")}
            </div>
          </Link>
        ))
      )}
    </main>
  );
}
```

- [ ] **Step 11: Write the customer detail page**

```tsx
// src/app/app/customers/[id]/page.tsx
"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useAppData } from "@/components/mobile/useAppData";
import { formatPhone } from "@/lib/mobile/phone";

interface CustomerDetail {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  company: string | null;
  email: string | null;
  lifetimeCents: number;
  jobs: {
    id: string;
    scheduledStart: string | null;
    service: string | null;
    status: string | null;
    amountCents: number | null;
  }[];
}

const RECENT_KEY = "trinity.recentCustomers";
const RECENT_MAX = 8;

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export default function CustomerPage({ params }: { params: { id: string } }) {
  const { data, error } = useAppData<CustomerDetail>(`/api/app/customers/${params.id}`);

  // Recording the visit here (not on tap) means the list only ever holds
  // customers that actually resolved.
  useEffect(() => {
    if (!data) return;
    try {
      const entry = { id: data.id, name: data.name, phone: data.phone, address: data.address };
      const prior = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as { id: string }[];
      const next = [entry, ...prior.filter((c) => c.id !== data.id)].slice(0, RECENT_MAX);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {}
  }, [data]);

  if (error) {
    return (
      <main className="px-3 pt-3">
        <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      </main>
    );
  }
  if (!data) return <main className="px-3 pt-3 text-sm text-ink-faint">Loading…</main>;

  return (
    <main className="px-3 pt-3">
      <header className="mb-3 flex items-center gap-2">
        <Link href="/app/customers" aria-label="Back" className="min-h-[44px] px-1 text-xl text-brand">
          ‹
        </Link>
        <div>
          <h1 className="text-lg font-bold tracking-tight">{data.name}</h1>
          {data.company && <p className="text-xs text-ink-faint">{data.company}</p>}
        </div>
      </header>

      <div className="mb-4 flex gap-2">
        <a
          href={data.phone ? `tel:${data.phone}` : undefined}
          className={`min-h-[44px] flex-1 rounded-xl py-3 text-center text-sm font-bold ${
            data.phone ? "bg-brand text-ink-inverse" : "bg-surface-elevated text-ink-faint"
          }`}
        >
          📞 {formatPhone(data.phone) ?? "No number"}
        </a>
        <a
          href={data.address ? `maps:?q=${encodeURIComponent(data.address)}` : undefined}
          className="min-h-[44px] rounded-xl border border-surface-border px-4 py-3 text-center text-sm font-bold"
        >
          🧭
        </a>
      </div>

      <div className="mb-4 flex gap-2">
        <div className="flex-1 rounded-xl border border-surface-divider bg-surface-card p-3 text-center">
          <div className="font-mono text-lg font-bold">{data.jobs.length}</div>
          <div className="text-[10px] uppercase text-ink-faint">Jobs</div>
        </div>
        <div className="flex-1 rounded-xl border border-surface-divider bg-surface-card p-3 text-center">
          <div className="font-mono text-lg font-bold text-success">{money(data.lifetimeCents)}</div>
          <div className="text-[10px] uppercase text-ink-faint">Lifetime</div>
        </div>
      </div>

      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        History
      </h2>
      {data.jobs.map((j) => (
        <Link
          key={j.id}
          href={`/app/jobs/${j.id}`}
          className="mb-2 block min-h-[44px] rounded-xl border border-surface-divider bg-surface-card px-3 py-2.5"
        >
          <div className="flex justify-between text-sm">
            <span className="font-medium">{j.service ?? "Job"}</span>
            <span className="text-ink-muted">
              {j.amountCents == null ? "" : money(j.amountCents)}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">
            {[j.scheduledStart?.slice(0, 10), j.status].filter(Boolean).join(" · ")}
          </div>
        </Link>
      ))}
    </main>
  );
}
```

- [ ] **Step 12: Run the suite and build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add src/lib/mobile/phone.ts src/lib/mobile/customers.ts src/app/api/app/customers src/app/app/customers src/lib/mobile/__tests__
git commit -m "feat(app): customer search with phone normalization, detail and history"
```

---

## Task 9: Money tab — estimates and invoices

**Files:**
- Create: `src/lib/mobile/money.ts`, `src/app/api/app/money/route.ts`, `src/app/app/money/page.tsx`
- Test: `src/lib/mobile/__tests__/money.test.ts`

**Interfaces:**
- Produces:
  - `listOpenEstimates(): Promise<EstimateHit[]>`
  - `listUnpaidInvoices(now?: Date): Promise<InvoiceHit[]>`
  - `GET /api/app/money` → `{ data: MoneyPayload, generated_at }`

```ts
interface EstimateHit { id: string; customerName: string | null; amountCents: number | null; status: string | null }
interface InvoiceHit { id: string; customerName: string | null; amountCents: number | null; status: string | null; dueDate: string | null; overdueDays: number | null }
interface MoneyPayload {
  estimates: EstimateHit[];        // open only, biggest first
  estimatesTotalCents: number;
  invoices: InvoiceHit[];          // unpaid only, most overdue first
  invoicesTotalCents: number;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/mobile/__tests__/money.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { listOpenEstimates, listUnpaidInvoices } from "../money";

function mockRows(rows: Record<string, unknown[]>) {
  supabaseMock.mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        range: () => Promise.resolve({ data: rows[table] ?? [], error: null }),
      }),
    }),
  });
}

const CUSTOMERS = [{ id: "cus_1", first_name: "R.", last_name: "Whitfield", company: null }];

describe("listOpenEstimates", () => {
  beforeEach(() => vi.clearAllMocks());

  // isOpenEstimate() is the shipped definition — an estimate with an approved
  // option is not open, and neither is one in a terminal work_status.
  it("keeps only estimates isOpenEstimate accepts", async () => {
    mockRows({
      customers: CUSTOMERS,
      estimates: [
        { id: "csr_1", customer_id: "cus_1", status: "scheduled", amount_cents: 894_000, raw: { options: [{ approval_status: null }] } },
        { id: "csr_2", customer_id: "cus_1", status: "scheduled", amount_cents: 100_000, raw: { options: [{ approval_status: "pro approved" }] } },
        { id: "csr_3", customer_id: "cus_1", status: "created job from estimate", amount_cents: 50_000, raw: { options: [{ approval_status: null }] } },
      ],
    });

    const open = await listOpenEstimates();
    expect(open.map((e) => e.id)).toEqual(["csr_1"]);
  });

  it("resolves the customer name from the local table", async () => {
    mockRows({
      customers: CUSTOMERS,
      estimates: [{ id: "csr_1", customer_id: "cus_1", status: "scheduled", amount_cents: 1, raw: { options: [{ approval_status: null }] } }],
    });
    expect((await listOpenEstimates())[0].customerName).toBe("R. Whitfield");
  });
});

describe("listUnpaidInvoices", () => {
  beforeEach(() => vi.clearAllMocks());

  // Live invoice statuses are paid/canceled/voided/open. "open" is the unpaid
  // state; there is no "pending". Canceled and voided are not debts.
  it("keeps only open invoices", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [
        { id: "inv_1", customer_id: "cus_1", status: "open", amount_cents: 187_500, due_date: "2026-06-06" },
        { id: "inv_2", customer_id: "cus_1", status: "paid", amount_cents: 10_000, due_date: "2026-06-06" },
        { id: "inv_3", customer_id: "cus_1", status: "voided", amount_cents: 10_000, due_date: "2026-06-06" },
        { id: "inv_4", customer_id: "cus_1", status: "canceled", amount_cents: 10_000, due_date: "2026-06-06" },
      ],
    });
    expect((await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z"))).map((i) => i.id)).toEqual(["inv_1"]);
  });

  it("counts overdue days from the due date", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [{ id: "inv_1", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: "2026-06-06" }],
    });
    const [invoice] = await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z"));
    expect(invoice.overdueDays).toBe(61);
  });

  it("reports null overdue days for an invoice not yet due", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [{ id: "inv_1", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: "2026-09-01" }],
    });
    expect((await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z")))[0].overdueDays).toBeNull();
  });

  it("sorts the most overdue first", async () => {
    mockRows({
      customers: CUSTOMERS,
      invoices: [
        { id: "inv_new", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: "2026-08-01" },
        { id: "inv_old", customer_id: "cus_1", status: "open", amount_cents: 1, due_date: "2026-05-01" },
      ],
    });
    expect((await listUnpaidInvoices(new Date("2026-08-06T12:00:00Z"))).map((i) => i.id)).toEqual([
      "inv_old",
      "inv_new",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/mobile/__tests__/money.test.ts`
Expected: FAIL — cannot resolve `../money`

- [ ] **Step 3: Write money.ts**

```ts
// src/lib/mobile/money.ts
import { getSupabaseServerClient } from "@/lib/supabase/client";

export interface EstimateHit {
  id: string;
  customerName: string | null;
  amountCents: number | null;
  status: string | null;
}

export interface InvoiceHit {
  id: string;
  customerName: string | null;
  amountCents: number | null;
  status: string | null;
  dueDate: string | null;
  overdueDays: number | null;
}

const PAGE_SIZE = 1000;

// Same paging discipline as fetchAllRows in src/lib/dashboard/queries.ts:
// PostgREST truncates at 1000 rows silently, and this account holds ~2.9k
// invoices. A bare select would quietly hide a third of the debt.
async function fetchAll<T>(table: string, columns: string): Promise<T[]> {
  const supabase = getSupabaseServerClient();
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table} query failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

interface CustomerRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
}

async function customerNames(): Promise<Map<string, string>> {
  const rows = await fetchAll<CustomerRow>("customers", "id, first_name, last_name, company");
  return new Map(
    rows.map((c) => [
      c.id,
      [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company || "Unnamed customer",
    ])
  );
}

// Duplicated deliberately from queries.ts, where it is module-private. The
// value sets are the shipped definition of "open"; if they change there, they
// must change here. Covered by tests on both sides.
const TERMINAL_ESTIMATE_STATUSES = new Set([
  "created job from estimate",
  "user canceled",
  "pro canceled",
]);
const APPROVED_STATUSES = new Set(["approved", "pro approved"]);

interface EstimateRow {
  id: string;
  customer_id: string | null;
  status: string | null;
  amount_cents: number | null;
  raw?: { options?: { approval_status?: string | null }[] };
}

function isOpen(e: EstimateRow): boolean {
  if (TERMINAL_ESTIMATE_STATUSES.has((e.status ?? "").toLowerCase())) return false;
  const options = e.raw?.options ?? [];
  if (options.some((o) => APPROVED_STATUSES.has((o.approval_status ?? "").toLowerCase()))) return false;
  return options.some((o) => !o.approval_status);
}

export async function listOpenEstimates(): Promise<EstimateHit[]> {
  const [rows, names] = await Promise.all([
    fetchAll<EstimateRow>("estimates", "id, customer_id, status, amount_cents, raw"),
    customerNames(),
  ]);

  return rows
    .filter(isOpen)
    .map((e) => ({
      id: e.id,
      customerName: e.customer_id ? names.get(e.customer_id) ?? null : null,
      amountCents: e.amount_cents,
      status: e.status,
    }))
    .sort((a, b) => (b.amountCents ?? 0) - (a.amountCents ?? 0));
}

// Live statuses: paid 2217 | canceled 570 | voided 42 | open 25. "open" is the
// unpaid state and there is no "pending"; canceled and voided are not debts.
const INVOICE_UNPAID = "open";

interface InvoiceRow {
  id: string;
  customer_id: string | null;
  status: string | null;
  amount_cents: number | null;
  due_date: string | null;
}

const DAY_MS = 86_400_000;

export async function listUnpaidInvoices(now: Date = new Date()): Promise<InvoiceHit[]> {
  const [rows, names] = await Promise.all([
    fetchAll<InvoiceRow>("invoices", "id, customer_id, status, amount_cents, due_date"),
    customerNames(),
  ]);

  return rows
    .filter((i) => (i.status ?? "").toLowerCase() === INVOICE_UNPAID)
    .map((i) => {
      const dueMs = i.due_date ? Date.parse(`${i.due_date}T00:00:00Z`) : NaN;
      const days = Number.isNaN(dueMs) ? null : Math.floor((now.getTime() - dueMs) / DAY_MS);
      return {
        id: i.id,
        customerName: i.customer_id ? names.get(i.customer_id) ?? null : null,
        amountCents: i.amount_cents,
        status: i.status,
        dueDate: i.due_date,
        overdueDays: days != null && days > 0 ? days : null,
      };
    })
    .sort((a, b) => (b.overdueDays ?? -1) - (a.overdueDays ?? -1));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mobile/__tests__/money.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the route**

```ts
// src/app/api/app/money/route.ts
import { listOpenEstimates, listUnpaidInvoices } from "@/lib/mobile/money";
import { appJson, appError } from "@/lib/mobile/envelope";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [estimates, invoices] = await Promise.all([listOpenEstimates(), listUnpaidInvoices()]);
    return appJson({
      estimates,
      estimatesTotalCents: estimates.reduce((s, e) => s + (e.amountCents ?? 0), 0),
      invoices,
      invoicesTotalCents: invoices.reduce((s, i) => s + (i.amountCents ?? 0), 0),
    });
  } catch (err) {
    return appError(
      `Couldn't load money: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
```

- [ ] **Step 6: Write the Money page**

```tsx
// src/app/app/money/page.tsx
"use client";

import { useState } from "react";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { EmptyState } from "@/components/mobile/EmptyState";

interface EstimateHit { id: string; customerName: string | null; amountCents: number | null; status: string | null }
interface InvoiceHit { id: string; customerName: string | null; amountCents: number | null; status: string | null; dueDate: string | null; overdueDays: number | null }
interface MoneyPayload {
  estimates: EstimateHit[];
  estimatesTotalCents: number;
  invoices: InvoiceHit[];
  invoicesTotalCents: number;
}

const money = (cents: number | null) =>
  cents == null
    ? "—"
    : `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export default function MoneyPage() {
  const [tab, setTab] = useState<"estimates" | "invoices">("estimates");
  const { data, generatedAt, error, fromCache } = useAppData<MoneyPayload>("/api/app/money");

  return (
    <main className="px-3 pt-3">
      <header className="mb-3">
        <h1 className="text-xl font-bold tracking-tight">Money</h1>
        <FreshnessStamp generatedAt={generatedAt} fromCache={fromCache} />
      </header>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mb-3 flex rounded-xl border border-surface-divider bg-surface-card p-1">
        {(["estimates", "invoices"] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`min-h-[44px] flex-1 rounded-lg text-sm capitalize ${
              tab === key ? "bg-brand font-bold text-ink-inverse" : "text-ink-muted"
            }`}
          >
            {key} {data ? (key === "estimates" ? data.estimates.length : data.invoices.length) : ""}
          </button>
        ))}
      </div>

      {data && tab === "estimates" && (
        <>
          <div className="mb-3 rounded-xl border border-surface-divider bg-surface-card p-3">
            <div className="font-mono text-xl font-bold text-warn">
              {money(data.estimatesTotalCents)}
            </div>
            <div className="text-xs text-ink-faint">
              Awaiting a response · {data.estimates.length} estimates
            </div>
          </div>
          {data.estimates.length === 0 ? (
            <EmptyState>No estimates are waiting on a customer.</EmptyState>
          ) : (
            data.estimates.map((e) => (
              <div
                key={e.id}
                className="mb-2 rounded-xl border border-surface-divider border-l-2 border-l-warn bg-surface-card px-3 py-2.5"
              >
                <div className="flex justify-between text-sm">
                  <span className="font-semibold">{e.customerName ?? "Unknown customer"}</span>
                  <span className="font-mono text-ink-muted">{money(e.amountCents)}</span>
                </div>
                {e.status && <div className="mt-0.5 text-xs text-ink-faint">{e.status}</div>}
              </div>
            ))
          )}
        </>
      )}

      {data && tab === "invoices" && (
        <>
          <div className="mb-3 rounded-xl border border-surface-divider bg-surface-card p-3">
            <div className="font-mono text-xl font-bold text-warn">
              {money(data.invoicesTotalCents)}
            </div>
            <div className="text-xs text-ink-faint">Unpaid · {data.invoices.length} invoices</div>
          </div>
          {data.invoices.length === 0 ? (
            <EmptyState>Nothing outstanding. Every invoice is settled.</EmptyState>
          ) : (
            data.invoices.map((i) => (
              <div
                key={i.id}
                className={`mb-2 rounded-xl border border-surface-divider border-l-2 bg-surface-card px-3 py-2.5 ${
                  i.overdueDays ? "border-l-danger" : "border-l-warn"
                }`}
              >
                <div className="flex justify-between text-sm">
                  <span className="font-semibold">{i.customerName ?? "Unknown customer"}</span>
                  <span className="font-mono text-ink-muted">{money(i.amountCents)}</span>
                </div>
                <div className="mt-0.5 text-xs">
                  {i.overdueDays ? (
                    <span className="text-danger">{i.overdueDays} days overdue</span>
                  ) : (
                    <span className="text-ink-faint">Due {i.dueDate ?? "—"}</span>
                  )}
                </div>
              </div>
            ))
          )}
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 7: Run the suite and build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/lib/mobile/money.ts src/app/api/app/money src/app/app/money src/lib/mobile/__tests__/money.test.ts
git commit -m "feat(app): Money tab — open estimates and unpaid invoices with overdue ageing"
```

---

## Task 10: Dispatch tab

**Files:**
- Create: `src/app/app/dispatch/page.tsx`
- Test: none beyond the build — the route `/api/dispatch/nearby` and its logic are already tested in `src/lib/dispatch/__tests__/`.

**Interfaces:**
- Consumes: existing `GET /api/dispatch/nearby?q=&radius=&days=` returning
  `{ location, radiusMiles, days, matches, all }` where each day is
  `{ dateKey, jobs, summary, detourMinutes }`.
- Produces: `/app/dispatch`.

> **Why no new route:** `/api/dispatch/nearby` predates the middleware matcher, which only covers `/api/app/*`. It stays unauthenticated exactly as it is today, which is the same posture as the existing `/dispatch` page. Changing that is out of scope for Phase 1 and is noted in Task 12's follow-ups.

- [ ] **Step 1: Confirm the response shape**

Already verified against `src/app/dispatch/NearbySearch.tsx` and `src/app/api/dispatch/nearby/route.ts`: the response is `{ location, radiusMiles, days, matches, all }`, and each entry in `matches` is `{ dateKey: "YYYY-MM-DD", jobs: NearbyJob[], summary: string, detourMinutes: number | null }`. Skim `NearbySearch.tsx` to confirm nothing has changed, then write the page below.

- [ ] **Step 2: Write the Dispatch page**

```tsx
// src/app/app/dispatch/page.tsx
"use client";

import { useState } from "react";
import { EmptyState } from "@/components/mobile/EmptyState";

interface NearbyDay {
  dateKey: string;
  jobs: { id: string }[];
  summary: string;
  detourMinutes: number | null;
}

// dateKey is a local YYYY-MM-DD from localDateKey(). Anchoring at 12:00Z before
// formatting keeps it on the right calendar day under either DST offset — the
// same approach dayLabel() uses in the desktop NearbySearch.
function dayLabel(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

export default function DispatchPage() {
  const [query, setQuery] = useState("");
  const [days, setDays] = useState<NearbyDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const term = query.trim();
    if (!term) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dispatch/nearby?q=${encodeURIComponent(term)}`, {
        credentials: "same-origin",
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Lookup failed.");
        setDays(null);
        return;
      }
      setDays(body.matches);
    } catch {
      setError("Offline — this lookup needs a connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="px-3 pt-3">
      <header className="mb-3">
        <h1 className="text-xl font-bold tracking-tight">Dispatch</h1>
        <p className="text-xs text-ink-faint">Are we already going near there?</p>
      </header>

      <form onSubmit={search} className="mb-3 flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Town or full address"
          className="min-h-[44px] flex-1 rounded-full border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint"
        />
        <button
          type="submit"
          disabled={busy}
          className="min-h-[44px] rounded-full bg-brand px-5 text-sm font-bold text-ink-inverse disabled:opacity-60"
        >
          {busy ? "…" : "Go"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {days && days.length === 0 && (
        <EmptyState>
          Nothing booked near there in the next two weeks. A town with no history resolves to
          nothing — which is itself the answer.
        </EmptyState>
      )}

      {days?.map((d, i) => (
        <div
          key={d.dateKey}
          className={`mb-2 rounded-xl border px-3 py-2.5 ${
            i === 0 ? "border-brand bg-brand-tint" : "border-surface-divider bg-surface-card"
          }`}
        >
          {i === 0 && (
            <div className="text-[10px] font-bold uppercase tracking-wider text-brand">Best day</div>
          )}
          <div className="mt-0.5 text-sm font-semibold">{dayLabel(d.dateKey)}</div>
          <div className="mt-0.5 text-xs text-ink-muted">{d.summary}</div>
          {d.detourMinutes != null && (
            <div className="mt-0.5 text-xs text-ink-faint">≈ {d.detourMinutes} min detour</div>
          )}
        </div>
      ))}
    </main>
  );
}
```

- [ ] **Step 3: Run the suite and build**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/app/dispatch
git commit -m "feat(app): Dispatch tab — mobile nearby-work lookup"
```

---

## Task 11: Service worker — instant open, offline reads, freshness

**Files:**
- Create: `public/sw.js`, `src/components/mobile/ServiceWorkerRegistrar.tsx`
- Modify: `src/app/app/layout.tsx`
- Test: `src/components/mobile/__tests__/ServiceWorkerRegistrar.test.tsx`

**Interfaces:**
- Consumes: `useAppData`'s `X-Trinity-Cache: hit` contract from Task 3.
- Produces: a service worker scoped to `/app/` that precaches the shell and serves `/api/app/*` stale-while-revalidate.

- [ ] **Step 1: Write the service worker**

```js
// public/sw.js
// Scoped to /app/ — the desktop dashboard at /dashboard is deliberately NOT
// controlled by this worker and keeps its normal server-rendered behaviour.
const VERSION = "v1";
const SHELL_CACHE = `trinity-shell-${VERSION}`;
const DATA_CACHE = `trinity-data-${VERSION}`;

const SHELL = ["/app/today", "/app/schedule", "/app/customers", "/app/money", "/app/dispatch"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Individually, not addAll: addAll rejects the whole install if any one
      // request fails, which would leave the app with no worker at all.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/app/")) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (url.pathname.startsWith("/app/")) {
    event.respondWith(networkFirstShell(request));
  }
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(DATA_CACHE);

  try {
    const fresh = await fetch(request);
    // Never cache a 401 — a signed-out reply must not become the screen's
    // permanent "data".
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (!cached) throw new Error("offline and uncached");

    // Tell the UI this is stale so FreshnessStamp can say "Offline — showing
    // data from 8:42a" instead of implying the data is current.
    const headers = new Headers(cached.headers);
    headers.set("X-Trinity-Cache", "hit");
    return new Response(await cached.blob(), {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Last resort: any cached tab beats a browser error page.
    return (await cache.match("/app/today")) ?? Response.error();
  }
}
```

- [ ] **Step 2: Write the failing registrar test**

```tsx
// src/components/mobile/__tests__/ServiceWorkerRegistrar.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { ServiceWorkerRegistrar } from "../ServiceWorkerRegistrar";

describe("ServiceWorkerRegistrar", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("registers the worker scoped to /app/", async () => {
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    render(<ServiceWorkerRegistrar />);

    await waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/app/" }));
  });

  // Older iOS versions and private browsing have no serviceWorker at all. The
  // app must still work, just without offline support.
  it("does nothing when the browser has no service worker support", () => {
    vi.stubGlobal("navigator", {});
    expect(() => render(<ServiceWorkerRegistrar />)).not.toThrow();
  });

  it("swallows a registration failure rather than breaking the page", async () => {
    const register = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    render(<ServiceWorkerRegistrar />);

    await waitFor(() => expect(register).toHaveBeenCalled());
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/components/mobile/__tests__/ServiceWorkerRegistrar.test.tsx`
Expected: FAIL — cannot resolve `../ServiceWorkerRegistrar`

- [ ] **Step 4: Write the registrar and mount it**

```tsx
// src/components/mobile/ServiceWorkerRegistrar.tsx
"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    // Registration failing is not an error worth surfacing — the app works
    // without it, just without offline reads.
    navigator.serviceWorker.register("/sw.js", { scope: "/app/" }).catch(() => {});
  }, []);

  return null;
}
```

Add to `src/app/app/layout.tsx`, inside the wrapper div alongside `<TabBar />`:

```tsx
import { ServiceWorkerRegistrar } from "@/components/mobile/ServiceWorkerRegistrar";
// ...
      <ServiceWorkerRegistrar />
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/mobile/__tests__/ServiceWorkerRegistrar.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 6: Verify offline behaviour by hand**

```bash
npm run build && npm start
```

In Chrome DevTools (desktop is fine for this check):
1. Load `http://localhost:3000/app/today`, sign in.
2. Application → Service Workers: confirm `/sw.js` is activated with scope `/app/`.
3. Network → **Offline**, then reload.
4. Expected: the page still renders, and the header reads **"Offline — showing data from …"** rather than an error.

- [ ] **Step 7: Commit**

```bash
git add public/sw.js src/components/mobile/ServiceWorkerRegistrar.tsx src/app/app/layout.tsx src/components/mobile/__tests__/ServiceWorkerRegistrar.test.tsx
git commit -m "feat(app): service worker — instant open, offline reads, cache-hit signalling"
```

---

## Task 12: Documentation and the iPhone install runbook

**Files:**
- Modify: `README.md`, `docs/PHASE-1.x-BACKLOG.md`
- Create: `docs/MOBILE-INSTALL.md`

- [ ] **Step 1: Write the install runbook**

Create `docs/MOBILE-INSTALL.md` covering, in order:

1. **Create the accounts** — Supabase → Authentication → Users → Add user, with Auto Confirm enabled. Then Providers → Email → **disable "Enable sign ups"**.
2. **Install on iPhone** — open `https://<domain>/app/today` in **Safari** (not Chrome), Share → Add to Home Screen. State plainly that Chrome on iOS is not the install path and that the installed app keeps its own login.
3. **Verification checklist**, each with its expected result:
   - Signed out, `/app/today` redirects to `/app/login`.
   - Signing in lands on Today with the correct date in Eastern time.
   - Each of the five tabs loads and shows a freshness stamp.
   - A job opens from Today and shows status, address, booked amount, invoice.
   - `tel:` prompts to call; `maps:` opens Maps.
   - Customer search finds a known customer by name **and** by `(518) 555-0142`.
   - Airplane mode: previously-visited screens still render and say "Offline — showing data from …".
4. **Known Phase 1 limits** — no notifications yet (Phase 2), no writes, no desktop layout, `/api/dispatch/nearby` remains unauthenticated as it is today.

- [ ] **Step 2: Add a README section**

Add a "Mobile app (`/app`)" section after the existing "Local development" section: what it is, the five tabs, that auth is Supabase Auth with hand-created accounts, that the service-role key never reaches the browser, and a link to `docs/MOBILE-INSTALL.md` and the spec.

- [ ] **Step 3: Strike the stale backlog item**

In `docs/PHASE-1.x-BACKLOG.md`, item 2 under "Confirmed by Task 0" claims `openEstimates` will read 0 and needs redefining. That was resolved — `isOpenEstimate()` in `src/lib/dashboard/queries.ts` implements it against `raw.options[].approval_status`. Mark the item **RESOLVED**, naming the function, and note that the Money tab reuses that definition.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/MOBILE-INSTALL.md docs/PHASE-1.x-BACKLOG.md
git commit -m "docs: mobile install runbook, README section, strike resolved estimates item"
```

---

## Phase 1 exit criteria

- [ ] `npm test` passes; `npm run build` is clean.
- [ ] Signed out, every `/app/*` page redirects to login and every `/api/app/*` route returns 401 JSON.
- [ ] All five tabs render live data from the mirror with a visible freshness stamp.
- [ ] The app installs to an iPhone home screen from Safari and opens standalone.
- [ ] With the network off, previously-visited screens render and say so.
- [ ] `docs/MOBILE-INSTALL.md` has been followed end-to-end on a real iPhone.

## Deferred to Phase 2

Push notifications and VAPID; the ack flow and `job_acks`; quiet hours and per-type switches; the app icon badge; the write actions (note, approve/decline, create customer) with undo and the offline write queue; and the probe confirming whether `HOUSECALL_API_KEY` is authorized for `POST /estimates/options/approve`.
