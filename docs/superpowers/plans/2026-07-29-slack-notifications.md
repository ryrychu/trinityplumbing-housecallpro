# Slack Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post Housecall Pro activity to three Slack channels — a 6:00 a.m. weekday schedule digest plus a Monday week-ahead, paid invoices, and approved estimates.

**Architecture:** A notification layer beside the existing sync pipeline. Estimate approvals fire from the HCP webhook route (instant). Paid invoices are polled with a targeted `status=paid&paid_at_min=` query from the cron route (HCP has no invoice webhook). Both post through one Slack client and one `notifications_sent` dedupe table. Digest timing is decided in timezone-aware TypeScript, not in a cron expression.

**Tech Stack:** Next.js 14 (App Router), TypeScript, Supabase (`@supabase/supabase-js`), Vitest, Slack incoming webhooks. **No new npm dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-29-slack-notifications-design.md`

## Global Constraints

- **No new npm dependencies.** Timezone work uses `Intl.DateTimeFormat`, already the approach in `src/lib/dashboard/week.ts`.
- **Business timezone is `America/New_York`**, everywhere, always.
- **All money is stored in cents** (`amount_cents`, `total_amount_cents`). Convert to dollars only in `src/lib/slack/format.ts`.
- **Slack failures must never fail sync.** Every Slack call is caught and logged; nothing propagates.
- **A missing webhook URL is a skip, not an error.**
- **`SLACK_ALERTS_ENABLED` defaults to off.** Only `"true"` enables posting.
- **Never `select("*")` on a synced table.** PostgREST caps responses at 1000 rows; this already caused a real bug (19 jobs reported instead of 91).
- **Live invoice statuses:** `paid` · `canceled` · `voided` · `open`. There is no `pending`.
- **Estimate approval is per-option**, at `raw.options[].approval_status`, approved values `approved` and `pro approved`.
- Test command is `npx vitest run <path>`; full suite `npm test`. Existing suite is 57 tests and must stay green.
- Path alias `@/` → `src/`.

---

### Task 1: Probe the live HCP invoice filters

The spec's targeted-polling design depends on query parameters documented in `housecall.v1.yaml` but **not yet verified against the live account** — the same file previously documented `updated_after`, which the live API silently ignores. Verify before building on it.

**Files:**
- Create: `scripts/probe-invoice-filters.mjs`
- Modify: `docs/PHASE-1.x-BACKLOG.md` (append findings)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded yes/no answer that Task 8 branches on.

- [ ] **Step 1: Write the probe script**

Follows the existing `scripts/probe-incremental.mjs` pattern (plain `.mjs`, reads `.env.local`, hits the live API, prints findings).

```javascript
// scripts/probe-invoice-filters.mjs
// Verifies whether the live HCP account honors the /invoices query params that
// housecall.v1.yaml documents (status, paid_at_min, sort_by=paid_at).
// The spec has been wrong before: item 4 found updated_after silently ignored.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim();
}

const KEY = process.env.HOUSECALL_API_KEY;
if (!KEY) throw new Error("Missing HOUSECALL_API_KEY in .env.local");

