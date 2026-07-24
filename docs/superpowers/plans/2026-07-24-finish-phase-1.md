# Finish Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every remaining Phase-1 gap in the Trinity ↔ Housecall Pro app — sync Leads, Attachments, Tags and Notes; add delete handling; wire the geographic computed fields (town-first zones) into the dashboard; and build the 4 missing dashboard elements plus date-scoped revenue.

**Architecture:** Next.js 14 App Router. Sync happens two ways — real-time via the `/api/webhooks/housecall` route and a daily Vercel cron at `/api/cron/sync`, both funneling through pure mapper functions (`src/lib/sync/mappers.ts`) into Supabase (Postgres via `@supabase/supabase-js`). The dashboard is a server component reading aggregate queries. Geo math is pure functions over lat/lng. This plan adds two tables, four columns, one Storage bucket, several mappers, a delete branch in the sync router, a town→zone lookup, and dashboard queries/panels.

**Tech Stack:** TypeScript, Next.js 14, Supabase (Postgres + Storage), Vitest 4, US Census geocoder (existing), Vercel.

## Global Constraints

- **Strict lint fails the build:** no `@typescript-eslint/no-explicit-any`, no unused vars — **test files included**. Type all mocks properly.
- **Vitest 4:** `vi.fn().mockImplementation(() => ({...}))` cannot be `new`-ed — use `function () { return {...} }` for mocked constructors.
- **No inter-table foreign keys.** Migration `0004` dropped all of them (HCP delivers records out of order). New tables/columns must not add FKs.
- **PostgREST caps every response at 1000 rows.** All multi-row reads must paginate with `.range()` and select only needed columns.
- **Live HCP values, not invented ones.** Job `work_status` is `"in progress"` (with a space); invoice unpaid status is `"open"`; there is no `"pending"`/`"in_progress"`. Verify against live data, never fixtures alone.
- **Test command:** `npx vitest run <path>` (single test: append `-t "<name>"`). Full suite: `npm test`. Build: `npm run build`. Lint: `npm run lint`.
- **Never run `npm run build` while `npm run dev` is running** (it kills the dev server). Kill dev first.
- **Commit after each task.** Windows + Git Bash; `LF→CRLF` warnings are harmless.

---

## File Structure

**Create:**
- `supabase/migrations/0005_phase1_completion.sql` — leads + attachments tables, tags/notes columns
- `src/lib/sync/attachments.ts` — attachment extraction + best-effort re-hosting
- `src/lib/sync/__tests__/attachments.test.ts`
- `src/lib/geo/townZones.ts` — `TOWN_ZONES` config + `zoneForTown`
- `src/lib/geo/__tests__/townZones.test.ts`
- `src/lib/dashboard/week.ts` — Mon–Sun week-boundary helper
- `src/lib/dashboard/__tests__/week.test.ts`
- `src/app/dashboard/components/TodaySchedulePanel.tsx`
- `src/app/dashboard/components/TechnicianWorkloadPanel.tsx`

**Modify:**
- `src/lib/housecall/types.ts` — add `HcpLead`, extend `HcpCustomer` (notes/tags/attachments)
- `src/lib/sync/mappers.ts` — add `mapLead`; extend `mapJob`/`mapCustomer` (tags, notes)
- `src/lib/sync/syncService.ts` — leads + `pro` alias, attachment wiring, delete branch
- `src/app/api/webhooks/housecall/route.ts` — thread the event action (upsert vs delete)
- `src/lib/housecall/client.ts` — `listLeads`
- `src/app/api/cron/sync/route.ts` — leads incremental pass
- `src/lib/geo/zones.ts` — town-first `classifyZone`
- `src/lib/dashboard/queries.ts` — extend `DashboardSnapshot`
- `src/app/dashboard/page.tsx` — new cards + panels
- `docs/NEXT-SESSION-HANDOFF.md` — mark Phase-1 items done

---

## Task 1: Migration — leads + attachments tables, tags/notes columns

**Files:**
- Create: `supabase/migrations/0005_phase1_completion.sql`

**Interfaces:**
- Produces: tables `leads`, `attachments`; columns `jobs.tags`, `jobs.notes`, `customers.tags`, `customers.notes`.

- [ ] **Step 1: Write the migration**

```sql
-- Phase 1 completion: Leads + Attachments sync, first-class Tags/Notes.
-- No inter-table foreign keys (see 0004): HCP delivers records out of order.

create table leads (
  id          text primary key,          -- Housecall Pro lead id
  customer_id text,                       -- soft reference, no FK
  status      text,
  source      text,                       -- lead_source
  created_at  timestamptz,
  raw         jsonb not null,
  updated_at  timestamptz not null default now()
);

create table attachments (
  id           text primary key,          -- Housecall Pro attachment id
  parent_type  text not null,             -- 'customer' | 'job'
  parent_id    text not null,             -- soft reference
  file_name    text,
  content_type text,
  hcp_url      text,                       -- original HCP-hosted URL
  storage_path text,                       -- Supabase Storage path once re-hosted; null if not copied
  created_at   timestamptz,
  raw          jsonb not null,
  updated_at   timestamptz not null default now()
);

create index attachments_parent_idx on attachments (parent_type, parent_id);

alter table jobs      add column tags  text[] not null default '{}';
alter table jobs      add column notes text;
alter table customers add column tags  text[] not null default '{}';
alter table customers add column notes text;
```

- [ ] **Step 2: Apply the migration**

`supabase db push` is interactive (asks for the DB password) — **the user must run it**. Ask the user to run `supabase db push` (or `npx supabase db push`) and confirm the two new tables and four columns exist. Do not proceed to Task 7 (cron leads pass) writes against `leads` until confirmed, but Tasks 2–6, 8–12 are code-only and can proceed.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0005_phase1_completion.sql
git commit -m "feat(db): migration 0005 — leads, attachments, first-class tags/notes"
```

---

## Task 2: Types — HcpLead + notes/tags on customer

**Files:**
- Modify: `src/lib/housecall/types.ts`

**Interfaces:**
- Produces: `HcpLead`; `HcpCustomer.notes?`, `HcpCustomer.tags?`, `HcpCustomer.attachments?`. (`HcpJob` already has `tags`, `notes`, `attachments`.)

- [ ] **Step 1: Extend `HcpCustomer` and add `HcpLead`**

In `src/lib/housecall/types.ts`, add these fields to the existing `HcpCustomer` interface (after `mobile_number`):

```typescript
  notes?: string;
  tags?: Array<{ id: string; name: string }>;
  attachments?: Array<{ id: string; url: string; content_type?: string; file_name?: string }>;
```

Add a new interface at the end of the file:

```typescript
export interface HcpLead {
  id: string;
  customer?: { id: string };
  status?: string;
  lead_source?: string;
  created_at?: string;
  updated_at?: string; // ISO; drives incremental cursor sync
}
```

Also replace the existing `attachments?:` line in `HcpJob` so re-hosting can name files:

```typescript
  attachments?: Array<{ id: string; url: string; content_type?: string; file_name?: string }>;
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/lib/housecall/types.ts
git commit -m "feat(types): HcpLead + notes/tags/attachments on HcpCustomer"
```

---

## Task 3: Mappers — mapLead + tags/notes on job & customer

**Files:**
- Modify: `src/lib/sync/mappers.ts`
- Test: `src/lib/sync/__tests__/mappers.test.ts`

**Interfaces:**
- Consumes: `HcpLead` (Task 2).
- Produces: `mapLead(l: HcpLead)`; `mapJob`/`mapCustomer` rows now include `tags: string[]` and `notes: string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/sync/__tests__/mappers.test.ts`:

```typescript
import { mapLead } from "../mappers";

describe("mapCustomer tags/notes", () => {
  it("maps tag names to a lowercased tags array and passes notes through", () => {
    const row = mapCustomer({
      id: "c1",
      notes: "Gate code 1234",
      tags: [{ id: "t1", name: "VIP" }, { id: "t2", name: "Navien" }],
    });
    expect(row.tags).toEqual(["vip", "navien"]);
    expect(row.notes).toBe("Gate code 1234");
  });

  it("defaults tags to [] and notes to null when absent", () => {
    const row = mapCustomer({ id: "c2" });
    expect(row.tags).toEqual([]);
    expect(row.notes).toBeNull();
  });
});

describe("mapJob tags/notes", () => {
  it("stores all tag names lowercased and joins note contents", () => {
    const row = mapJob({
      id: "j1",
      tags: [{ id: "t1", name: "Emergency" }, { id: "t2", name: "Commercial" }],
      notes: [
        { id: "n1", content: "Called ahead", created_at: "2026-07-01T00:00:00Z" },
        { id: "n2", content: "Needs permit", created_at: "2026-07-02T00:00:00Z" },
      ],
    });
    expect(row.tags).toEqual(["emergency", "commercial"]);
    expect(row.is_emergency).toBe(true);
    expect(row.is_commercial).toBe(true);
    expect(row.notes).toBe("Called ahead\nNeeds permit");
  });

  it("defaults tags to [] and notes to null when absent", () => {
    const row = mapJob({ id: "j2" });
    expect(row.tags).toEqual([]);
    expect(row.notes).toBeNull();
  });
});