async function get(qs) {
  const res = await fetch(`https://api.housecallpro.com/invoices?${qs}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  if (!res.ok) return { error: `${res.status} ${await res.text()}` };
  const json = await res.json();
  return { items: json.invoices ?? [], total: json.total_pages };
}

const baseline = await get("page=1&page_size=50");
console.log("baseline           :", baseline.items?.length, "items, total_pages", baseline.total);
console.log("  sample keys      :", Object.keys(baseline.items?.[0] ?? {}).join(", "));

const paidOnly = await get("page=1&page_size=50&status=paid");
const statuses = new Set((paidOnly.items ?? []).map((i) => i.status));
console.log("status=paid        :", paidOnly.items?.length, "items, statuses seen:", [...statuses]);
console.log("  FILTER WORKS?    :", statuses.size === 1 && statuses.has("paid"));

const since = new Date(Date.now() - 30 * 86400000).toISOString();
const recent = await get(`page=1&page_size=50&status=paid&paid_at_min=${since}`);
const older = (recent.items ?? []).filter((i) => i.paid_at && i.paid_at < since);
console.log(`paid_at_min=${since}`);
console.log("                   :", recent.items?.length, "items,", older.length, "older than cutoff");
console.log("  FILTER WORKS?    :", recent.items?.length > 0 && older.length === 0);

const sorted = await get("page=1&page_size=50&status=paid&sort_by=paid_at&sort_direction=desc");
const paidAts = (sorted.items ?? []).map((i) => i.paid_at).filter(Boolean);
const desc = paidAts.every((v, i) => i === 0 || paidAts[i - 1] >= v);
console.log("sort_by=paid_at    :", paidAts.length, "with paid_at, descending?", desc);
```

- [ ] **Step 2: Run the probe against the live account**

Run: `node scripts/probe-invoice-filters.mjs`

Expected: three `FILTER WORKS?` lines printing `true` or `false`, plus the descending check. Record the actual output — do not guess.

- [ ] **Step 3: Record the findings**

Append a section to `docs/PHASE-1.x-BACKLOG.md` titled `## Invoice filter probe (2026-07-29)` stating, in plain terms: whether `status=paid` filters, whether `paid_at_min` filters, whether `sort_by=paid_at` sorts, and whether `paid_at` is present on the payload. This is what Task 8 branches on.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-invoice-filters.mjs docs/PHASE-1.x-BACKLOG.md
git commit -m "chore: probe live HCP invoice filter params for targeted paid-invoice polling"
```

---

### Task 2: Migration — `notifications_sent` table, created and seeded together

**Files:**
- Create: `supabase/migrations/0006_notifications.sql`

**Interfaces:**
- Produces: table `notifications_sent (kind text, entity_id text, sent_at timestamptz, primary key (kind, entity_id))`.

- [ ] **Step 1: Write the migration**

The seed runs **in the same file** that creates the table. That ordering is the entire safety property — there must be no window in which the notifier can observe an empty table against a full `invoices` table (2,217 rows are already `paid`).

```sql
-- supabase/migrations/0006_notifications.sql
--
-- Dedupe ledger for Slack notifications. The rule everywhere is INSERT FIRST,
-- POST SECOND: a primary-key collision means "already notified, post nothing".
-- Idempotent under retries, overlapping cron runs, and duplicate HCP webhook
-- deliveries, with no locking.
create table notifications_sent (
  kind      text not null,   -- 'invoice_paid' | 'estimate_approved'
                             -- | 'daily_digest' | 'weekly_lookahead'
  entity_id text not null,
  sent_at   timestamptz not null default now(),
  primary key (kind, entity_id)
);

-- SEEDS — must stay in this file, never split into 0007.
-- 2,217 invoices are already paid and ~hundreds of estimate options already
-- approved. Without these seeds the first notifier run treats every one as new
-- and posts thousands of Slack messages.

insert into notifications_sent (kind, entity_id)
select 'invoice_paid', id from invoices where status = 'paid'
on conflict do nothing;

-- Approval is per-option, so the key is "{estimate_id}:{option_id}". The '0'
-- fallback for an option with no id MUST match estimateOptionKey() in
-- src/lib/notifications/detect.ts, or seeded rows will fail to suppress the
-- notifications they exist to suppress.
-- The jsonb_typeof guard is not decoration. jsonb_array_elements raises
-- "cannot extract elements from a scalar/an object" on any non-array input,
-- and that aborts the ENTIRE insert for ALL estimates — one malformed
-- historical row would leave estimate_approved completely unseeded, which is
-- exactly the partial-seed state this migration exists to prevent. A missing
-- 'options' key is already safe (SQL NULL yields zero rows); an explicit JSON
-- null, object, or scalar is not.
insert into notifications_sent (kind, entity_id)
select 'estimate_approved', e.id || ':' || coalesce(o->>'id', '0')
from estimates e,
     jsonb_array_elements(
       case when jsonb_typeof(e.raw->'options') = 'array'
            then e.raw->'options'
            else '[]'::jsonb
       end
     ) o
where lower(o->>'approval_status') in ('approved', 'pro approved')
on conflict do nothing;
```

With that guard, no statement in this migration can fail on data shape, so the
file does not depend on whether Supabase CLI wraps it in a transaction —
partial application stops being reachable. Do **not** add explicit
`begin;`/`commit;`: Supabase may already wrap the file, and a nested `BEGIN`
only emits warnings.

- [ ] **Step 2: Do NOT apply the migration**

**Decision (2026-07-29): the repo owner applies this to production themselves.**
Write and commit the file only. Do not run `npx supabase db push`, `npx supabase
db execute`, or any other command that writes to the Supabase project.

Applying it is Task 13's rollout step, performed by a human:

```bash
npx supabase db push
```

followed by this verification, whose result gates everything after it:

```sql
select kind, count(*) from notifications_sent group by kind;
```

Expected: `invoice_paid` in the **low 2,200s** — it must equal `select count(*) from invoices where status='paid'` exactly. (The go-live census recorded 2,217; the 2026-07-29 probe saw ~2,234. The number grows over time, so match it against the live count, not against a constant.) `estimate_approved` > 0.

**If `invoice_paid` is 0 or near 0, STOP.** The seed did not take, and proceeding will produce a Slack flood.

Tasks 3–13 do not depend on the migration having been applied — every test mocks Supabase — so the rest of the plan proceeds normally against the unapplied schema.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0006_notifications.sql
git commit -m "feat(db): notifications_sent dedupe ledger, seeded against existing paid/approved records"
```

---

### Task 3: Slack client

**Files:**
- Create: `src/lib/slack/client.ts`
- Test: `src/lib/slack/__tests__/client.test.ts`

**Interfaces:**
- Produces:
  - `slackAlertsEnabled(): boolean`
  - `postSlack(webhookUrl: string | undefined, text: string): Promise<boolean>` — `true` if posted, `false` if skipped or failed. Never throws.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/slack/__tests__/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postSlack, slackAlertsEnabled } from "../client";

describe("slackAlertsEnabled", () => {
  afterEach(() => {
    delete process.env.SLACK_ALERTS_ENABLED;
  });

  it("is false when unset — alerts are off by default", () => {
    expect(slackAlertsEnabled()).toBe(false);
  });

  it("is false for any value other than 'true'", () => {
    process.env.SLACK_ALERTS_ENABLED = "1";
    expect(slackAlertsEnabled()).toBe(false);
  });

  it("is true only for 'true'", () => {
    process.env.SLACK_ALERTS_ENABLED = "true";
    expect(slackAlertsEnabled()).toBe(true);
  });
});

describe("postSlack", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("posts the text as JSON to the webhook url", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postSlack("https://hooks.slack.com/services/XXX", "hello");

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/XXX");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ text: "hello" });
  });

  it("skips without calling fetch when the url is undefined", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await postSlack(undefined, "hello")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false instead of throwing when Slack responds non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" })
    );
    expect(await postSlack("https://hooks.slack.com/services/XXX", "hello")).toBe(false);
  });

  it("returns false instead of throwing when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await postSlack("https://hooks.slack.com/services/XXX", "hello")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/slack/__tests__/client.test.ts`
Expected: FAIL — cannot resolve `../client`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/slack/client.ts
//
// Slack incoming-webhook poster. Every failure is swallowed and logged: a Slack
// outage must never fail the sync the dashboard depends on.

// Alerts are OFF unless explicitly enabled, so the notifier can be deployed and
// observed in logs before it is allowed to post anything. Given ~2,200 already-
// paid invoices, an accidental default-on is a Slack flood.
export function slackAlertsEnabled(): boolean {
  return process.env.SLACK_ALERTS_ENABLED === "true";
}

const TIMEOUT_MS = 10_000;

export async function postSlack(
  webhookUrl: string | undefined,
  text: string
): Promise<boolean> {
  if (!webhookUrl) {
    // Unconfigured is a deliberate no-op, not an error — logged distinctly from
    // a genuine post failure so the two are separable in Vercel logs.
    console.warn("[slack] skipped: webhook url not configured");
    return false;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[slack] post failed: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[slack] post threw:", err);
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/slack/__tests__/client.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/slack/client.ts src/lib/slack/__tests__/client.test.ts
git commit -m "feat(slack): incoming-webhook client with default-off kill switch"
```

---

### Task 4: Dedupe ledger

**Files:**
- Create: `src/lib/notifications/dedupe.ts`
- Test: `src/lib/notifications/__tests__/dedupe.test.ts`

**Interfaces:**
- Consumes: `notifications_sent` (Task 2).
- Produces:
  - `type NotificationKind = "invoice_paid" | "estimate_approved" | "daily_digest" | "weekly_lookahead"`
  - `claimMany(supabase: SupabaseClient, kind: NotificationKind, entityIds: string[]): Promise<string[]>` — returns only the ids newly claimed by this call.
  - `claim(supabase: SupabaseClient, kind: NotificationKind, entityId: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/notifications/__tests__/dedupe.test.ts
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claim, claimMany } from "../dedupe";

// Minimal stub of the one chain dedupe uses:
//   supabase.from(table).upsert(rows, opts).select("entity_id")
function stubSupabase(returned: Array<{ entity_id: string }>, error: unknown = null) {
  const select = vi.fn().mockResolvedValue({ data: returned, error });
  const upsert = vi.fn().mockReturnValue({ select });
  const from = vi.fn().mockReturnValue({ upsert });
  return { client: { from } as unknown as SupabaseClient, from, upsert, select };
}

describe("claimMany", () => {
  it("returns only the ids Postgres actually inserted", async () => {
    const { client, upsert } = stubSupabase([{ entity_id: "inv_2" }]);

    const claimed = await claimMany(client, "invoice_paid", ["inv_1", "inv_2"]);

    expect(claimed).toEqual(["inv_2"]);
    const [rows, opts] = upsert.mock.calls[0];
    expect(rows).toEqual([
      { kind: "invoice_paid", entity_id: "inv_1" },
      { kind: "invoice_paid", entity_id: "inv_2" },
    ]);
    expect(opts).toEqual({ onConflict: "kind,entity_id", ignoreDuplicates: true });
  });

  it("makes no database call for an empty list", async () => {
    const { client, from } = stubSupabase([]);
    expect(await claimMany(client, "invoice_paid", [])).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("de-duplicates ids within a single call before inserting", async () => {
    const { client, upsert } = stubSupabase([{ entity_id: "inv_1" }]);
    await claimMany(client, "invoice_paid", ["inv_1", "inv_1"]);
    expect(upsert.mock.calls[0][0]).toEqual([{ kind: "invoice_paid", entity_id: "inv_1" }]);
  });

  it("claims nothing when the insert errors — never post on an unknown state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = stubSupabase([], { message: "db down" });
    expect(await claimMany(client, "invoice_paid", ["inv_1"])).toEqual([]);
  });
});

describe("claim", () => {
  it("is true when the single id was newly inserted", async () => {
    const { client } = stubSupabase([{ entity_id: "2026-07-29" }]);
    expect(await claim(client, "daily_digest", "2026-07-29")).toBe(true);
  });

  it("is false when the row already existed", async () => {
    const { client } = stubSupabase([]);
    expect(await claim(client, "daily_digest", "2026-07-29")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/notifications/__tests__/dedupe.test.ts`
Expected: FAIL — cannot resolve `../dedupe`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/notifications/dedupe.ts
//
// INSERT FIRST, POST SECOND. claimMany inserts with ON CONFLICT DO NOTHING and
// returns only the rows Postgres actually created; those are the ones that have
// not been notified yet. Idempotent under retries, overlapping cron runs, and
// duplicate HCP webhook deliveries, with no locking.
//
// Trade-off, deliberate: a crash between the insert and the Slack post loses
// that notification. The inverse order would double-post on every retry.
// Losing an alert beats spamming the channel.
import type { SupabaseClient } from "@supabase/supabase-js";

export type NotificationKind =
  | "invoice_paid"
  | "estimate_approved"
  | "daily_digest"
  | "weekly_lookahead";

// Batch, not per-row: the 20-hour full invoice reconcile re-touches all ~2,200
// paid invoices, which would otherwise be 2,200 round trips.
export async function claimMany(
  supabase: SupabaseClient,
  kind: NotificationKind,
  entityIds: string[]
): Promise<string[]> {
  const unique = [...new Set(entityIds)];
  if (unique.length === 0) return [];

  const { data, error } = await supabase
    .from("notifications_sent")
    .upsert(
      unique.map((entity_id) => ({ kind, entity_id })),
      { onConflict: "kind,entity_id", ignoreDuplicates: true }
    )
    .select("entity_id");

  if (error) {
    // Claim nothing on error. Posting without a durable claim risks repeating
    // the whole batch on the next run.
    console.error(`[dedupe] claim failed for kind=${kind}:`, error);
    return [];
  }

  return ((data ?? []) as Array<{ entity_id: string }>).map((r) => r.entity_id);
}

export async function claim(
  supabase: SupabaseClient,
  kind: NotificationKind,
  entityId: string
): Promise<boolean> {
  const claimed = await claimMany(supabase, kind, [entityId]);
  return claimed.length === 1;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/notifications/__tests__/dedupe.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/dedupe.ts src/lib/notifications/__tests__/dedupe.test.ts
git commit -m "feat(notifications): batch claim ledger for insert-first-post-second dedupe"
```

---

### Task 5: Digest timing (pure, timezone-aware)

`src/lib/dashboard/week.ts` already has correct DST-safe timezone helpers, but they are module-private and do not expose the hour. Export a shared `localParts` rather than duplicating `Intl` logic.

**Files:**
- Modify: `src/lib/dashboard/week.ts` (export `localParts`, refactor private `localCal` to use it)
- Create: `src/lib/notifications/schedule.ts`
- Test: `src/lib/notifications/__tests__/schedule.test.ts`

**Interfaces:**
- Consumes: `localParts(instant: Date): { y: number; m0: number; d: number; dow: number; hour: number; minute: number }` from `@/lib/dashboard/week`.
- Produces:
  - `localDateKey(now: Date): string` — `"YYYY-MM-DD"` in America/New_York
  - `mondayDateKey(now: Date): string` — the `localDateKey` of that local week's Monday
  - `isDailyDigestDue(now: Date): boolean`
  - `isWeeklyLookaheadDue(now: Date): boolean`

These are **pure** — clock only, no database. The already-sent check is `claim()`, applied by the caller. That split is what makes the DST tests runnable without a DB.

- [ ] **Step 1: Export `localParts` from week.ts**

Replace the private `localCal` function in `src/lib/dashboard/week.ts` with an exported superset, and update its two call sites (`weekRange`, `dayRange`) to destructure from it. `localCal`'s existing callers use `{ y, m0, d, dow }`, all still present.

```typescript
// Local calendar parts + weekday (0=Sun..6=Sat) + wall-clock time for an
// instant, in TZ. Exported because the Slack digest scheduler needs the same
// DST-correct arithmetic — duplicating Intl logic there would let the two
// drift apart.
export function localParts(instant: Date): {
  y: number;
  m0: number;
  d: number;
  dow: number;
  hour: number;
  minute: number;
} {
  const off = tzOffsetMs(instant);
  const local = new Date(instant.getTime() + off);
  return {
    y: local.getUTCFullYear(),
    m0: local.getUTCMonth(),
    d: local.getUTCDate(),
    dow: local.getUTCDay(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
}

const localCal = localParts;
```

- [ ] **Step 2: Verify the existing week tests still pass**

Run: `npx vitest run src/lib/dashboard/__tests__/week.test.ts`
Expected: PASS — this is a pure refactor, no behavior change.

- [ ] **Step 3: Write the failing tests**

The DST and UTC-rollover cases are the whole point of this module. US DST in 2026: begins **Sun Mar 8**, ends **Sun Nov 1**.

```typescript
// src/lib/notifications/__tests__/schedule.test.ts
import { describe, it, expect } from "vitest";
import {
  localDateKey,
  mondayDateKey,
  isDailyDigestDue,
  isWeeklyLookaheadDue,
} from "../schedule";

describe("localDateKey", () => {
  it("uses the LOCAL date, not the UTC date", () => {
    // 2026-07-29 21:00 EDT is 2026-07-30 01:00 UTC. Keying the digest dedupe on
    // the UTC date would roll over at 8pm local and admit a second digest.
    expect(localDateKey(new Date("2026-07-30T01:00:00Z"))).toBe("2026-07-29");
  });

  it("pads month and day", () => {
    expect(localDateKey(new Date("2026-03-09T15:00:00Z"))).toBe("2026-03-09");
  });
});

describe("mondayDateKey", () => {
  it("returns the same Monday for any day in that local week", () => {
    // Mon 2026-07-27 .. Sun 2026-08-02, all 15:00Z (= 11:00 EDT, same local day)
    expect(mondayDateKey(new Date("2026-07-27T15:00:00Z"))).toBe("2026-07-27");
    expect(mondayDateKey(new Date("2026-07-30T15:00:00Z"))).toBe("2026-07-27");
    expect(mondayDateKey(new Date("2026-08-02T15:00:00Z"))).toBe("2026-07-27");
  });
});

describe("isDailyDigestDue", () => {
  it("is true at 06:00 EDT on a weekday (summer, UTC-4)", () => {
    expect(isDailyDigestDue(new Date("2026-07-29T10:00:00Z"))).toBe(true);
  });

  it("is true at 06:00 EST on a weekday (winter, UTC-5)", () => {
    // The same wall-clock 6am is a DIFFERENT UTC hour in winter. A hardcoded
    // cron hour is wrong for half the year; this is why timing lives here.
    expect(isDailyDigestDue(new Date("2026-01-14T11:00:00Z"))).toBe(true);
  });

  it("is false at 05:59 local", () => {
    expect(isDailyDigestDue(new Date("2026-07-29T09:59:00Z"))).toBe(false);
  });

  it("is true later in the morning so a missed 6:00 ping self-heals", () => {
    // 13:30Z = 09:30 EDT, inside the 06:00-12:00 catch-up window.
    expect(isDailyDigestDue(new Date("2026-07-29T13:30:00Z"))).toBe(true);
  });

  it("is false from noon local onward — no stale digest at bedtime", () => {
    expect(isDailyDigestDue(new Date("2026-07-29T16:00:00Z"))).toBe(false);
  });

  it("is false on Saturday and Sunday", () => {
    expect(isDailyDigestDue(new Date("2026-08-01T10:00:00Z"))).toBe(false);
    expect(isDailyDigestDue(new Date("2026-08-02T10:00:00Z"))).toBe(false);
  });

  it("is true on the DST spring-forward Monday", () => {
    // DST began Sun 2026-03-08; Mon 2026-03-09 06:00 EDT = 10:00Z
    expect(isDailyDigestDue(new Date("2026-03-09T10:00:00Z"))).toBe(true);
  });

  it("is true on the DST fall-back Monday", () => {
    // DST ended Sun 2026-11-01; Mon 2026-11-02 06:00 EST = 11:00Z
    expect(isDailyDigestDue(new Date("2026-11-02T11:00:00Z"))).toBe(true);
  });
});

describe("isWeeklyLookaheadDue", () => {
  it("is true Monday at 06:00 local", () => {
    expect(isWeeklyLookaheadDue(new Date("2026-07-27T10:00:00Z"))).toBe(true);
  });

  it("is false on other weekdays", () => {
    expect(isWeeklyLookaheadDue(new Date("2026-07-28T10:00:00Z"))).toBe(false);
  });

  it("is false before 06:00 Monday", () => {
    expect(isWeeklyLookaheadDue(new Date("2026-07-27T09:00:00Z"))).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run src/lib/notifications/__tests__/schedule.test.ts`
Expected: FAIL — cannot resolve `../schedule`.

- [ ] **Step 5: Write the implementation**

```typescript
// src/lib/notifications/schedule.ts
//
// Digest timing, decided in code rather than in a cron expression. Cron cannot
// express "6am Eastern" — only a fixed UTC hour that is wrong for half the
// year. Evaluating the rule against America/New_York on every 15-minute run
// makes DST a non-issue permanently and makes a missed ping self-healing.
//
// Pure: clock in, boolean out. The "already sent today" check is claim(),
// applied by the caller — keeping it out of here is what lets these tests run
// without a database.
import { localParts } from "@/lib/dashboard/week";

const DIGEST_HOUR = 6;
// Upper bound so a scheduler outage that ends in the afternoon does not deliver
// a "Today" digest at bedtime. Between 06:00 and this hour, any run catches up.
const DIGEST_CUTOFF_HOUR = 12;
const MONDAY = 1;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDateKey(now: Date): string {
  const { y, m0, d } = localParts(now);
  return `${y}-${pad(m0 + 1)}-${pad(d)}`;
}

export function mondayDateKey(now: Date): string {
  const { y, m0, d, dow } = localParts(now);
  const daysSinceMonday = (dow + 6) % 7; // Sun(0) -> 6, Mon(1) -> 0
  const monday = new Date(Date.UTC(y, m0, d - daysSinceMonday));
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

function inMorningWindow(now: Date): boolean {
  const { hour } = localParts(now);
  return hour >= DIGEST_HOUR && hour < DIGEST_CUTOFF_HOUR;
}

export function isDailyDigestDue(now: Date): boolean {
  const { dow } = localParts(now);
  if (dow === 0 || dow === 6) return false; // weekends
  return inMorningWindow(now);
}

export function isWeeklyLookaheadDue(now: Date): boolean {
  const { dow } = localParts(now);
  if (dow !== MONDAY) return false;
  return inMorningWindow(now);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/notifications/__tests__/schedule.test.ts src/lib/dashboard/__tests__/week.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/notifications/schedule.ts src/lib/notifications/__tests__/schedule.test.ts src/lib/dashboard/week.ts
git commit -m "feat(notifications): DST-safe digest timing; export localParts from week.ts"
```

---

### Task 6: Detection (pure)

**Files:**
- Create: `src/lib/notifications/detect.ts`
- Test: `src/lib/notifications/__tests__/detect.test.ts`

**Interfaces:**
- Produces:
  - `estimateOptionKey(estimateId: string, optionId: string | null | undefined): string` — `"{estimateId}:{optionId ?? "0"}"`. **The `"0"` fallback must match the migration seed.**
  - `interface PaidInvoiceLine { id: string; customerName: string | null; amountCents: number | null; invoiceNumber: string | null }`
  - `interface ApprovedEstimateLine { key: string; customerName: string | null; amountCents: number | null; optionName: string | null }`
  - `detectPaidInvoices(invoices: unknown[]): PaidInvoiceLine[]`
  - `detectApprovedEstimates(estimates: unknown[]): ApprovedEstimateLine[]`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/notifications/__tests__/detect.test.ts
import { describe, it, expect } from "vitest";
import { detectPaidInvoices, detectApprovedEstimates, estimateOptionKey } from "../detect";

describe("estimateOptionKey", () => {
  it("joins estimate and option id", () => {
    expect(estimateOptionKey("est_1", "opt_a")).toBe("est_1:opt_a");
  });

  it("falls back to '0' — must match coalesce(o->>'id','0') in migration 0006", () => {
    expect(estimateOptionKey("est_1", null)).toBe("est_1:0");
    expect(estimateOptionKey("est_1", undefined)).toBe("est_1:0");
  });
});

describe("detectPaidInvoices", () => {
  const customer = { id: "cus_1", first_name: "Mary", last_name: "Kolakowski" };

  it("picks out paid invoices", () => {
    const out = detectPaidInvoices([
      { id: "inv_1", status: "paid", amount: 428000, invoice_number: "1042", customer },
    ]);
    expect(out).toEqual([
      { id: "inv_1", customerName: "Mary Kolakowski", amountCents: 428000, invoiceNumber: "1042" },
    ]);
  });

  it("ignores every non-paid live status", () => {
    // Live account census: paid 2217 | canceled 570 | voided 42 | open 25.
    const out = detectPaidInvoices([
      { id: "a", status: "open", customer },
      { id: "b", status: "canceled", customer },
      { id: "c", status: "voided", customer },
    ]);
    expect(out).toEqual([]);
  });

  it("survives a record with no customer and no amount", () => {
    const out = detectPaidInvoices([{ id: "inv_2", status: "paid" }]);
    expect(out).toEqual([
      { id: "inv_2", customerName: null, amountCents: null, invoiceNumber: null },
    ]);
  });

  it("skips records with no id", () => {
    expect(detectPaidInvoices([{ status: "paid" }])).toEqual([]);
  });
});

describe("detectApprovedEstimates", () => {
  const customer = { id: "cus_1", first_name: "R.", last_name: "Hoffman" };

  it("returns only the approved option of a multi-option estimate", () => {
    const out = detectApprovedEstimates([
      {
        id: "est_1",
        customer,
        options: [
          { id: "opt_a", name: "Good", approval_status: null, total_amount: 100000 },
          { id: "opt_b", name: "Better", approval_status: "approved", total_amount: 250000 },
        ],
      },
    ]);
    expect(out).toEqual([
      { key: "est_1:opt_b", customerName: "R. Hoffman", amountCents: 250000, optionName: "Better" },
    ]);
  });

  it("treats 'pro approved' as approved, case-insensitively", () => {
    const out = detectApprovedEstimates([
      { id: "est_2", customer, options: [{ id: "o", approval_status: "Pro Approved", total_amount: 500 }] },
    ]);
    expect(out.map((r) => r.key)).toEqual(["est_2:o"]);
  });

  it("ignores declined and pending options", () => {
    const out = detectApprovedEstimates([
      {
        id: "est_3",
        customer,
        options: [
          { id: "o1", approval_status: "declined" },
          { id: "o2", approval_status: null },
        ],
      },
    ]);
    expect(out).toEqual([]);
  });

  it("survives an estimate with no options array", () => {
    expect(detectApprovedEstimates([{ id: "est_4", customer }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/notifications/__tests__/detect.test.ts`
Expected: FAIL — cannot resolve `../detect`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/notifications/detect.ts
//
// Pure detection: records in, notification lines out. No database, no network.
// Accepts `unknown[]` because these records arrive from two different shapes —
// raw HCP API payloads (cron) and webhook bodies — and both are untyped at the
// boundary.

// Live invoice statuses (census over all 2,854 synced invoices):
//   paid 2217 | canceled 570 | voided 42 | open 25. There is no "pending".
const PAID_STATUS = "paid";

// Per-option approval values, matching src/lib/dashboard/queries.ts.
const APPROVED_STATUSES = new Set(["approved", "pro approved"]);

export interface PaidInvoiceLine {
  id: string;
  customerName: string | null;
  amountCents: number | null;
  invoiceNumber: string | null;
}

export interface ApprovedEstimateLine {
  key: string;
  customerName: string | null;
  amountCents: number | null;
  optionName: string | null;
}

interface RawCustomer {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
}

function customerName(c: RawCustomer | undefined): string | null {
  if (!c) return null;
  const person = [c.first_name, c.last_name].filter(Boolean).join(" ");
  return person || c.company || null;
}

// The "0" fallback MUST match coalesce(o->>'id','0') in migration 0006, or
// seeded rows will not suppress the notifications they were written to suppress.
export function estimateOptionKey(
  estimateId: string,
  optionId: string | null | undefined
): string {
  return `${estimateId}:${optionId ?? "0"}`;
}

export function detectPaidInvoices(invoices: unknown[]): PaidInvoiceLine[] {
  const out: PaidInvoiceLine[] = [];

  for (const raw of invoices) {
    const inv = raw as {
      id?: string;
      status?: string | null;
      amount?: number | null;
      invoice_number?: string | null;
      customer?: RawCustomer;
    };
    if (!inv?.id) continue;
    if ((inv.status ?? "").toLowerCase() !== PAID_STATUS) continue;

    out.push({
      id: inv.id,
      customerName: customerName(inv.customer),
      // Live API: the invoice total field is `amount`, in cents.
      amountCents: inv.amount ?? null,
      invoiceNumber: inv.invoice_number ?? null,
    });
  }

  return out;
}

export function detectApprovedEstimates(estimates: unknown[]): ApprovedEstimateLine[] {
  const out: ApprovedEstimateLine[] = [];

  for (const raw of estimates) {
    const est = raw as {
      id?: string;
      customer?: RawCustomer;
      options?: Array<{
        id?: string | null;
        name?: string | null;
        approval_status?: string | null;
        total_amount?: number | null;
      }>;
    };
    if (!est?.id) continue;

    // Approval is per-option: approving option B must not be silenced by
    // option A, so each approved option is its own claim key.
    //
    // Array.isArray, not `?? []`: `??` only substitutes on null/undefined, so a
    // non-array `options` (an object or scalar) would make for...of throw and
    // abort the ENTIRE batch, losing every other estimate in the run. This
    // mirrors the jsonb_typeof guard in migration 0006 — the same malformed
    // shape is documented there as occurring in real data.
    for (const opt of Array.isArray(est.options) ? est.options : []) {
      if (!APPROVED_STATUSES.has((opt.approval_status ?? "").toLowerCase())) continue;
      out.push({
        key: estimateOptionKey(est.id, opt.id),
        customerName: customerName(est.customer),
        amountCents: opt.total_amount ?? null,
        optionName: opt.name ?? null,
      });
    }
  }

  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/notifications/__tests__/detect.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/detect.ts src/lib/notifications/__tests__/detect.test.ts
git commit -m "feat(notifications): pure detectors for paid invoices and approved estimate options"
```

---

### Task 7: Message formatting

**Files:**
- Modify: `src/lib/dashboard/queries.ts` (export the `TodayScheduleRow` interface — add `export` to the existing declaration at line 84)
- Create: `src/lib/slack/format.ts`
- Test: `src/lib/slack/__tests__/format.test.ts`

**Interfaces:**
- Consumes: `TodayScheduleRow` from `@/lib/dashboard/queries`; `PaidInvoiceLine`, `ApprovedEstimateLine` from `@/lib/notifications/detect`.
- Produces:
  - `formatCents(cents: number | null | undefined): string`
  - `formatDailyDigest(now: Date, rows: TodayScheduleRow[], lastSyncMinutesAgo: number | null): string`
  - `formatWeeklyLookahead(now: Date, days: Array<{ dateKey: string; rows: TodayScheduleRow[] }>): string`
  - `formatPaidInvoices(lines: PaidInvoiceLine[]): string`
  - `formatApprovedEstimates(lines: ApprovedEstimateLine[]): string`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/slack/__tests__/format.test.ts
import { describe, it, expect } from "vitest";
import {
  formatCents,
  formatDailyDigest,
  formatWeeklyLookahead,
  formatPaidInvoices,
  formatApprovedEstimates,
} from "../format";

describe("formatCents", () => {
  it("renders cents as dollars — the money bug that matters most here", () => {
    expect(formatCents(428000)).toBe("$4,280.00");
  });

  it("keeps sub-dollar precision", () => {
    expect(formatCents(5)).toBe("$0.05");
  });

  it("renders zero", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("renders null as an em dash rather than $NaN", () => {
    expect(formatCents(null)).toBe("—");
    expect(formatCents(undefined)).toBe("—");
  });
});

describe("formatDailyDigest", () => {
  const now = new Date("2026-07-29T10:00:00Z"); // Wed 06:00 EDT

  const row = {
    id: "job_1",
    scheduledStart: "2026-07-29T12:00:00Z", // 08:00 EDT
    customerName: "Mary Kolakowski",
    technicianName: "Dan",
    zone: "Albany Zone",
    compass: "SW",
    miles: 14,
    driveMinutes: 24,
  };

  it("includes the date, job count, local time, customer, zone and tech", () => {
    const out = formatDailyDigest(now, [row], 4);
    expect(out).toContain("Wed Jul 29");
    expect(out).toContain("1 job");
    expect(out).toContain("8:00a");
    expect(out).toContain("Mary Kolakowski");
    expect(out).toContain("Albany Zone");
    expect(out).toContain("SW");
    expect(out).toContain("14 mi");
    expect(out).toContain("24 min");
    expect(out).toContain("Dan");
  });

  it("shows sync age so a stalled external scheduler is visible", () => {
    expect(formatDailyDigest(now, [row], 4)).toContain("last sync: 4 min ago");
  });

  it("still posts on an empty day — silence would be ambiguous", () => {
    const out = formatDailyDigest(now, [], 2);
    expect(out).toContain("No jobs scheduled today");
  });

  it("renders a job with no tech, no geocode and no customer without crashing", () => {
    const bare = {
      id: "job_2",
      scheduledStart: null,
      customerName: null,
      technicianName: null,
      zone: "Unknown",
      compass: "",
      miles: null,
      driveMinutes: null,
    };
    const out = formatDailyDigest(now, [bare], null);
    expect(out).toContain("Unknown");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("NaN");
  });
});

describe("formatWeeklyLookahead", () => {
  it("groups jobs under each day heading", () => {
    const out = formatWeeklyLookahead(new Date("2026-07-27T10:00:00Z"), [
      {
        dateKey: "2026-07-27",
        rows: [
          {
            id: "j1",
            scheduledStart: "2026-07-27T12:00:00Z",
            customerName: "A Customer",
            technicianName: "Dan",
            zone: "Albany Zone",
            compass: "SW",
            miles: 10,
            driveMinutes: 18,
          },
        ],
      },
      { dateKey: "2026-07-28", rows: [] },
    ]);
    expect(out).toContain("Week ahead");
    expect(out).toContain("Mon Jul 27");
    expect(out).toContain("A Customer");
    expect(out).toContain("Tue Jul 28");
    expect(out).toContain("No jobs");
  });
});

describe("formatPaidInvoices", () => {
  it("lists each invoice with a dollar amount", () => {
    const out = formatPaidInvoices([
      { id: "inv_1", customerName: "Mary Kolakowski", amountCents: 428000, invoiceNumber: "1042" },
      { id: "inv_2", customerName: null, amountCents: null, invoiceNumber: null },
    ]);
    // Assert the header's real content, not a singular literal — this fixture
    // has TWO invoices, so no sensible header can contain "Invoice paid".
    // (The original assertion here was an authoring slip that forced a
    // redundant per-bullet "Invoice paid —" prefix into the implementation.)
    expect(out).toContain("2 invoices paid");
    expect(out).toContain("Mary Kolakowski");
    expect(out).toContain("$4,280.00");
    expect(out).toContain("#1042");
    expect(out).toContain("—");
    expect(out).not.toContain("undefined");
  });

  it("uses the singular heading for one and plural for many", () => {
    const one = formatPaidInvoices([
      { id: "a", customerName: "X", amountCents: 100, invoiceNumber: "1" },
    ]);
    const two = formatPaidInvoices([
      { id: "a", customerName: "X", amountCents: 100, invoiceNumber: "1" },
      { id: "b", customerName: "Y", amountCents: 200, invoiceNumber: "2" },
    ]);
    expect(one).toContain("1 invoice paid");
    expect(two).toContain("2 invoices paid");
  });
});

describe("formatApprovedEstimates", () => {
  it("lists each approved option", () => {
    const out = formatApprovedEstimates([
      { key: "est_1:opt_b", customerName: "R. Hoffman", amountCents: 250000, optionName: "Better" },
    ]);
    expect(out).toContain("estimate approved");
    expect(out).toContain("R. Hoffman");
    expect(out).toContain("$2,500.00");
    expect(out).toContain("Better");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/slack/__tests__/format.test.ts`
Expected: FAIL — cannot resolve `../format`.

- [ ] **Step 3: Export `TodayScheduleRow`**

In `src/lib/dashboard/queries.ts`, change `interface TodayScheduleRow {` (line 84) to `export interface TodayScheduleRow {`. No other change.

- [ ] **Step 4: Write the implementation**

```typescript
// src/lib/slack/format.ts
//
// Message builders. Pure — no I/O, no clock reads beyond the injected `now`.
// This is the ONLY place cents become dollars.
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import type { PaidInvoiceLine, ApprovedEstimateLine } from "@/lib/notifications/detect";

const TZ = "America/New_York";

export function formatCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// "Wed Jul 29" for an instant, in local time.
//
// Built from formatToParts rather than .format(): the default ICU output is
// "Wed, Jul 29" with a comma, and stripping it with .replace() would depend on
// ICU always putting punctuation in exactly one predictable place, which varies
// across Node versions. Same approach as timeLabel below.
function dayLabel(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("month")} ${get("day")}`;
}

// "2026-07-27" -> "Mon Jul 27". Parsed as local noon so the label can never
// slip a day from a timezone edge.
function dayLabelFromKey(dateKey: string): string {
  return dayLabel(new Date(`${dateKey}T12:00:00Z`));
}

// "8:00a" — compact, so a 6-job list stays scannable on a phone.
function timeLabel(iso: string | null): string {
  if (!iso) return "  --  ";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}${get("dayPeriod").toLowerCase().startsWith("a") ? "a" : "p"}`;
}

function jobLines(row: TodayScheduleRow): string {
  const geo = [row.zone, row.compass, row.miles != null ? `${row.miles} mi` : null,
    row.driveMinutes != null ? `${row.driveMinutes} min` : null]
    .filter((p) => p != null && p !== "")
    .join(" / ");

  return [
    `${timeLabel(row.scheduledStart)}  ${row.customerName ?? "Unknown customer"}`,
    `       ${geo}`,
    `       Tech: ${row.technicianName ?? "Unassigned"}`,
  ].join("\n");
}

export function formatDailyDigest(
  now: Date,
  rows: TodayScheduleRow[],
  lastSyncMinutesAgo: number | null
): string {
  const header = `*Today — ${dayLabel(now)}* — ${rows.length} ${rows.length === 1 ? "job" : "jobs"}`;
  const body = rows.length === 0 ? "No jobs scheduled today." : rows.map(jobLines).join("\n\n");
  // Sync age makes a stalled external scheduler visible in a message that is
  // already read every morning, instead of being noticed a week later.
  const footer =
    lastSyncMinutesAgo == null ? "_last sync: unknown_" : `_last sync: ${lastSyncMinutesAgo} min ago_`;
  return [header, "", body, "", footer].join("\n");
}

export function formatWeeklyLookahead(
  now: Date,
  days: Array<{ dateKey: string; rows: TodayScheduleRow[] }>
): string {
  const total = days.reduce((n, d) => n + d.rows.length, 0);
  const sections = days.map((d) => {
    const heading = `*${dayLabelFromKey(d.dateKey)}*`;
    const body = d.rows.length === 0 ? "No jobs" : d.rows.map(jobLines).join("\n\n");
    return `${heading}\n${body}`;
  });
  return [`*Week ahead* — ${total} ${total === 1 ? "job" : "jobs"}`, "", ...sections].join("\n\n");
}

export function formatPaidInvoices(lines: PaidInvoiceLine[]): string {
  const header = `*${lines.length} ${lines.length === 1 ? "invoice paid" : "invoices paid"}*`;
  const body = lines
    .map((l) => {
      const number = l.invoiceNumber ? ` #${l.invoiceNumber}` : "";
      return `• ${l.customerName ?? "Unknown customer"} — ${formatCents(l.amountCents)}${number}`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

export function formatApprovedEstimates(lines: ApprovedEstimateLine[]): string {
  const header = `*${lines.length} ${lines.length === 1 ? "estimate approved" : "estimates approved"}*`;
  const body = lines
    .map((l) => {
      const option = l.optionName ? ` (${l.optionName})` : "";
      return `• ${l.customerName ?? "Unknown customer"} — ${formatCents(l.amountCents)}${option}`;
    })
    .join("\n");
  return `${header}\n${body}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/slack/__tests__/format.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/slack/format.ts src/lib/slack/__tests__/format.test.ts src/lib/dashboard/queries.ts
git commit -m "feat(slack): message formatters; cents-to-dollars isolated to one module"
```

---

### Task 8: Targeted paid-invoice fetch

**Branches on Task 1's probe result.** Implement path A if `status=paid` and `paid_at_min` both work; path B otherwise.

**Files:**
- Modify: `src/lib/housecall/client.ts` (add `listPaidInvoicesSince`)
- Test: `src/lib/housecall/__tests__/client.test.ts` (extend existing file)

**Interfaces:**
- Produces: `listPaidInvoicesSince(paidAtMin: string | null, page?: number): Promise<{ items: HcpInvoice[]; page: number; totalPages: number }>` on `HousecallClient`.

- [ ] **Step 1: Write the failing test (path A)**

Append to `src/lib/housecall/__tests__/client.test.ts`, matching the fetch-stubbing style already used there.

```typescript
describe("listPaidInvoicesSince", () => {
  it("requests only paid invoices at or after the watermark, newest first", async () => {
    process.env.HOUSECALL_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ invoices: [{ id: "inv_1" }], page: 1, total_pages: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HousecallClient();
    const result = await client.listPaidInvoicesSince("2026-07-29T00:00:00Z");

    expect(result.items).toEqual([{ id: "inv_1" }]);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/invoices?");
    // Array form, unencoded brackets. Bare `status=paid` returns 422
    // "must be an array" on the live API (probe, 2026-07-29).
    expect(url).toContain("status[]=paid");
    expect(url).toContain("paid_at_min=2026-07-29T00%3A00%3A00Z");
    expect(url).toContain("sort_by=paid_at");
    expect(url).toContain("sort_direction=desc");
  });

  it("omits paid_at_min entirely on a null watermark", async () => {
    process.env.HOUSECALL_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ invoices: [], page: 1, total_pages: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await new HousecallClient().listPaidInvoicesSince(null);
    expect(fetchMock.mock.calls[0][0]).not.toContain("paid_at_min");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/housecall/__tests__/client.test.ts`
Expected: FAIL — `listPaidInvoicesSince is not a function`.

- [ ] **Step 3: Implement path A**

Add to the `HousecallClient` class in `src/lib/housecall/client.ts`. It bypasses the shared `request()` helper because that method hardcodes `sort_by=updated_at`, and invoices carry no `updated_at`.

```typescript
  // Targeted paid-invoice poll (spec: "Targeted invoice polling"). The generic
  // incremental path is useless for invoices — they carry no `updated_at`, so
  // the cursor never advances and every run re-pages all ~2.9k invoices (58
  // calls, ~70s), which is why the full reconcile is gated to once per 20h.
  // Filtering server-side on status + paid_at makes this ONE call per run, so
  // 15-minute latency is cheaper than the 20-hour reconcile, not costlier.
  // Query params verified live by scripts/probe-invoice-filters.mjs.
  //
  // `status[]=paid`, not `status=paid`: the live API returns 422 "must be an
  // array" for the bare form (probe, 2026-07-29). Unencoded brackets, matching
  // the `expand[]` convention in request() above.
  async listPaidInvoicesSince(
    paidAtMin: string | null,
    page = 1
  ): Promise<{ items: HcpInvoice[]; page: number; totalPages: number }> {
    const since = paidAtMin ? `&paid_at_min=${encodeURIComponent(paidAtMin)}` : "";
    const res = await fetch(
      `${BASE_URL}/invoices?page=${page}&page_size=50&status[]=paid&sort_by=paid_at&sort_direction=desc${since}`,
      { headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" } }
    );

    if (!res.ok) {
      throw new Error(`Housecall Pro API error ${res.status} on /invoices (paid): ${await res.text()}`);
    }

    const json = await res.json();
    return {
      items: (json.invoices ?? []) as HcpInvoice[],
      page: json.page ?? page,
      totalPages: json.total_pages ?? page,
    };
  }
```

**Path B — only if the probe showed the filters are ignored.** Do not add `listPaidInvoicesSince`. Instead change `DEFAULT_INVOICE_RECONCILE_HOURS` in `src/app/api/cron/sync/route.ts` from `20` to `1`, update the comment above it to record that targeted filtering was probed and rejected, and let Task 9 detect paid invoices from the existing reconcile results. Latency becomes ~1 hour instead of ~15 minutes. Note the change in `docs/PHASE-1.x-BACKLOG.md`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/housecall/__tests__/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/housecall/client.ts src/lib/housecall/__tests__/client.test.ts
git commit -m "feat(hcp): targeted paid-invoice poll via status + paid_at_min filters"
```

---

### Task 9: Week-ahead schedule query

**Files:**
- Modify: `src/lib/dashboard/queries.ts` (add `getWeekAheadSchedule`)
- Test: `src/lib/dashboard/__tests__/queries.test.ts` (extend existing file, following its existing Supabase-stubbing style)

**Interfaces:**
- Consumes: `weekRange` from `./week`; `TodayScheduleRow` (exported in Task 7).
- Produces: `getWeekAheadSchedule(now?: Date): Promise<Array<{ dateKey: string; rows: TodayScheduleRow[] }>>` — seven entries, Monday through Sunday of the local week containing `now`, each possibly empty.

- [ ] **Step 1: Write the failing test**

Mirror the existing stubbing approach in `src/lib/dashboard/__tests__/queries.test.ts` (it already stubs `getSupabaseServerClient`; reuse that helper rather than inventing a second one).

```typescript
describe("getWeekAheadSchedule", () => {
  it("returns seven day buckets, Monday first, with jobs in their local day", async () => {
    // Reuse this file's existing supabase stub helper. Jobs seeded:
    //   job_1 scheduled 2026-07-27T12:00:00Z (Mon 08:00 EDT)
    //   job_2 scheduled 2026-07-29T20:00:00Z (Wed 16:00 EDT)
    const days = await getWeekAheadSchedule(new Date("2026-07-27T10:00:00Z"));

    expect(days).toHaveLength(7);
    expect(days[0].dateKey).toBe("2026-07-27");
    expect(days[6].dateKey).toBe("2026-08-02");
    expect(days[0].rows.map((r) => r.id)).toEqual(["job_1"]);
    expect(days[2].rows.map((r) => r.id)).toEqual(["job_2"]);
    expect(days[1].rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/dashboard/__tests__/queries.test.ts`
Expected: FAIL — `getWeekAheadSchedule` is not exported.

- [ ] **Step 3: Extract the shared row builder and add the query**

The per-job mapping inside `getDashboardSnapshot` (the `.map()` at `src/lib/dashboard/queries.ts:173-209`) is exactly what the week-ahead needs. Extract it so both callers share one implementation — this is what guarantees the Slack message can never disagree with the dashboard.

Add above `getDashboardSnapshot`:

```typescript
// Shared by the dashboard's todaySchedule and the Slack week-ahead digest.
// Both MUST render from one implementation, or the two can silently drift.
function buildScheduleRow(
  j: JobRow,
  custById: Map<string, CustomerRow>,
  techById: Map<string, TechRow>,
  fullName: (r?: { first_name: string | null; last_name: string | null }) => string | null
): TodayScheduleRow {
  const cust = custById.get(j.raw?.customer?.id ?? "");
  const town = j.raw?.address?.city ?? cust?.city ?? null;
  const hasCoords = j.service_address_lat != null && j.service_address_lng != null;
  let z: { zone: string; compass: string; source: "town" | "distance" };
  let miles: number | null = null;
  let driveMinutes: number | null = null;
  if (hasCoords) {
    const lat = j.service_address_lat as number;
    const lng = j.service_address_lng as number;
    z = classifyZone(lat, lng, town);
    const dist = distanceFromAverillPark(lat, lng);
    miles = dist.miles;
    driveMinutes = dist.driveMinutes;
  } else {
    const townZone = zoneForTown(town);
    z = townZone
      ? { zone: townZone, compass: "", source: "town" }
      : { zone: "Unknown", compass: "", source: "distance" };
  }
  return {
    id: j.id,
    scheduledStart: j.scheduled_start,
    customerName: fullName(cust),
    technicianName: fullName(techById.get(j.technician_id ?? "")),
    zone: z.zone,
    compass: z.compass,
    miles,
    driveMinutes,
  };
}
```

Then replace the body of the existing `.map((j) => { ... })` in `getDashboardSnapshot` with `.map((j) => buildScheduleRow(j, custById, techById, fullName))`, leaving the preceding `.slice().sort(...)` untouched.

Add the new exported query:

```typescript
// Monday–Sunday of the local week containing `now`, grouped by local day.
// Every day is present even when empty, so the digest can say "No jobs".
export async function getWeekAheadSchedule(
  now: Date = new Date()
): Promise<Array<{ dateKey: string; rows: TodayScheduleRow[] }>> {
  const supabase = getSupabaseServerClient();
  const week = weekRange(now, "this");

  // Never select("*"): PostgREST caps responses at 1000 rows and truncates
  // silently. fetchAllRows pages; the column list stays explicit.
  const [jobs, customers, technicians] = await Promise.all([
    fetchAllRows<JobRow>(
      supabase,
      "jobs",
      "id, work_status, is_emergency, is_commercial, total_amount_cents, scheduled_start, scheduled_end, technician_id, service_address_lat, service_address_lng, raw"
    ),
    fetchAllRows<CustomerRow>(supabase, "customers", "id, first_name, last_name, city"),
    fetchAllRows<TechRow>(supabase, "technicians", "id, first_name, last_name"),
  ]);

  const custById = new Map(customers.map((c) => [c.id, c]));
  const techById = new Map(technicians.map((t) => [t.id, t]));
  const fullName = (r?: { first_name: string | null; last_name: string | null }) =>
    r ? [r.first_name, r.last_name].filter(Boolean).join(" ") || null : null;

  const inWeek = jobs
    .filter(
      (j) =>
        !!j.scheduled_start &&
        j.scheduled_start >= week.startIso &&
        j.scheduled_start < week.endIso &&
        !CANCELED_JOB_STATUSES.has((j.work_status ?? "").toLowerCase())
    )
    .slice()
    .sort((a, b) => (a.scheduled_start ?? "").localeCompare(b.scheduled_start ?? ""));

  // Build the seven local day buckets from the week's Monday.
  const monday = new Date(week.startIso);
  const buckets: Array<{ dateKey: string; rows: TodayScheduleRow[]; startIso: string; endIso: string }> = [];
  for (let i = 0; i < 7; i += 1) {
    const dayStart = new Date(monday.getTime() + i * 86_400_000);
    const range = dayRange(dayStart);
    buckets.push({ dateKey: localDateKeyOf(dayStart), rows: [], startIso: range.startIso, endIso: range.endIso });
  }

  for (const j of inWeek) {
    const iso = j.scheduled_start as string;
    const bucket = buckets.find((b) => iso >= b.startIso && iso < b.endIso);
    if (bucket) bucket.rows.push(buildScheduleRow(j, custById, techById, fullName));
  }

  return buckets.map(({ dateKey, rows }) => ({ dateKey, rows }));
}
```

Add the import `import { localDateKey as localDateKeyOf } from "@/lib/notifications/schedule";` at the top of `queries.ts`, alongside the existing imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/dashboard/__tests__/queries.test.ts`
Expected: PASS, including all pre-existing tests — the `buildScheduleRow` extraction is behavior-preserving.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dashboard/queries.ts src/lib/dashboard/__tests__/queries.test.ts
git commit -m "feat(dashboard): week-ahead schedule query; share row builder with todaySchedule"
```

---

### Task 10: Notification dispatcher

One module the two routes call, so posting policy lives in exactly one place.

**Files:**
- Create: `src/lib/notifications/dispatch.ts`
- Test: `src/lib/notifications/__tests__/dispatch.test.ts`

**Interfaces:**
- Consumes: `claimMany` (Task 4), `detectPaidInvoices` / `detectApprovedEstimates` (Task 6), `formatPaidInvoices` / `formatApprovedEstimates` (Task 7), `postSlack` / `slackAlertsEnabled` (Task 3).
- Produces:
  - `notifyPaidInvoices(supabase: SupabaseClient, invoices: unknown[]): Promise<number>` — count posted
  - `notifyApprovedEstimates(supabase: SupabaseClient, estimates: unknown[]): Promise<number>`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/notifications/__tests__/dispatch.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/slack/client", () => ({
  postSlack: vi.fn().mockResolvedValue(true),
  slackAlertsEnabled: vi.fn().mockReturnValue(true),
}));
vi.mock("../dedupe", () => ({ claimMany: vi.fn() }));

import { postSlack, slackAlertsEnabled } from "@/lib/slack/client";
import { claimMany } from "../dedupe";
import { notifyPaidInvoices } from "../dispatch";

const supabase = {} as SupabaseClient;
const paid = (id: string) => ({
  id,
  status: "paid",
  amount: 1000,
  invoice_number: id,
  customer: { first_name: "A", last_name: "B" },
});

describe("notifyPaidInvoices", () => {
  beforeEach(() => {
    vi.mocked(slackAlertsEnabled).mockReturnValue(true);
    vi.mocked(postSlack).mockClear().mockResolvedValue(true);
    vi.mocked(claimMany).mockReset();
    process.env.SLACK_WEBHOOK_INVOICES = "https://hooks.slack.com/services/INV";
  });
  afterEach(() => {
    delete process.env.SLACK_WEBHOOK_INVOICES;
  });

  it("posts ONE batched message for all newly claimed invoices", async () => {
    vi.mocked(claimMany).mockResolvedValue(["inv_1", "inv_2"]);

    const posted = await notifyPaidInvoices(supabase, [paid("inv_1"), paid("inv_2")]);

    expect(posted).toBe(2);
    expect(postSlack).toHaveBeenCalledOnce();
    const [url, text] = vi.mocked(postSlack).mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/INV");
    expect(text).toContain("2 invoices paid");
  });

  it("posts nothing when every invoice was already claimed", async () => {
    vi.mocked(claimMany).mockResolvedValue([]);
    expect(await notifyPaidInvoices(supabase, [paid("inv_1")])).toBe(0);
    expect(postSlack).not.toHaveBeenCalled();
  });

  it("posts only the subset that was newly claimed", async () => {
    vi.mocked(claimMany).mockResolvedValue(["inv_2"]);
    await notifyPaidInvoices(supabase, [paid("inv_1"), paid("inv_2")]);
    const text = vi.mocked(postSlack).mock.calls[0][1];
    expect(text).toContain("1 invoice paid");
    expect(text).toContain("#inv_2");
    expect(text).not.toContain("#inv_1");
  });

  it("claims nothing and posts nothing when the kill switch is off", async () => {
    vi.mocked(slackAlertsEnabled).mockReturnValue(false);
    expect(await notifyPaidInvoices(supabase, [paid("inv_1")])).toBe(0);
    expect(claimMany).not.toHaveBeenCalled();
    expect(postSlack).not.toHaveBeenCalled();
  });

  it("skips the whole pass when no paid invoice is present", async () => {
    expect(await notifyPaidInvoices(supabase, [{ id: "x", status: "open" }])).toBe(0);
    expect(claimMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/notifications/__tests__/dispatch.test.ts`
Expected: FAIL — cannot resolve `../dispatch`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/notifications/dispatch.ts
//
// Detect -> claim -> post, in that order. One batched message per channel per
// run: four newly-paid invoices are one message with four lines, which keeps
// Slack's per-webhook rate limit irrelevant and the channel readable.
//
// The kill switch is checked BEFORE claiming. Claiming while disabled would
// silently burn the claim and permanently suppress that notification once
// alerts are turned on.
import type { SupabaseClient } from "@supabase/supabase-js";
import { postSlack, slackAlertsEnabled } from "@/lib/slack/client";
import { formatPaidInvoices, formatApprovedEstimates } from "@/lib/slack/format";
import { detectPaidInvoices, detectApprovedEstimates } from "./detect";
import { claimMany } from "./dedupe";

export async function notifyPaidInvoices(
  supabase: SupabaseClient,
  invoices: unknown[]
): Promise<number> {
  if (!slackAlertsEnabled()) return 0;

  const candidates = detectPaidInvoices(invoices);
  if (candidates.length === 0) return 0;

  const claimed = new Set(
    await claimMany(supabase, "invoice_paid", candidates.map((c) => c.id))
  );
  const fresh = candidates.filter((c) => claimed.has(c.id));
  if (fresh.length === 0) return 0;

  await postSlack(process.env.SLACK_WEBHOOK_INVOICES, formatPaidInvoices(fresh));
  return fresh.length;
}

export async function notifyApprovedEstimates(
  supabase: SupabaseClient,
  estimates: unknown[]
): Promise<number> {
  if (!slackAlertsEnabled()) return 0;

  const candidates = detectApprovedEstimates(estimates);
  if (candidates.length === 0) return 0;

  const claimed = new Set(
    await claimMany(supabase, "estimate_approved", candidates.map((c) => c.key))
  );
  const fresh = candidates.filter((c) => claimed.has(c.key));
  if (fresh.length === 0) return 0;

  await postSlack(process.env.SLACK_WEBHOOK_ESTIMATES, formatApprovedEstimates(fresh));
  return fresh.length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/notifications/__tests__/dispatch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/dispatch.ts src/lib/notifications/__tests__/dispatch.test.ts
git commit -m "feat(notifications): dispatcher — detect, claim, then post one batched message"
```

---

### Task 11: Wire estimate approvals into the webhook route

**Files:**
- Modify: `src/app/api/webhooks/housecall/route.ts`
- Test: `src/app/api/webhooks/housecall/__tests__/route.test.ts` (extend existing)

**Interfaces:**
- Consumes: `notifyApprovedEstimates` (Task 10).

- [ ] **Step 1: Write the failing test**

Add to the existing webhook route test file, reusing its signature-stubbing setup.

```typescript
it("notifies on an approved estimate option after a successful sync", async () => {
  const { notifyApprovedEstimates } = await import("@/lib/notifications/dispatch");
  const body = JSON.stringify({
    event: "estimate.updated",
    estimate: {
      id: "est_1",
      customer: { first_name: "R.", last_name: "Hoffman" },
      options: [{ id: "opt_b", approval_status: "approved", total_amount: 250000 }],
    },
  });

  const res = await POST(signedRequest(body));

  expect(res.status).toBe(200);
  expect(notifyApprovedEstimates).toHaveBeenCalledOnce();
  expect(vi.mocked(notifyApprovedEstimates).mock.calls[0][1]).toEqual([
    expect.objectContaining({ id: "est_1" }),
  ]);
});

it("does not notify when the sync throws", async () => {
  const { notifyApprovedEstimates } = await import("@/lib/notifications/dispatch");
  const { syncOneRecord } = await import("@/lib/sync/syncService");
  vi.mocked(syncOneRecord).mockRejectedValueOnce(new Error("db down"));

  const res = await POST(
    signedRequest(JSON.stringify({ event: "estimate.updated", estimate: { id: "est_1" } }))
  );

  expect(res.status).toBe(200);
  expect(notifyApprovedEstimates).not.toHaveBeenCalled();
});
```

Add `vi.mock("@/lib/notifications/dispatch", () => ({ notifyApprovedEstimates: vi.fn().mockResolvedValue(0) }));` at the top of the file with the other mocks.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/webhooks/housecall/__tests__/route.test.ts`
Expected: FAIL — `notifyApprovedEstimates` never called.

- [ ] **Step 3: Wire it in**

In `src/app/api/webhooks/housecall/route.ts`, add the imports:

```typescript
import { getSupabaseServerClient } from "@/lib/supabase/client";
import { notifyApprovedEstimates } from "@/lib/notifications/dispatch";
```

Then, immediately after the successful `await syncOneRecord(...)` call and before the final `return NextResponse.json({ ok: true }, { status: 200 });`, insert:

```typescript
  // Estimates are the one notification class HCP delivers by webhook, so this
  // is the instant path. The cron re-checks the same records as a safety net;
  // the shared claim ledger makes the overlap harmless rather than duplicative.
  //
  // Notify only AFTER the sync succeeds — announcing an approval we failed to
  // persist would put Slack ahead of the database.
  if (resource === "estimate" || resource === "estimates") {
    try {
      await notifyApprovedEstimates(getSupabaseServerClient(), [record]);
    } catch (err) {
      // Never fail the webhook for a notification problem: a non-2xx triggers
      // an HCP retry storm, and the record is already synced.
      console.error(`[webhook] estimate notification failed for event=${event}:`, err);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/webhooks/housecall/__tests__/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/webhooks/housecall/route.ts src/app/api/webhooks/housecall/__tests__/route.test.ts
git commit -m "feat(webhooks): post approved estimate options to Slack on the instant path"
```

---

### Task 12: Wire invoices and digests into the cron route

**Files:**
- Modify: `src/app/api/cron/sync/route.ts`
- Test: `src/app/api/cron/sync/__tests__/route.test.ts` (extend existing)

**Interfaces:**
- Consumes: `notifyPaidInvoices` (Task 10), `listPaidInvoicesSince` (Task 8), `isDailyDigestDue` / `isWeeklyLookaheadDue` / `localDateKey` / `mondayDateKey` (Task 5), `claim` (Task 4), `getDashboardSnapshot` / `getWeekAheadSchedule` (Task 9), `formatDailyDigest` / `formatWeeklyLookahead` (Task 7).

- [ ] **Step 1: Write the failing tests**

```typescript
it("posts the daily digest once inside the morning window", async () => {
  const { claim } = await import("@/lib/notifications/dedupe");
  const { postSlack } = await import("@/lib/slack/client");
  vi.mocked(claim).mockResolvedValue(true);
  vi.setSystemTime(new Date("2026-07-29T10:00:00Z")); // Wed 06:00 EDT

  await GET(authorizedRequest());

  expect(claim).toHaveBeenCalledWith(expect.anything(), "daily_digest", "2026-07-29");
  expect(vi.mocked(postSlack).mock.calls.some(([, text]) => text.includes("Today —"))).toBe(true);
});

it("does not post the digest when the day is already claimed", async () => {
  const { claim } = await import("@/lib/notifications/dedupe");
  const { postSlack } = await import("@/lib/slack/client");
  vi.mocked(claim).mockResolvedValue(false);
  vi.setSystemTime(new Date("2026-07-29T10:00:00Z"));

  await GET(authorizedRequest());

  expect(vi.mocked(postSlack).mock.calls.some(([, text]) => text.includes("Today —"))).toBe(false);
});

it("does not post the digest outside the morning window", async () => {
  const { claim } = await import("@/lib/notifications/dedupe");
  vi.setSystemTime(new Date("2026-07-29T20:00:00Z")); // 16:00 EDT
  await GET(authorizedRequest());
  expect(claim).not.toHaveBeenCalledWith(expect.anything(), "daily_digest", expect.anything());
});

it("posts the week-ahead only on Monday", async () => {
  const { claim } = await import("@/lib/notifications/dedupe");
  vi.mocked(claim).mockResolvedValue(true);
  vi.setSystemTime(new Date("2026-07-27T10:00:00Z")); // Mon 06:00 EDT
  await GET(authorizedRequest());
  expect(claim).toHaveBeenCalledWith(expect.anything(), "weekly_lookahead", "2026-07-27");
});
```

Use `vi.useFakeTimers()` in `beforeEach` and `vi.useRealTimers()` in `afterEach`, and mock `@/lib/notifications/dedupe`, `@/lib/slack/client`, `@/lib/dashboard/queries`, and `@/lib/notifications/dispatch` alongside the file's existing mocks.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/cron/sync/__tests__/route.test.ts`
Expected: FAIL — no digest posted.

- [ ] **Step 3: Wire it in**

Add imports to `src/app/api/cron/sync/route.ts`:

```typescript
import { notifyPaidInvoices } from "@/lib/notifications/dispatch";
import { claim } from "@/lib/notifications/dedupe";
import {
  isDailyDigestDue,
  isWeeklyLookaheadDue,
  localDateKey,
  mondayDateKey,
} from "@/lib/notifications/schedule";
import { getDashboardSnapshot, getWeekAheadSchedule } from "@/lib/dashboard/queries";
import { formatDailyDigest, formatWeeklyLookahead } from "@/lib/slack/format";
import { postSlack, slackAlertsEnabled } from "@/lib/slack/client";
```

After the `if (shouldReconcileInvoices) { ... }` block and before the cursor-persistence block, add the targeted paid-invoice pass (**path A only** — on path B, instead call `notifyPaidInvoices(supabase, reconciledInvoiceItems)` using the records the reconcile already fetched):

**POST-REVIEW CORRECTION (whole-branch review finding C1, applied after this
plan was originally written):** the version below is what this task's plan
originally specified, and it is WRONG. `notifications_sent` (via `claim`/
`claimMany`) guards against a DUPLICATE notification; it does nothing to
guard against a LOST one — the watermark does, and the comment below's
"a wrong watermark can only delay a notification, never duplicate one" has it
backwards. The block must be gated on `slackAlertsEnabled()` in its entirety
(fetch included, not just the post), and `results.push` for `invoices_paid`
must only run when the fetch+notify sequence completes without throwing —
otherwise a kill-switch-off deploy window, or a `claimMany` DB error, silently
advances the watermark past invoices nothing ever claimed or posted. See
`src/app/api/cron/sync/route.ts` for the corrected version actually shipped.

```typescript
  // Targeted paid-invoice poll — ONE API call per run, unlike the 58-call full
  // reconcile above, which is why it can run every 15 minutes. The watermark
  // lives in sync_cursors under a dedicated resource key; notifications_sent is
  // still the correctness guarantee, so a wrong watermark can only delay a
  // notification, never duplicate one.
  const paidWatermark = cursors.get("invoices_paid") ?? null;
  let newPaidWatermark = paidWatermark;
  try {
    const paidPage = await hcp.listPaidInvoicesSince(paidWatermark);
    await notifyPaidInvoices(supabase, paidPage.items);
    for (const inv of paidPage.items as Array<{ paid_at?: string }>) {
      if (inv.paid_at && (!newPaidWatermark || inv.paid_at > newPaidWatermark)) {
        newPaidWatermark = inv.paid_at;
      }
    }
    results.push({
      resource: "invoices_paid",
      newCursor: newPaidWatermark,
      upserted: 0,
      pagesFetched: 1,
    });
  } catch (err) {
    // A notification failure must never fail the sync the dashboard depends on.
    console.error("[cron] paid-invoice notification pass failed:", err);
  }
```

Then, after the cursor upsert and before the final `return`, add the digest pass:

```typescript
  // Digest timing is decided here rather than by the cron schedule: cron cannot
  // express "6am Eastern", only a UTC hour that is wrong for half the year.
  // Any run inside the local morning window sends it, so a missed 6:00 ping
  // self-heals on the next one; claim() guarantees exactly one per day.
  if (slackAlertsEnabled()) {
    const now = new Date();
    try {
      if (isWeeklyLookaheadDue(now) && (await claim(supabase, "weekly_lookahead", mondayDateKey(now)))) {
        const days = await getWeekAheadSchedule(now);
        await postSlack(process.env.SLACK_WEBHOOK_SCHEDULE, formatWeeklyLookahead(now, days));
      }

      if (isDailyDigestDue(now) && (await claim(supabase, "daily_digest", localDateKey(now)))) {
        const snapshot = await getDashboardSnapshot(now);
        // Sync age surfaces a stalled external scheduler in the message that is
        // already read every morning.
        const minutesAgo = Math.round((now.getTime() - Date.parse(syncedAt)) / 60_000);
        await postSlack(
          process.env.SLACK_WEBHOOK_SCHEDULE,
          formatDailyDigest(now, snapshot.todaySchedule, Number.isFinite(minutesAgo) ? minutesAgo : null)
        );
      }
    } catch (err) {
      console.error("[cron] digest pass failed:", err);
    }
  }
```

The weekly look-ahead runs before the daily digest so Monday morning reads week-ahead, then today.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/cron/sync/__tests__/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pre-existing 57 tests plus the new ones PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/cron/sync/route.ts src/app/api/cron/sync/__tests__/route.test.ts
git commit -m "feat(cron): paid-invoice notifications and TZ-aware schedule digests"
```

---

### Task 13: Configuration, documentation, and rollout

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Create: `docs/SLACK-ROLLOUT.md`

- [ ] **Step 1: Add the env vars to `.env.example`**

```bash
SLACK_WEBHOOK_SCHEDULE=
SLACK_WEBHOOK_INVOICES=
SLACK_WEBHOOK_ESTIMATES=
SLACK_ALERTS_ENABLED=false
```

- [ ] **Step 2: Document them in `README.md`**

Add to the existing "Environment variables" list:

```markdown
- `SLACK_WEBHOOK_SCHEDULE` — Slack incoming webhook for the job schedule channel
  (6:00 a.m. weekday digest + Monday week-ahead).
- `SLACK_WEBHOOK_INVOICES` — Slack incoming webhook for the paid invoice channel.
- `SLACK_WEBHOOK_ESTIMATES` — Slack incoming webhook for the approved estimate channel.
- `SLACK_ALERTS_ENABLED` — `true` to allow posting. **Anything else disables all
  Slack output.** Deploy with this unset, confirm the detector finds few or no
  notifications in the logs, then enable.
```

Also add a section explaining that digest timing is evaluated in `America/New_York` on every run rather than set by a cron expression, and that an external 15-minute scheduler calling `/api/cron/sync` with the `Bearer $CRON_SECRET` header is what drives it.

- [ ] **Step 3: Write the rollout runbook**

Create `docs/SLACK-ROLLOUT.md` with the ordered steps, matching the spec's Rollout section: apply and verify migration 0006 (checking `invoice_paid` ≈ 2217 and **stopping** if it is near zero); deploy with alerts disabled and confirm from logs that few or no notifications are detected; create the three Slack incoming webhooks and set the URLs in Vercel; set `SLACK_ALERTS_ENABLED=true`; confirm the next morning digest; and only then stand up the external 15-minute scheduler. State explicitly that step 2 is the only cheap moment to catch a seeding mistake before it becomes ~2,200 Slack messages.

- [ ] **Step 4: Verify the build**

Run: `npm run build && npm test`
Expected: build succeeds (typecheck + lint clean) and all tests pass.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md docs/SLACK-ROLLOUT.md
git commit -m "docs: Slack notification configuration and rollout runbook"
```

---

## Verification checklist

Before considering this complete:

- [ ] `npm test` — all tests pass, including the pre-existing 57.
- [ ] `npm run build` — typecheck and lint clean.
- [ ] `select kind, count(*) from notifications_sent group by kind` shows `invoice_paid` ≈ 2217.
- [ ] With `SLACK_ALERTS_ENABLED` unset, a cron run posts nothing.
- [ ] The probe findings from Task 1 are recorded in `docs/PHASE-1.x-BACKLOG.md`, and Task 8 took the matching path.