describe("mapLead", () => {
  it("maps id, customer link, status, source, timestamps", () => {
    const row = mapLead({
      id: "lead_1",
      customer: { id: "c1" },
      status: "new",
      lead_source: "My Website",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    });
    expect(row.id).toBe("lead_1");
    expect(row.customer_id).toBe("c1");
    expect(row.status).toBe("new");
    expect(row.source).toBe("My Website");
  });

  it("defaults optional fields to null", () => {
    const row = mapLead({ id: "lead_2" });
    expect(row.customer_id).toBeNull();
    expect(row.status).toBeNull();
    expect(row.source).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/sync/__tests__/mappers.test.ts`
Expected: FAIL — `mapLead` is not exported; `row.tags`/`row.notes` undefined.

- [ ] **Step 3: Implement**

In `src/lib/sync/mappers.ts`:

Add the `HcpLead` import to the existing import line:
```typescript
import { HcpCustomer, HcpJob, HcpEstimate, HcpInvoice, HcpLead } from "@/lib/housecall/types";
```

In `mapCustomer`, add before `raw: c,`:
```typescript
    tags: (c.tags ?? []).map((t) => (t.name ?? "").toLowerCase()),
    notes: c.notes ?? null,
```

In `mapJob`, the `tagNames` line already exists. Add before `raw: j,`:
```typescript
    tags: tagNames,
    notes: (j.notes ?? []).map((n) => n.content).join("\n") || null,
```

Add a new exported function:
```typescript
export function mapLead(l: HcpLead) {
  return {
    id: l.id,
    customer_id: l.customer?.id ?? null,
    status: l.status ?? null,
    source: l.lead_source ?? null,
    created_at: l.created_at ?? null,
    raw: l,
    updated_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/sync/__tests__/mappers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/mappers.ts src/lib/sync/__tests__/mappers.test.ts
git commit -m "feat(sync): mapLead + first-class tags/notes on job and customer mappers"
```

---

## Task 4: Attachment extraction + best-effort re-hosting

**Files:**
- Create: `src/lib/sync/attachments.ts`
- Test: `src/lib/sync/__tests__/attachments.test.ts`

**Interfaces:**
- Produces:
  - `extractAttachmentRows(parentType: "customer" | "job", parentId: string, payload: unknown): AttachmentRow[]`
  - `syncAttachments(supabase: SupabaseClient, parentType: "customer" | "job", parentId: string, payload: unknown): Promise<void>`
  - type `AttachmentRow`

**Note on re-hosting (§2 risk):** metadata upsert always runs. The file download to Supabase Storage is **best-effort and wrapped in try/catch** — a failure (including HCP requiring auth on the file URL) leaves `storage_path` null and never fails the record's core upsert. Before enabling this in production, run the manual probe in Step 6.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/sync/__tests__/attachments.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { extractAttachmentRows, syncAttachments } from "../attachments";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("extractAttachmentRows", () => {
  it("maps each attachment to a row with parent linkage and metadata", () => {
    const rows = extractAttachmentRows("job", "j1", {
      attachments: [
        { id: "a1", url: "https://hcp/f1.pdf", content_type: "application/pdf", file_name: "invoice.pdf" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("a1");
    expect(rows[0].parent_type).toBe("job");
    expect(rows[0].parent_id).toBe("j1");
    expect(rows[0].hcp_url).toBe("https://hcp/f1.pdf");
    expect(rows[0].file_name).toBe("invoice.pdf");
    expect(rows[0].storage_path).toBeNull();
  });

  it("returns [] when there are no attachments", () => {
    expect(extractAttachmentRows("customer", "c1", {})).toEqual([]);
    expect(extractAttachmentRows("customer", "c1", { attachments: [] })).toEqual([]);
  });
});

describe("syncAttachments", () => {
  it("does not upsert when there are no attachments", async () => {
    const upsert = vi.fn(() => Promise.resolve({ error: null }));
    const supabase = { from: vi.fn(() => ({ upsert })) } as unknown as SupabaseClient;
    await syncAttachments(supabase, "job", "j1", { attachments: [] });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("upserts extracted rows into the attachments table", async () => {
    const upsert = vi.fn(() => Promise.resolve({ error: null }));
    // No `storage` on the mock: rehost() accesses supabase.storage inside its
    // try/catch, throws, and returns null — so storage_path stays null and the
    // metadata upsert still happens. This is the intended best-effort behavior.
    const supabase = { from: vi.fn(() => ({ upsert })) } as unknown as SupabaseClient;
    await syncAttachments(supabase, "job", "j1", {
      attachments: [{ id: "a1", url: "https://hcp/f1.pdf" }],
    });
    expect(supabase.from).toHaveBeenCalledWith("attachments");
    expect(upsert).toHaveBeenCalledOnce();
    const arg = upsert.mock.calls[0][0] as Array<{ id: string; storage_path: string | null }>;
    expect(arg[0].id).toBe("a1");
    expect(arg[0].storage_path).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/sync/__tests__/attachments.test.ts`
Expected: FAIL — module `../attachments` not found.

- [ ] **Step 3: Implement**

Create `src/lib/sync/attachments.ts`:

```typescript
// Attachments arrive embedded in customer/job payloads (attachments: [...]),
// not as their own webhook event. We always upsert metadata; re-hosting the
// file into Supabase Storage is best-effort and must never fail the parent
// record's core upsert (same philosophy as geocoding).
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AttachmentRow {
  id: string;
  parent_type: "customer" | "job";
  parent_id: string;
  file_name: string | null;
  content_type: string | null;
  hcp_url: string | null;
  storage_path: string | null;
  raw: unknown;
  updated_at: string;
}

const STORAGE_BUCKET = "hcp-attachments";

interface RawAttachment {
  id: string;
  url?: string;
  content_type?: string;
  file_name?: string;
}

function readAttachments(payload: unknown): RawAttachment[] {
  const a = (payload as { attachments?: unknown })?.attachments;
  return Array.isArray(a) ? (a as RawAttachment[]) : [];
}

export function extractAttachmentRows(
  parentType: "customer" | "job",
  parentId: string,
  payload: unknown
): AttachmentRow[] {
  const nowIso = new Date().toISOString();
  return readAttachments(payload).map((att) => ({
    id: att.id,
    parent_type: parentType,
    parent_id: parentId,
    file_name: att.file_name ?? null,
    content_type: att.content_type ?? null,
    hcp_url: att.url ?? null,
    storage_path: null,
    raw: att,
    updated_at: nowIso,
  }));
}

// Best-effort: download the HCP file and re-host it in Supabase Storage.
// Returns the storage path on success, or null on any failure (leaves the row
// pointing at hcp_url only). Never throws.
async function rehost(
  supabase: SupabaseClient,
  row: AttachmentRow
): Promise<string | null> {
  if (!row.hcp_url) return null;
  try {
    const res = await fetch(row.hcp_url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const path = `${row.parent_type}/${row.parent_id}/${row.id}`;
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, bytes, {
        contentType: row.content_type ?? undefined,
        upsert: true,
      });
    if (error) return null;
    return path;
  } catch {
    return null;
  }
}

export async function syncAttachments(
  supabase: SupabaseClient,
  parentType: "customer" | "job",
  parentId: string,
  payload: unknown
): Promise<void> {
  const rows = extractAttachmentRows(parentType, parentId, payload);
  if (rows.length === 0) return;

  for (const row of rows) {
    row.storage_path = await rehost(supabase, row);
  }

  const { error } = await supabase.from("attachments").upsert(rows);
  if (error) {
    throw new Error(`Failed to upsert attachments for ${parentType} ${parentId}: ${error.message}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/sync/__tests__/attachments.test.ts`
Expected: PASS. (In the second `syncAttachments` test, `fetch` is called on `https://hcp/f1.pdf`; if the sandbox blocks network, `fetch` throws and `rehost` catches it → `storage_path` null, exactly as asserted. If `fetch` is unavailable as a global under the test runtime, add `vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("blocked"))))` at the top of the test to make the failure deterministic.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/attachments.ts src/lib/sync/__tests__/attachments.test.ts
git commit -m "feat(sync): attachment extraction + best-effort Supabase Storage re-hosting"
```

- [ ] **Step 6: Manual probe (before enabling in prod)**

Create the `hcp-attachments` Storage bucket in the Supabase dashboard (or via the `supabase` CLI). Find one real HCP attachment URL (query `select raw->'attachments' from jobs where raw->'attachments' != '[]' limit 1`, or a customer) and `curl -I <url>`. If it returns the file without auth → re-hosting works as written. If it 401/403s → re-hosting silently no-ops (storage_path stays null; metadata still syncs); note this in the handoff as a follow-up. Either way the code is correct; this only decides whether files actually land in Storage.

---

## Task 5: Sync router — leads, `pro` alias, attachment wiring, delete branch

**Files:**
- Modify: `src/lib/sync/syncService.ts`
- Test: `src/lib/sync/__tests__/syncService.test.ts`

**Interfaces:**
- Consumes: `mapLead` (Task 3), `syncAttachments` (Task 4).
- Produces: `syncOneRecord(resource: string, event: string, data: unknown, action?: string)` — when `action === "deleted"`, deletes instead of upserting. Default `action` keeps upsert behavior (back-compat).

- [ ] **Step 1: Write the failing tests**

Read the existing `src/lib/sync/__tests__/syncService.test.ts` first to match its mock style, then add a shared helper (adapt to the file's existing `@/lib/supabase/client` mock — if it already exposes a `fromMock`, wire into that instead of adding a second mock):

```typescript
function installSupabaseMock() {
  const upsert = vi.fn(() => Promise.resolve({ error: null }));
  const eq = vi.fn(() => Promise.resolve({ error: null }));
  const del = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ upsert, delete: del }));
  fromMock.mockImplementation(from);
  return { upsert, eq, del, from };
}
```

Then append:

```typescript
describe("syncOneRecord leads + delete", () => {
  it("routes a singular 'lead' resource to the leads table", async () => {
    const { upsert, from } = installSupabaseMock();
    await syncOneRecord("lead", "lead.created", { id: "lead_1" });
    expect(from).toHaveBeenCalledWith("leads");
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("routes 'pro' to the technicians table", async () => {
    const { from } = installSupabaseMock();
    await syncOneRecord("pro", "pro.updated", { id: "emp_1" });
    expect(from).toHaveBeenCalledWith("technicians");
  });

  it("deletes instead of upserting when action is 'deleted'", async () => {
    const { del, eq, from } = installSupabaseMock();
    await syncOneRecord("customer", "customer.deleted", { id: "c1" }, "deleted");
    expect(from).toHaveBeenCalledWith("customers");
    expect(del).toHaveBeenCalledOnce();
    expect(eq).toHaveBeenCalledWith("id", "c1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/sync/__tests__/syncService.test.ts`
Expected: FAIL — `leads`/`pro` unknown resource; `action` param unsupported.

- [ ] **Step 3: Implement**

In `src/lib/sync/syncService.ts`:

Add imports:
```typescript
import { mapCustomer, mapEmployee, mapJob, mapEstimate, mapInvoice, mapLead } from "./mappers";
import { syncAttachments } from "./attachments";
import type { HcpCustomer, HcpJob, HcpEstimate, HcpInvoice, HcpLead } from "@/lib/housecall/types";
```
(Merge with the existing import lines rather than duplicating.)

Add to `TABLE_AND_MAPPER`:
```typescript
  leads: { table: "leads", mapper: (x) => mapLead(x as HcpLead) },
```

Add to `RESOURCE_ALIASES`:
```typescript
  lead: "leads",
  pro: "employees",
```

Replace the `syncOneRecord` function with:
```typescript
export async function syncOneRecord(
  resource: string,
  event: string,
  data: unknown,
  action?: string
) {
  const key = normalizeResource(resource);

  const config = TABLE_AND_MAPPER[key];
  if (!config) {
    throw new Error(`Unknown Housecall Pro resource for sync: ${resource}`);
  }

  const supabase = getSupabaseServerClient();

  // Delete events carry the record id; remove the row (and any attachments)
  // instead of upserting. syncOneRecord only ever upserted before, so a delete
  // event would otherwise re-insert the record.
  if (action === "deleted") {
    const id = (data as { id?: string })?.id;
    if (!id) throw new Error(`Delete event ${event} has no record id`);
    const { error } = await supabase.from(config.table).delete().eq("id", id);
    if (error) {
      throw new Error(`Failed to delete ${config.table} ${id} from event ${event}: ${error.message}`);
    }
    if (key === "customers" || key === "jobs") {
      await supabase
        .from("attachments")
        .delete()
        .eq("parent_type", key === "jobs" ? "job" : "customer")
        .eq("parent_id", id);
    }
    return;
  }

  const row = config.mapper(data);

  // Geocode this record's address (customers/jobs) before upserting.
  const targets = buildGeocodeTargets(key, [data], [row]);
  if (targets.length > 0) {
    await enrichRowsWithGeocode(supabase, targets, { remaining: 1 });
  }

  const { error } = await supabase.from(config.table).upsert(row);
  if (error) {
    throw new Error(`Failed to upsert ${config.table} row from event ${event}: ${error.message}`);
  }

  // Attachments ride embedded on customer/job payloads.
  if (key === "customers") {
    await syncAttachments(supabase, "customer", row.id as string, data);
  } else if (key === "jobs") {
    await syncAttachments(supabase, "job", row.id as string, data);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/sync/__tests__/syncService.test.ts`
Expected: PASS. If existing upsert tests fail because the shared mock lacks `delete` or a `storage`, extend the file's mock: add `delete: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }))` to the `from()` return, and (since customer/job upserts now call `syncAttachments`) ensure the customer/job test payloads have no `attachments` (or an empty array) so `syncAttachments` early-returns.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/syncService.ts src/lib/sync/__tests__/syncService.test.ts
git commit -m "feat(sync): leads + pro routing, embedded attachment sync, delete handling"
```

---

## Task 6: Webhook route — thread the event action

**Files:**
- Modify: `src/app/api/webhooks/housecall/route.ts`
- Test: `src/app/api/webhooks/housecall/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `syncOneRecord(resource, event, record, action)` (Task 5).

- [ ] **Step 1: Write the failing test**

Read the existing route test to match its signing/mock setup (it already mocks `syncOneRecord` and has a signed-POST helper). Add a test asserting a `*.deleted` event calls `syncOneRecord` with `action === "deleted"`. Use the file's existing mock name and signing helper:

```typescript
it("passes action 'deleted' through for a delete event", async () => {
  const body = JSON.stringify({ event: "customer.deleted", customer: { id: "c1" } });
  const res = await postSigned(body); // existing helper in this test file
  expect(res.status).toBe(200);
  expect(syncOneRecordMock).toHaveBeenCalledWith(
    "customer",
    "customer.deleted",
    { id: "c1" },
    "deleted"
  );
});
```
(If the existing mocked import is named differently than `syncOneRecordMock`, or the helper differently than `postSigned`, use those names. The record under `payload.customer` is `{ id: "c1" }`, so the route's existing "missing record" guard passes.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/webhooks/housecall/__tests__/route.test.ts`
Expected: FAIL — `syncOneRecord` called with 3 args, not 4.

- [ ] **Step 3: Implement**

In `src/app/api/webhooks/housecall/route.ts`, after `const resource = event.split(".")[0];` add:
```typescript
  const action = event.split(".").slice(1).join(".") || undefined;
```
Change the call site from `await syncOneRecord(resource, event, record);` to:
```typescript
    await syncOneRecord(resource, event, record, action);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/webhooks/housecall/__tests__/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/webhooks/housecall/route.ts src/app/api/webhooks/housecall/__tests__/route.test.ts
git commit -m "feat(webhook): thread event action so *.deleted events delete rows"
```

---

## Task 7: HCP client + cron — leads pass

**Files:**
- Modify: `src/lib/housecall/client.ts`, `src/app/api/cron/sync/route.ts`
- Test: `src/lib/housecall/__tests__/client.test.ts`, `src/app/api/cron/sync/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `syncResourceIncremental` (existing), `mapLead` (Task 3).
- Produces: `HousecallClient.listLeads(page)`.

- [ ] **Step 1: Write the failing client test**

Read `src/lib/housecall/__tests__/client.test.ts` for the fetch-mock style, then add (reuse the file's existing fetch mock / json-response helper and `HOUSECALL_API_KEY` setup):

```typescript
it("listLeads fetches /leads with the leads resource key", async () => {
  const client = new HousecallClient();
  fetchMock.mockResolvedValueOnce(jsonResponse({ leads: [{ id: "lead_1" }], page: 1, total_pages: 1 }));
  const result = await client.listLeads(1);
  expect(result.items).toEqual([{ id: "lead_1" }]);
  const url = fetchMock.mock.calls[0][0] as string;
  expect(url).toContain("/leads");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/housecall/__tests__/client.test.ts`
Expected: FAIL — `listLeads` is not a function.

- [ ] **Step 3: Implement the client method**

In `src/lib/housecall/client.ts`, add `HcpLead` to the types import and add the method after `listInvoices`:
```typescript
  listLeads(page = 1) {
    return this.request<HcpLead>("/leads", "leads", page, true);
  }
```

- [ ] **Step 4: Run client test to verify it passes**

Run: `npx vitest run src/lib/housecall/__tests__/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Add leads to the cron pass**

In `src/app/api/cron/sync/route.ts`:
- Add `mapLead` to the mappers import.
- Add a leads entry to the incremental `results` array, alongside estimates:
```typescript
    await syncResourceIncremental(supabase, "leads", (p) => hcp.listLeads(p), mapLead, budget, cursors.get("leads") ?? null),
```

- [ ] **Step 6: Run the cron route test**

Run: `npx vitest run src/app/api/cron/sync/__tests__/route.test.ts`
Expected: PASS. If the test asserts the exact set of synced resources or mocks `HousecallClient`, extend it: stub `hcp.listLeads` to return one empty page (`{ items: [], page: 1, totalPages: 1 }`) and add `leads` to any expected-resources assertion.

- [ ] **Step 7: Commit**

```bash
git add src/lib/housecall/client.ts src/app/api/cron/sync/route.ts src/lib/housecall/__tests__/client.test.ts src/app/api/cron/sync/__tests__/route.test.ts
git commit -m "feat(sync): sync Leads via client.listLeads + cron incremental pass"
```

---

## Task 8: Town→zone lookup

**Files:**
- Create: `src/lib/geo/townZones.ts`
- Test: `src/lib/geo/__tests__/townZones.test.ts`

**Interfaces:**
- Produces: `zoneForTown(town: string | null | undefined): string | null` (case-insensitive; null when unknown/missing); `TOWN_ZONES: Record<string, string>`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/geo/__tests__/townZones.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { zoneForTown } from "../townZones";

describe("zoneForTown", () => {
  it("resolves a known town case-insensitively", () => {
    expect(zoneForTown("Delmar")).toBe("Albany Zone");
    expect(zoneForTown("delmar")).toBe("Albany Zone");
    expect(zoneForTown("  DELMAR ")).toBe("Albany Zone");
  });

  it("returns null for an unknown town", () => {
    expect(zoneForTown("Nowhereville")).toBeNull();
  });

  it("returns null for missing input", () => {
    expect(zoneForTown(null)).toBeNull();
    expect(zoneForTown(undefined)).toBeNull();
    expect(zoneForTown("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/geo/__tests__/townZones.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement with a seed table**

Create `src/lib/geo/townZones.ts` (definitive list refined in Step 5 from live data):

```typescript
// Town/city -> dispatch zone. The authoritative zone signal for a job; when a
// town is absent from this table, callers fall back to distance/compass rules
// (see zones.ts). Seeded from the roadmap's example zones and common Capital
// District towns; extend as real job towns appear (see the census in Step 5).
export const TOWN_ZONES: Record<string, string> = {
  "averill park": "Albany Zone",
  "albany": "Albany Zone",
  "delmar": "Albany Zone",
  "slingerlands": "Albany Zone",
  "troy": "Albany Zone",
  "east greenbush": "Albany Zone",
  "rensselaer": "Albany Zone",
  "wynantskill": "Albany Zone",
  "saratoga springs": "North Route",
  "glens falls": "North Route",
  "ballston spa": "North Route",
  "queensbury": "North Route",
  "bennington": "Vermont Route",
  "manchester": "Vermont Route",
  "pownal": "Vermont Route",
  "pittsfield": "Southern Berkshire Route",
  "great barrington": "Southern Berkshire Route",
  "williamstown": "Southern Berkshire Route",
};

export function zoneForTown(town: string | null | undefined): string | null {
  if (!town) return null;
  return TOWN_ZONES[town.trim().toLowerCase()] ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/geo/__tests__/townZones.test.ts`
Expected: PASS.

- [ ] **Step 5: Census real towns + get user approval**

Query the live data for the actual town distribution and reconcile the table:
```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/customers?select=city" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  | jq -r '.[].city' | sort | uniq -c | sort -rn | head -50
```
Present the town list to the user, add any high-frequency town missing from `TOWN_ZONES`, and get approval on zone assignments before finalizing. Commit the refined table.

- [ ] **Step 6: Commit**

```bash
git add src/lib/geo/townZones.ts src/lib/geo/__tests__/townZones.test.ts
git commit -m "feat(geo): town->zone lookup table (zoneForTown)"
```

---

## Task 9: Town-first `classifyZone`

**Files:**
- Modify: `src/lib/geo/zones.ts`
- Test: `src/lib/geo/__tests__/zones.test.ts`

**Interfaces:**
- Consumes: `zoneForTown` (Task 8), existing `distanceFromAverillPark`/`compassDirectionFromAverillPark`.
- Produces: `classifyZone(lat: number, lng: number, town?: string | null): { zone: string; compass: string; source: "town" | "distance" }`.

- [ ] **Step 1: Write the failing tests**

Read the existing `src/lib/geo/__tests__/zones.test.ts`. The existing tests call `classifyZone(lat, lng)` and read `.zone`/`.compass` — those must keep passing (the new `town` param is optional, `source` is additive). Append:

```typescript
describe("classifyZone town-first", () => {
  it("uses the town lookup when the town is known, marking source 'town'", () => {
    const result = classifyZone(44.3, -73.2, "Delmar"); // coords far away, town wins
    expect(result.zone).toBe("Albany Zone");
    expect(result.source).toBe("town");
    expect(result.compass).toBeTypeOf("string");
  });

  it("falls back to distance rules when the town is unknown", () => {
    const result = classifyZone(42.6337, -73.5504, "Nowhereville");
    expect(result.source).toBe("distance");
    expect(result.zone).toBe("Albany Zone"); // origin -> within 15mi
  });

  it("falls back to distance rules when no town is given", () => {
    const result = classifyZone(42.6337, -73.5504);
    expect(result.source).toBe("distance");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/geo/__tests__/zones.test.ts`
Expected: FAIL — `classifyZone` takes 2 args, no `source` field.

- [ ] **Step 3: Implement**

Replace `src/lib/geo/zones.ts` with:

```typescript
import { distanceFromAverillPark, compassDirectionFromAverillPark } from "./distance";
import { zoneForTown } from "./townZones";

// Town-first zone resolution. A known town wins (matches how the dispatcher
// thinks); otherwise fall back to distance/compass rules. Starting thresholds
// encode Ellah's informal dispatch zones from the roadmap doc — tune as real
// job data comes in.
export function classifyZone(
  lat: number,
  lng: number,
  town?: string | null
): { zone: string; compass: string; source: "town" | "distance" } {
  const compass = compassDirectionFromAverillPark(lat, lng);

  const townZone = zoneForTown(town);
  if (townZone) {
    return { zone: townZone, compass, source: "town" };
  }

  const { miles } = distanceFromAverillPark(lat, lng);

  if (miles <= 15) return { zone: "Albany Zone", compass, source: "distance" };
  // North Route extends farther: Glens Falls (~46 mi due north) is regular.
  if ((compass === "N" || compass === "NW") && miles <= 50) return { zone: "North Route", compass, source: "distance" };
  if ((compass === "E" || compass === "SE") && miles <= 35) return { zone: "Southern Berkshire Route", compass, source: "distance" };
  if ((compass === "NE" || compass === "E") && miles > 15 && miles <= 40) return { zone: "Vermont Route", compass, source: "distance" };
  if (miles <= 40) return { zone: "Extended Service Area", compass, source: "distance" };
  return { zone: "Outside Service Area", compass, source: "distance" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/geo/__tests__/zones.test.ts`
Expected: PASS (existing 2-arg tests and new town-first tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/geo/zones.ts src/lib/geo/__tests__/zones.test.ts
git commit -m "feat(geo): town-first classifyZone with distance-rule fallback"
```

---

## Task 10: Week-boundary helper

**Files:**
- Create: `src/lib/dashboard/week.ts`
- Test: `src/lib/dashboard/__tests__/week.test.ts`

**Interfaces:**
- Produces:
  - `weekRange(now: Date, which: "this" | "next"): { startIso: string; endIso: string }` — Mon 00:00 to the following Mon 00:00 (end exclusive), UTC.
  - `dayRange(now: Date): { startIso: string; endIso: string }` — today 00:00 to tomorrow 00:00 (end exclusive), UTC.

**Note:** ranges are UTC to match how `scheduled_start` is stored (timestamptz, ISO). Business-local weeks are a documented follow-up; UTC is correct and testable now. `now` is injected so tests are deterministic (no `Date.now()` inside).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/dashboard/__tests__/week.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { weekRange, dayRange } from "../week";

describe("weekRange", () => {
  it("returns Monday..Monday for 'this' week given a Wednesday", () => {
    // 2026-07-22 is a Wednesday.
    const { startIso, endIso } = weekRange(new Date("2026-07-22T14:00:00Z"), "this");
    expect(startIso).toBe("2026-07-20T00:00:00.000Z"); // Mon
    expect(endIso).toBe("2026-07-27T00:00:00.000Z");   // next Mon (exclusive)
  });

  it("treats Sunday as the last day of the current week, not the first", () => {
    // 2026-07-26 is a Sunday.
    const { startIso, endIso } = weekRange(new Date("2026-07-26T23:00:00Z"), "this");
    expect(startIso).toBe("2026-07-20T00:00:00.000Z");
    expect(endIso).toBe("2026-07-27T00:00:00.000Z");
  });

  it("returns the following Mon..Mon for 'next'", () => {
    const { startIso, endIso } = weekRange(new Date("2026-07-22T14:00:00Z"), "next");
    expect(startIso).toBe("2026-07-27T00:00:00.000Z");
    expect(endIso).toBe("2026-08-03T00:00:00.000Z");
  });
});

describe("dayRange", () => {
  it("returns today 00:00 to tomorrow 00:00", () => {
    const { startIso, endIso } = dayRange(new Date("2026-07-22T14:00:00Z"));
    expect(startIso).toBe("2026-07-22T00:00:00.000Z");
    expect(endIso).toBe("2026-07-23T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/dashboard/__tests__/week.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/dashboard/week.ts`:

```typescript
// Mon–Sun week boundaries in UTC. `scheduled_start` is stored as an ISO
// timestamptz, so UTC ranges compare directly. `now` is injected for
// deterministic tests. End is exclusive (use with >= start, < end semantics).
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Days since Monday: getUTCDay() is 0=Sun..6=Sat; Monday-based is (day+6)%7.
function mondayOfWeek(d: Date): Date {
  const day = startOfUtcDay(d);
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * 86_400_000);
}

export function weekRange(now: Date, which: "this" | "next"): { startIso: string; endIso: string } {
  const thisMon = mondayOfWeek(now);
  const start = which === "this" ? thisMon : new Date(thisMon.getTime() + 7 * 86_400_000);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function dayRange(now: Date): { startIso: string; endIso: string } {
  const start = startOfUtcDay(now);
  const end = new Date(start.getTime() + 86_400_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/dashboard/__tests__/week.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dashboard/week.ts src/lib/dashboard/__tests__/week.test.ts
git commit -m "feat(dashboard): Mon-Sun week + day boundary helper"
```

---

## Task 11: Dashboard queries — new metrics + panels data

**Files:**
- Modify: `src/lib/dashboard/queries.ts`
- Test: `src/lib/dashboard/__tests__/queries.test.ts`

**Interfaces:**
- Consumes: `weekRange`, `dayRange` (Task 10); `classifyZone` (Task 9).
- Produces: `DashboardSnapshot` extended with `upcomingEstimates: number`, `revenueBookedThisWeekCents: number` (replaces the old all-time `revenueBookedCents`), `revenueScheduledNextWeekCents: number`, `todaySchedule: Array<{ id: string; scheduledStart: string | null; customerName: string | null; technicianName: string | null; zone: string; compass: string }>`, `technicianWorkload: Array<{ technicianId: string | null; technicianName: string | null; jobCount: number; scheduledHours: number }>`; `getDashboardSnapshot(now?: Date)` accepts an injected clock (defaults to `new Date()`).

- [ ] **Step 1: Write the failing tests**

Read the existing `src/lib/dashboard/__tests__/queries.test.ts`. Extend the `jobs` fixture rows to carry `scheduled_start`, `scheduled_end`, `technician_id`, `service_address_lat`, `service_address_lng`, and `raw` (with `customer.id` and `address.city`); add `customers` and `technicians` branches to `fromMock`. Pick concrete dates so windows are unambiguous (with `now = 2026-07-22`, this-week = 07-20..07-27, next-week = 07-27..08-03, today = 07-22). Then add:

```typescript
it("date-scopes revenue booked to the current Mon-Sun week", async () => {
  const now = new Date("2026-07-22T12:00:00Z");
  const snap = await getDashboardSnapshot(now);
  // Sum total_amount_cents of jobs whose scheduled_start is in 07-20..07-27.
  expect(snap.revenueBookedThisWeekCents).toBe(EXPECTED_THIS_WEEK); // set from fixture
});

it("sums revenue scheduled for next week", async () => {
  const now = new Date("2026-07-22T12:00:00Z");
  const snap = await getDashboardSnapshot(now);
  expect(snap.revenueScheduledNextWeekCents).toBe(EXPECTED_NEXT_WEEK);
});

it("builds today's schedule with zone/compass per job", async () => {
  const now = new Date("2026-07-22T12:00:00Z");
  const snap = await getDashboardSnapshot(now);
  expect(Array.isArray(snap.todaySchedule)).toBe(true);
  if (snap.todaySchedule.length > 0) {
    expect(snap.todaySchedule[0].zone).toBeTypeOf("string");
    expect(snap.todaySchedule[0].compass).toBeTypeOf("string");
  }
});

it("aggregates technician workload for today", async () => {
  const now = new Date("2026-07-22T12:00:00Z");
  const snap = await getDashboardSnapshot(now);
  expect(Array.isArray(snap.technicianWorkload)).toBe(true);
});
```
Set `EXPECTED_THIS_WEEK` / `EXPECTED_NEXT_WEEK` from the fixture rows you author (e.g. one job at `2026-07-22` with 20000 → this-week; one at `2026-07-29` with 15000 → next-week). Keep the existing 6-metric assertions; rename any `revenueBookedCents` assertion to `revenueBookedThisWeekCents` and give those fixture jobs a `scheduled_start` inside the current week so the value is non-zero.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/dashboard/__tests__/queries.test.ts`
Expected: FAIL — new fields undefined, `getDashboardSnapshot` ignores `now`.

- [ ] **Step 3: Implement**

In `src/lib/dashboard/queries.ts`:
- Add imports: `import { weekRange, dayRange } from "./week";` and `import { classifyZone } from "@/lib/geo/zones";`.
- Define row-type aliases near the top (reflecting the selected columns):
```typescript
interface JobRow {
  id: string;
  work_status: string | null;
  is_emergency: boolean;
  is_commercial: boolean;
  total_amount_cents: number | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  technician_id: string | null;
  service_address_lat: number | null;
  service_address_lng: number | null;
  raw?: { customer?: { id?: string }; address?: { city?: string } };
}
interface EstimateRow { status: string | null; raw?: { options?: EstimateOption[]; scheduled_start?: string } }
interface CustomerRow { id: string; first_name: string | null; last_name: string | null; city: string | null }
interface TechRow { id: string; first_name: string | null; last_name: string | null }
```
- Update `DashboardSnapshot`: rename `revenueBookedCents` → `revenueBookedThisWeekCents` and add `upcomingEstimates: number`, `revenueScheduledNextWeekCents: number`, `todaySchedule: TodayScheduleRow[]`, `technicianWorkload: TechWorkloadRow[]` (declare those two row types with the fields listed in Interfaces above).
- Replace `getDashboardSnapshot` with:

```typescript
export async function getDashboardSnapshot(now: Date = new Date()): Promise<DashboardSnapshot> {
  const supabase = getSupabaseServerClient();
  const thisWeek = weekRange(now, "this");
  const nextWeek = weekRange(now, "next");
  const today = dayRange(now);

  const [jobs, estimates, invoices, customers, technicians] = await Promise.all([
    fetchAllRows<JobRow>(supabase, "jobs", "id, work_status, is_emergency, is_commercial, total_amount_cents, scheduled_start, scheduled_end, technician_id, service_address_lat, service_address_lng, raw"),
    fetchAllRows<EstimateRow>(supabase, "estimates", "status, raw"),
    fetchAllRows<{ status: string | null }>(supabase, "invoices", "status"),
    fetchAllRows<CustomerRow>(supabase, "customers", "id, first_name, last_name, city"),
    fetchAllRows<TechRow>(supabase, "technicians", "id, first_name, last_name"),
  ]);

  const custById = new Map(customers.map((c) => [c.id, c]));
  const techById = new Map(technicians.map((t) => [t.id, t]));
  const fullName = (r?: { first_name: string | null; last_name: string | null }) =>
    r ? [r.first_name, r.last_name].filter(Boolean).join(" ") || null : null;

  const inWindow = (iso: string | null, w: { startIso: string; endIso: string }) =>
    !!iso && iso >= w.startIso && iso < w.endIso;

  const todayJobs = jobs.filter((j) => inWindow(j.scheduled_start, today));

  const todaySchedule = todayJobs
    .slice()
    .sort((a, b) => (a.scheduled_start ?? "").localeCompare(b.scheduled_start ?? ""))
    .map((j) => {
      const cust = custById.get(j.raw?.customer?.id ?? "");
      const town = j.raw?.address?.city ?? cust?.city ?? null;
      const hasCoords = j.service_address_lat != null && j.service_address_lng != null;
      const z = hasCoords
        ? classifyZone(j.service_address_lat as number, j.service_address_lng as number, town)
        : { zone: "Unknown", compass: "", source: "distance" as const };
      return {
        id: j.id,
        scheduledStart: j.scheduled_start,
        customerName: fullName(cust),
        technicianName: fullName(techById.get(j.technician_id ?? "")),
        zone: z.zone,
        compass: z.compass,
      };
    });

  const workloadMap = new Map<string, { jobCount: number; ms: number }>();
  for (const j of todayJobs) {
    const key = j.technician_id ?? "__unassigned";
    const cur = workloadMap.get(key) ?? { jobCount: 0, ms: 0 };
    cur.jobCount += 1;
    if (j.scheduled_start && j.scheduled_end) {
      cur.ms += Math.max(0, Date.parse(j.scheduled_end) - Date.parse(j.scheduled_start));
    }
    workloadMap.set(key, cur);
  }
  const technicianWorkload = Array.from(workloadMap.entries()).map(([techId, v]) => ({
    technicianId: techId === "__unassigned" ? null : techId,
    technicianName: techId === "__unassigned" ? "Unassigned" : fullName(techById.get(techId)),
    jobCount: v.jobCount,
    scheduledHours: Math.round((v.ms / 3_600_000) * 10) / 10,
  }));

  const bookedThisWeek = jobs
    .filter((j) => inWindow(j.scheduled_start, thisWeek))
    .reduce((s, j) => s + (j.total_amount_cents ?? 0), 0);
  const scheduledNextWeek = jobs
    .filter((j) => inWindow(j.scheduled_start, nextWeek))
    .reduce((s, j) => s + (j.total_amount_cents ?? 0), 0);

  const upcomingEstimates = estimates.filter(
    (e) => isOpenEstimate(e) && !!e.raw?.scheduled_start && e.raw.scheduled_start >= today.startIso
  ).length;

  return {
    jobsInProgress: jobs.filter((j) => j.work_status === JOB_IN_PROGRESS).length,
    emergencyCalls: jobs.filter((j) => j.is_emergency).length,
    commercialJobs: jobs.filter((j) => j.is_commercial).length,
    openEstimates: estimates.filter(isOpenEstimate).length,
    pendingInvoices: invoices.filter((i) => i.status === INVOICE_PENDING).length,
    upcomingEstimates,
    revenueBookedThisWeekCents: bookedThisWeek,
    revenueScheduledNextWeekCents: scheduledNextWeek,
    todaySchedule,
    technicianWorkload,
  };
}
```
(`isOpenEstimate`'s parameter type already reads `raw?.options`; widen it to also allow `scheduled_start` — i.e. `{ status: string | null; raw?: { options?: EstimateOption[]; scheduled_start?: string } }` — so both call sites typecheck.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/dashboard/__tests__/queries.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint (unused-var / any check)**

Run: `npm run lint`
Expected: PASS. Fix any `any` or unused-var findings in the new code.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard/queries.ts src/lib/dashboard/__tests__/queries.test.ts
git commit -m "feat(dashboard): upcoming estimates, week-scoped revenue, today schedule + tech workload data"
```

---

## Task 12: Dashboard UI — new cards + panels

**Files:**
- Create: `src/app/dashboard/components/TodaySchedulePanel.tsx`, `src/app/dashboard/components/TechnicianWorkloadPanel.tsx`
- Modify: `src/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `DashboardSnapshot` (Task 11), existing `MetricCard`.

- [ ] **Step 1: Create the Today's schedule panel**

Create `src/app/dashboard/components/TodaySchedulePanel.tsx`:

```tsx
import type { DashboardSnapshot } from "@/lib/dashboard/queries";

export function TodaySchedulePanel({ jobs }: { jobs: DashboardSnapshot["todaySchedule"] }) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ marginBottom: 12 }}>Today&apos;s Schedule</h2>
      {jobs.length === 0 ? (
        <p style={{ color: "#666" }}>No jobs scheduled today.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: 8 }}>Time</th>
              <th style={{ padding: 8 }}>Customer</th>
              <th style={{ padding: 8 }}>Technician</th>
              <th style={{ padding: 8 }}>Zone</th>
              <th style={{ padding: 8 }}>Dir</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: 8 }}>
                  {j.scheduledStart ? new Date(j.scheduledStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                </td>
                <td style={{ padding: 8 }}>{j.customerName ?? "—"}</td>
                <td style={{ padding: 8 }}>{j.technicianName ?? "Unassigned"}</td>
                <td style={{ padding: 8 }}>{j.zone}</td>
                <td style={{ padding: 8 }}>{j.compass}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Create the Technician workload panel**

Create `src/app/dashboard/components/TechnicianWorkloadPanel.tsx`:

```tsx
import type { DashboardSnapshot } from "@/lib/dashboard/queries";

export function TechnicianWorkloadPanel({ rows }: { rows: DashboardSnapshot["technicianWorkload"] }) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ marginBottom: 12 }}>Technician Workload (Today)</h2>
      {rows.length === 0 ? (
        <p style={{ color: "#666" }}>No assigned work today.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: 8 }}>Technician</th>
              <th style={{ padding: 8 }}>Jobs</th>
              <th style={{ padding: 8 }}>Scheduled Hours</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.technicianId ?? "unassigned"} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: 8 }}>{r.technicianName ?? "Unassigned"}</td>
                <td style={{ padding: 8 }}>{r.jobCount}</td>
                <td style={{ padding: 8 }}>{r.scheduledHours}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Wire into the page**

Replace `src/app/dashboard/page.tsx` with:

```tsx
import { getDashboardSnapshot } from "@/lib/dashboard/queries";
import { MetricCard } from "./components/MetricCard";
import { TodaySchedulePanel } from "./components/TodaySchedulePanel";
import { TechnicianWorkloadPanel } from "./components/TechnicianWorkloadPanel";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const snapshot = await getDashboardSnapshot();
  const money = (cents: number) => `$${(cents / 100).toLocaleString()}`;

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 24 }}>Trinity Plumbing Operations Dashboard</h1>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <MetricCard label="Jobs in Progress" value={snapshot.jobsInProgress} />
        <MetricCard label="Emergency Calls" value={snapshot.emergencyCalls} highlight={snapshot.emergencyCalls > 0} />
        <MetricCard label="Commercial Jobs" value={snapshot.commercialJobs} />
        <MetricCard label="Open Estimates" value={snapshot.openEstimates} />
        <MetricCard label="Upcoming Estimates" value={snapshot.upcomingEstimates} />
        <MetricCard label="Pending Invoices" value={snapshot.pendingInvoices} />
        <MetricCard label="Revenue Booked (This Week)" value={money(snapshot.revenueBookedThisWeekCents)} />
        <MetricCard label="Revenue Scheduled (Next Week)" value={money(snapshot.revenueScheduledNextWeekCents)} />
      </div>
      <TodaySchedulePanel jobs={snapshot.todaySchedule} />
      <TechnicianWorkloadPanel rows={snapshot.technicianWorkload} />
    </main>
  );
}
```

- [ ] **Step 4: Build to verify it compiles**

Ensure `npm run dev` is NOT running first. Run: `npm run build`
Expected: PASS (compiles, lints clean).

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/
git commit -m "feat(dashboard): render upcoming estimates, week revenue, today schedule + tech workload"
```

---

## Task 13: Full verification + handoff update

**Files:**
- Modify: `docs/NEXT-SESSION-HANDOFF.md`

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: ALL PASS (existing + new).

- [ ] **Step 2: Lint + build**

Run: `npm run lint` then `npm run build` (confirm `npm run dev` is not running first).
Expected: both clean.

- [ ] **Step 3: Verify against live data**

Start the app (`npm run dev`), open `/dashboard`, and confirm: the 8 cards render, "Revenue Booked (This Week)" is now week-scoped (not the old $145,708.30 all-time figure), and the two panels render (empty-state is acceptable if no jobs are scheduled today). Spot-check one town in Today's schedule resolves to the expected zone.

- [ ] **Step 4: Update the handoff doc**

In `docs/NEXT-SESSION-HANDOFF.md`, mark the completed Phase-1 items: Leads synced, Attachments synced (note the re-hosting probe result), Tags/Notes first-class, delete handling shipped, 4 dashboard cards built + revenue date-scoped, geographic computed fields wired. Leave the `invoice.*` webhook enablement and Vercel Hobby licensing as still-open operational items.

- [ ] **Step 5: Commit**

```bash
git add docs/NEXT-SESSION-HANDOFF.md
git commit -m "docs(handoff): Phase-1 completion — leads, attachments, tags/notes, delete handling, dashboard, geo"
```

---

## Operational follow-ups (config, not code — do in HCP/Vercel after deploy)

- **Enable `invoice.*` webhooks** in the HCP dashboard to close the ~21h invoice lag; the cron reconcile stays as backstop.
- **Enable `customer.deleted` / `job.deleted` webhooks** — now safe, since Task 5 added delete handling.
- **Remove `WEBHOOK_DEBUG=1`** from Vercel (no-op now).
- **Create the `hcp-attachments` Storage bucket** if the Task 4 probe confirmed re-hosting works.
- **Redeploy** (`vercel --prod`) after migration 0005 is applied to production Supabase.

---

## Self-Review

**Spec coverage:**
- Leads sync → Tasks 2, 3, 5, 7 ✅
- Attachments (metadata + copy to Storage) → Task 4 (+wiring Task 5) ✅
- Tags/Notes first-class columns → Tasks 1, 3 ✅
- Delete handling → Tasks 5, 6 ✅
- Geo computed fields, town-first zones → Tasks 8, 9 (math already existed) ✅
- Dashboard 4 new elements + date-scoped revenue (Mon–Sun) → Tasks 10, 11, 12 ✅
- Invoice webhooks enablement → operational follow-up (config, not code) ✅
- Testing against live data → Tasks 8 (census), 13 ✅

**Placeholder scan:** No "TBD"/"implement later". Task 11's `EXPECTED_THIS_WEEK`/`EXPECTED_NEXT_WEEK` are explicitly derived from fixture rows the implementer authors, with concrete example values given — not a vague placeholder. Tasks 5/6/7 reference existing test-helper names the implementer will confirm by opening the file (flagged inline) because those names live in files not fully quoted here.

**Type consistency:** `classifyZone(lat, lng, town?)` → `{ zone, compass, source }`, consumed in Task 11. `weekRange`/`dayRange` → `{ startIso, endIso }`, consumed via `inWindow`. `DashboardSnapshot` field names (`revenueBookedThisWeekCents`, `revenueScheduledNextWeekCents`, `upcomingEstimates`, `todaySchedule`, `technicianWorkload`) match between Tasks 11 and 12. `syncOneRecord(resource, event, data, action?)` matches between Tasks 5 and 6. `mapLead` row shape (`id, customer_id, status, source, created_at, raw, updated_at`) matches the `leads` table columns in Task 1.
