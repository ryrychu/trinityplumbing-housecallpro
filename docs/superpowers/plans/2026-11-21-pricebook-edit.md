# Trinity Price Book Editor: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dave and Ella can change the Housecall Pro price book through a new Dave-and-Ella-only ChatGPT connector.
- Materials are edited directly: preview, then apply, with every change logged and undoable.
- Service changes, which HCP's API can't make, are posted to a Slack checklist and checked against HCP when ticked.

**Architecture:**
- A new MCP endpoint at `/api/mcp/pricebook-edit` calls the modules in `src/lib/pricebook/edit/`:
  - `changes.ts`: preview and guardrails (pure)
  - `apply.ts`: apply, add and the write-access check
  - `undo.ts`
  - `serviceChecklist.ts`
  - `store.ts`: a Supabase change log plus a previews table
- A new GET/PUT/POST HCP client, `src/lib/housecall/pricebookWrite.ts`. The existing read client stays GET-only.
- `/api/slack/interact` learns to route `pb_cb:` taps alongside the existing `fieldy_cb:` taps.

**Tech stack:** Next.js 14 App Router, TypeScript (strict), Supabase (service role), `@modelcontextprotocol/sdk` + `zod`, Slack Web API with Block Kit checkboxes, the HCP public API (`housecall.v1.yaml`), and vitest.

**Spec:** `docs/superpowers/specs/2026-11-21-pricebook-edit-design.md`

## Global Constraints

**Switches and access**
- Kill switch: `MCP_PRICEBOOK_EDIT_ENABLED`, off unless exactly `"true"`. It gates both the connector and `pb_cb:` Slack taps.
- Editors: `MCP_PRICEBOOK_EDITORS` holds comma-separated `supabaseUserId:Name` pairs, e.g. `8f1…:Dave,2c4…:Ella`. A pair with no `:Name` uses the id as the name.
  - Any caller not on the list gets exactly `"The price book editor is only available to Dave and Ella."` on every tool, before any work.
- Slack:
  - `SLACK_PRICEBOOK_CHANNEL_ID` is the channel.
  - `SLACK_PRICEBOOK_ALLOWED_USERS` lists the comma-separated Slack member IDs allowed to tick.
  - Anyone else who ticks gets exactly `"Only Dave and Ella can check these off."`

**HCP writes**
- Money is integer cents in HCP and everywhere internally. Tools accept dollars (`145`, `"145"`, `"$1,145.50"`) and show both forms.
- Only these HCP write calls exist in this feature:
  - `PUT /api/price_book/materials/{uuid}`
  - `POST /api/price_book/materials?material_category_uuid=…`
- No deletes. No writes to services, categories or price forms.
- The existing `src/lib/housecall/pricebook.ts` stays GET-only, and its "never writes" test must keep passing.

**Limits and timings**
- Guardrail values:
  - Max 50 items per preview or service request.
  - A price change of more than 25% (in absolute terms) is a warning.
  - A description under 20 characters is "short".
  - A preview lives 15 minutes.
  - Undo reaches back 30 days.
- Apply goes one item at a time.

**Logging**
- Never log price book text, the HCP key, the Slack token or `response_url`.
- HCP errors carry only `status` and `path`.

**Code rules**
- No `for…of` or spread over a `Map` or `Set`. Use `Array.from` (tsconfig has no `target`).
- No new npm dependencies.
- Typecheck baseline: `npx tsc --noEmit` has 8 pre-existing errors in `src/app/api/app/*/__tests__`. Add none.
- `npm run lint` must stay clean.
- Run tests with `npx vitest run <path>`.

**Behaviour that must not change**
- Fieldy taps behave exactly as now, and all existing `src/app/api/slack/interact` and `src/lib/tasks` tests keep passing.

## Deviations from the spec (decided while planning)

- **Read connector cache.** The read connector's 2-minute cache lives inside its own serverless function instance, so the editor can't clear it. The editor reads with `ttlMs: 0`, so it is always fresh. The read connector may show old values for up to 2 minutes, and `apply_material_changes` says so.
- **Category uuid storage.** It is stored in a dedicated `category_uuid` column, not in `before`/`after` metadata.
- **Who made a change.** The connector's `McpCaller` carries the user id only, no email. Names come from `MCP_PRICEBOOK_EDITORS` pairs, so the log stores `requested_by` (the user id) and shows the name.
- **Unticking a service.** It puts the service change back to `pending`.

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/housecall/pricebookWrite.ts` | create | `HousecallPricebookWriter`: `updateMaterial`, `createMaterial`, `getMaterial`, `HcpWriteError` |
| `src/lib/mcp/pricebook.ts` | modify | Optional `categoryUuid` on `PricebookItem`, behind a loader option `includeCategoryUuid` |
| `supabase/migrations/0009_pricebook_changes.sql` | create | `pricebook_changes` and `pricebook_previews` |
| `src/lib/pricebook/edit/types.ts` | create | Shared types |
| `src/lib/pricebook/edit/store.ts` | create | `PricebookEditStore` + Supabase implementation |
| `src/lib/pricebook/edit/changes.ts` | create | `parseMoney`, `applyPercent`, `buildPreview`, `fieldsDiffer`, `toHcpFields` |
| `src/lib/pricebook/edit/apply.ts` | create | `createPreview`, `applyPreview`, `addMaterial`, `checkWriteAccess`, `EditError` |
| `src/lib/pricebook/edit/undo.ts` | create | `undoChange` |
| `src/lib/pricebook/edit/serviceChecklist.ts` | create | `requestServiceChanges`, `renderServiceBatch`, `rerenderBatch`, `handleServiceTap`, `parsePbActionId` |
| `src/lib/pricebook/edit/deps.ts` | create | Live wiring, editor parsing, switches, config checks |
| `src/lib/pricebook/edit/__tests__/fakes.ts` | create | Memory store, fake writer, fake Slack, `item()` |
| `src/lib/slack/web.ts` | modify | `postThreadReply` |
| `src/app/api/slack/interact/route.ts` | modify | Routes `fieldy_cb:` and `pb_cb:` taps |
| `src/lib/mcp/auth.ts` | modify | `PRICEBOOK_EDIT_RESOURCE` |
| `src/lib/mcp/pricebookEdit/server.ts` | create | MCP tools |
| `src/app/api/mcp/pricebook-edit/route.ts` | create | Endpoint |
| `src/app/.well-known/oauth-protected-resource/api/mcp/pricebook-edit/route.ts` | create | RFC 9728 metadata |
| `docs/SLACK-ROLLOUT.md` | modify | A rollout section |

---

### Task 1: The HCP write client, and the category uuid on price book items

**Files:**
- Create: `src/lib/housecall/pricebookWrite.ts`, `src/lib/housecall/__tests__/pricebookWrite.test.ts`
- Modify: `src/lib/mcp/pricebook.ts`, `src/lib/mcp/__tests__/pricebook.test.ts` (append)

**Interfaces produced:**
```ts
export type HcpMaterialFields = { name?: string; description?: string; price?: number; cost?: number; unit_of_measure?: string; part_number?: string; taxable?: boolean };
export class HcpWriteError extends Error { readonly status: number; readonly path: string }
export class HousecallPricebookWriter {
  constructor(apiKey?: string, fetchImpl?: typeof fetch);
  updateMaterial(uuid: string, fields: HcpMaterialFields): Promise<void>;
  createMaterial(categoryUuid: string, fields: HcpMaterialFields & { name: string; price: number }): Promise<{ uuid: string }>;
  getMaterial(uuid: string, categoryUuid: string): Promise<PricebookItem | null>;
}
// pricebook.ts
PricebookItem gains `categoryUuid?: string`  (present only when the loader has includeCategoryUuid: true)
createPricebookLoader(client, { ..., includeCategoryUuid?: boolean })
```

- [ ] **Step 1: Write the failing tests.** Create `src/lib/housecall/__tests__/pricebookWrite.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { HousecallPricebookWriter, HcpWriteError } from "../pricebookWrite";

function fakeFetch(handler: (url: URL, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = handler(new URL(url), init ?? {});
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("HousecallPricebookWriter", () => {
  it("PUTs only the given fields to the material", async () => {
    const f = fakeFetch(() => ({ body: { uuid: "m1" } }));
    await new HousecallPricebookWriter("key-1", f.fn).updateMaterial("m 1", { price: 14500, description: "New" });
    expect(f.calls[0].url).toBe("https://api.housecallpro.com/api/price_book/materials/m%201");
    expect(f.calls[0].init.method).toBe("PUT");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer key-1");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ price: 14500, description: "New" });
  });

  it("POSTs a new material into its category and returns the uuid", async () => {
    const f = fakeFetch(() => ({ body: { uuid: "new-1", name: "Rheem XE50" } }));
    const res = await new HousecallPricebookWriter("key-1", f.fn).createMaterial("cat-1", { name: "Rheem XE50", price: 120000 });
    expect(res).toEqual({ uuid: "new-1" });
    expect(f.calls[0].url).toBe("https://api.housecallpro.com/api/price_book/materials?material_category_uuid=cat-1");
    expect(f.calls[0].init.method).toBe("POST");
  });

  it("finds one material by listing its category", async () => {
    const f = fakeFetch(() => ({
      body: {
        data: [
          { uuid: "a", name: "Other" },
          { uuid: "m1", name: "PEX tee", price: 250, cost: 90, material_category_name: "PEX" },
        ],
        total_pages_count: 1,
      },
    }));
    const m = await new HousecallPricebookWriter("key-1", f.fn).getMaterial("m1", "cat-1");
    expect(m).toMatchObject({ kind: "material", uuid: "m1", name: "PEX tee", priceCents: 250, costCents: 90, categoryUuid: "cat-1" });
    expect(new URL(f.calls[0].url).searchParams.get("material_category_uuid")).toBe("cat-1");
    expect(f.calls[0].init.method).toBe("GET");
  });

  it("returns null when the material isn't in its category any more", async () => {
    const f = fakeFetch(() => ({ body: { data: [], total_pages_count: 1 } }));
    expect(await new HousecallPricebookWriter("key-1", f.fn).getMaterial("gone", "cat-1")).toBeNull();
  });

  it("throws HcpWriteError with status and path only, never the body", async () => {
    const f = fakeFetch(() => ({ status: 403, body: { error: { message: "secret detail" } } }));
    const err = await new HousecallPricebookWriter("key-1", f.fn).updateMaterial("m1", { price: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(HcpWriteError);
    expect(err).toMatchObject({ status: 403, path: "/api/price_book/materials/{uuid}" });
    expect(String(err.message)).not.toContain("secret");
  });
});
```

Append to `src/lib/mcp/__tests__/pricebook.test.ts`, after the `describe("createPricebookLoader", …)` block. Reuse its `fakeClient()`, and check its category uuids first: use the uuid of the category that `m-c1a` is listed under in place of `c1a` below.

```ts
describe("createPricebookLoader includeCategoryUuid", () => {
  it("adds categoryUuid to materials only when asked", async () => {
    const plain = await createPricebookLoader(fakeClient())();
    expect(plain.items.find((i) => i.kind === "material")).not.toHaveProperty("categoryUuid");
    const withIds = await createPricebookLoader(fakeClient(), { includeCategoryUuid: true })();
    expect(withIds.items.find((i) => i.uuid === "m-c1a")?.categoryUuid).toBe("c1a");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/housecall/__tests__/pricebookWrite.test.ts src/lib/mcp/__tests__/pricebook.test.ts`
Expected: FAIL, because the module is missing and `categoryUuid` is undefined.

- [ ] **Step 3: Implement.** Create `src/lib/housecall/pricebookWrite.ts`:

```ts
// Housecall Pro price book WRITES, used only by the Trinity Price Book Editor
// (src/lib/mcp/pricebookEdit). The read client (./pricebook.ts) stays GET-only.
//
// Checked against housecall.v1.yaml (2026-11-21):
//   PUT  /api/price_book/materials/{uuid}   body: name, description, price, cost,
//        unit_of_measure, part_number, flat_rate_enabled, taxable (money in cents)
//   POST /api/price_book/materials?material_category_uuid=…   same body
//   There is no single-material GET (that path is PUT/DELETE only), so
//   getMaterial lists the category. Services have no write endpoint at all.
// This module never calls DELETE.
import { normalizeMaterial, type PricebookItem } from "@/lib/mcp/pricebook";
import type { HcpMaterial } from "./pricebook";

const BASE_URL = "https://api.housecallpro.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export type HcpMaterialFields = {
  name?: string;
  description?: string;
  price?: number;
  cost?: number;
  unit_of_measure?: string;
  part_number?: string;
  taxable?: boolean;
};

// Status and a templated path only: HCP error bodies are never forwarded.
export class HcpWriteError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string) {
    super(`Housecall Pro price book write failed (status ${status}) on ${path}`);
    this.name = "HcpWriteError";
    this.status = status;
    this.path = path;
  }
}

export class HousecallPricebookWriter {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey?: string, fetchImpl: typeof fetch = fetch) {
    const key = apiKey ?? process.env.HOUSECALL_API_KEY;
    if (!key) throw new Error("Missing env var: HOUSECALL_API_KEY");
    this.apiKey = key;
    this.fetchImpl = fetchImpl;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async updateMaterial(uuid: string, fields: HcpMaterialFields): Promise<void> {
    const path = "/api/price_book/materials/{uuid}";
    const res = await this.fetchImpl(`${BASE_URL}/api/price_book/materials/${encodeURIComponent(uuid)}`, {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new HcpWriteError(res.status, path);
  }

  async createMaterial(categoryUuid: string, fields: HcpMaterialFields & { name: string; price: number }): Promise<{ uuid: string }> {
    const path = "/api/price_book/materials";
    const qs = new URLSearchParams({ material_category_uuid: categoryUuid });
    const res = await this.fetchImpl(`${BASE_URL}${path}?${qs}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new HcpWriteError(res.status, path);
    const body = (await res.json().catch(() => null)) as { uuid?: unknown } | null;
    if (!body || typeof body.uuid !== "string") throw new HcpWriteError(502, path);
    return { uuid: body.uuid };
  }

  async getMaterial(uuid: string, categoryUuid: string): Promise<PricebookItem | null> {
    const path = "/api/price_book/materials";
    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE), material_category_uuid: categoryUuid });
      const res = await this.fetchImpl(`${BASE_URL}${path}?${qs}`, { method: "GET", headers: this.headers(false) });
      if (!res.ok) throw new HcpWriteError(res.status, path);
      const json = (await res.json()) as Record<string, unknown>;
      const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.materials) ? json.materials : [];
      const hit = (raw as HcpMaterial[]).find((m) => m.uuid === uuid);
      if (hit) return { ...normalizeMaterial(hit), categoryUuid };
      const total = typeof json.total_pages_count === "number" ? json.total_pages_count : undefined;
      if (total !== undefined ? page >= total : raw.length === 0) return null;
    }
    return null;
  }
}
```

In `src/lib/mcp/pricebook.ts`:
- Add `categoryUuid?: string;` to `PricebookItem`, after `taxable`.
- Add `includeCategoryUuid?: boolean` to the `createPricebookLoader` opts type.
- In `load()`, change the material mapping to:

```ts
      return res.items.map((m) => {
        const item = normalizeMaterial(m, c.name);
        return opts.includeCategoryUuid ? { ...item, categoryUuid: c.uuid } : item;
      });
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/housecall src/lib/mcp`
Expected: PASS, including the existing "never writes" check in `src/lib/housecall/__tests__/pricebook.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/housecall src/lib/mcp/pricebook.ts src/lib/mcp/__tests__/pricebook.test.ts
git commit -m "feat(pricebook): HCP material write client and category uuid for the editor's loader"
```

---

### Task 2: Migration, types, store and test fakes

**Files:**
- Create:
  - `supabase/migrations/0009_pricebook_changes.sql`
  - `src/lib/pricebook/edit/types.ts`
  - `src/lib/pricebook/edit/store.ts`
  - `src/lib/pricebook/edit/__tests__/store.test.ts`
  - `src/lib/pricebook/edit/__tests__/fakes.ts`

**Interfaces produced (`types.ts`):**
```ts
export type FieldValues = { name?: string; description?: string; priceCents?: number; costCents?: number; unit?: string; partNumber?: string; taxable?: boolean };
export type ChangeKind = "material_update" | "material_create" | "service_request" | "undo";
export type ChangeStatus = "applied" | "failed" | "undone" | "pending" | "done" | "dismissed";
export type ChangeRow = { id: number; batchId: string; kind: ChangeKind; itemUuid: string; itemName: string; itemKind: "material" | "service"; categoryUuid: string | null; before: FieldValues | null; after: FieldValues; status: ChangeStatus; requestedBy: string; resolvedBy: string | null; errorCode: string | null; slackChannelId: string | null; slackMessageTs: string | null; createdAt: string; resolvedAt: string | null };
export type NewChange = Pick<ChangeRow, "batchId" | "kind" | "itemUuid" | "itemName" | "itemKind" | "categoryUuid" | "before" | "after" | "status" | "requestedBy" | "errorCode">;
export type PlannedChange = { uuid: string; name: string; category: string | null; categoryUuid: string | null; before: FieldValues; after: FieldValues };
export type PreviewRow = { id: string; createdBy: string; payload: PlannedChange[]; expiresAt: string; appliedAt: string | null };
export interface PricebookEditStore {
  insertChanges(rows: NewChange[]): Promise<ChangeRow[]>;
  getChange(id: number): Promise<ChangeRow | null>;
  listBatch(batchId: string): Promise<ChangeRow[]>;
  listRecent(sinceIso: string, limit: number): Promise<ChangeRow[]>;
  listPendingServices(): Promise<ChangeRow[]>;
  setStatus(ids: number[], status: ChangeStatus, opts?: { resolvedBy?: string | null; resolvedAt?: string | null; errorCode?: string | null }): Promise<void>;
  updateAfter(id: number, after: FieldValues): Promise<void>;
  setSlackMessage(batchId: string, channelId: string, ts: string): Promise<void>;
  createPreview(p: Omit<PreviewRow, "appliedAt">): Promise<void>;
  getPreview(id: string): Promise<PreviewRow | null>;
  /** Atomically marks the preview applied when unexpired, unapplied and owned by `by`; returns it, else null. */
  claimPreview(id: string, by: string, nowIso: string): Promise<PreviewRow | null>;
}
```

- [ ] **Step 1: Write the migration** `supabase/migrations/0009_pricebook_changes.sql`:

```sql
-- supabase/migrations/0009_pricebook_changes.sql
--
-- The Trinity Price Book Editor's change log and short-lived previews.
-- Materials are changed in HCP directly (status applied / failed / undone);
-- services can't be written through HCP's API, so their changes are requests
-- (pending / done / dismissed) posted to Slack and applied by hand.
-- before/after hold only the fields that changed, money in integer cents.
create table pricebook_changes (
  id               bigint generated always as identity primary key,
  batch_id         uuid not null,
  kind             text not null check (kind in ('material_update', 'material_create', 'service_request', 'undo')),
  item_uuid        text not null,
  item_name        text not null,
  item_kind        text not null check (item_kind in ('material', 'service')),
  category_uuid    text,
  before           jsonb,
  after            jsonb not null,
  status           text not null check (status in ('applied', 'failed', 'undone', 'pending', 'done', 'dismissed')),
  requested_by     text not null,          -- Supabase user id of the editor
  resolved_by      text,                   -- Supabase or Slack user id
  error_code       text,
  slack_channel_id text,
  slack_message_ts text,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);

create index pricebook_changes_batch_idx on pricebook_changes (batch_id);
create index pricebook_changes_created_idx on pricebook_changes (created_at desc);
create index pricebook_changes_pending_idx on pricebook_changes (item_uuid) where status = 'pending';

create table pricebook_previews (
  id                 uuid primary key,
  created_by_user_id text not null,
  payload            jsonb not null,
  expires_at         timestamptz not null,
  applied_at         timestamptz,
  created_at         timestamptz not null default now()
);

-- Server-only, through the service-role key. RLS with no policies keeps the anon key out.
alter table pricebook_changes enable row level security;
alter table pricebook_previews enable row level security;
```

`batch_id` is `uuid`. Live ids come from `crypto.randomUUID()`. The test fakes use `id-N` strings, which never reach Postgres.

- [ ] **Step 2: Write `types.ts`** with exactly the Interfaces block above, plus a one-line header comment.

- [ ] **Step 3: Write the failing store test** `src/lib/pricebook/edit/__tests__/store.test.ts`. Copy the `fakeDb` function **verbatim** from `src/lib/tasks/__tests__/store.test.ts` into the top of this file, then add:

```ts
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabasePricebookEditStore } from "../store";

// fakeDb(...) — copied verbatim from src/lib/tasks/__tests__/store.test.ts

const ROW = {
  id: 3, batch_id: "b1", kind: "material_update", item_uuid: "m1", item_name: "PEX tee", item_kind: "material",
  category_uuid: "c1", before: { priceCents: 250 }, after: { priceCents: 275 }, status: "applied",
  requested_by: "u-dave", resolved_by: null, error_code: null, slack_channel_id: null, slack_message_ts: null,
  created_at: "2026-11-21T15:00:00+00:00", resolved_at: null,
};

describe("supabasePricebookEditStore", () => {
  it("inserts snake_case rows and maps the result back", async () => {
    const { db, calls } = fakeDb({ data: [ROW] });
    const out = await supabasePricebookEditStore(db).insertChanges([
      { batchId: "b1", kind: "material_update", itemUuid: "m1", itemName: "PEX tee", itemKind: "material", categoryUuid: "c1",
        before: { priceCents: 250 }, after: { priceCents: 275 }, status: "applied", requestedBy: "u-dave", errorCode: null },
    ]);
    expect(calls[0].table).toBe("pricebook_changes");
    expect(calls[0].ops[0][0]).toBe("insert");
    expect((calls[0].ops[0][1][0] as Array<Record<string, unknown>>)[0]).toMatchObject({ batch_id: "b1", item_uuid: "m1", requested_by: "u-dave" });
    expect(out[0]).toMatchObject({ id: 3, batchId: "b1", itemKind: "material", before: { priceCents: 250 }, requestedBy: "u-dave" });
  });

  it("claims a preview only when unapplied, unexpired and owned by the caller", async () => {
    const { db, calls } = fakeDb({ data: [{ id: "p1", created_by_user_id: "u-dave", payload: [], expires_at: "2026-11-21T15:15:00Z", applied_at: "2026-11-21T15:01:00Z" }] });
    const row = await supabasePricebookEditStore(db).claimPreview("p1", "u-dave", "2026-11-21T15:01:00Z");
    expect(row).toMatchObject({ id: "p1", createdBy: "u-dave" });
    expect(calls[0].ops).toEqual(expect.arrayContaining([
      ["eq", ["id", "p1"]], ["is", ["applied_at", null]], ["eq", ["created_by_user_id", "u-dave"]], ["gt", ["expires_at", "2026-11-21T15:01:00Z"]],
    ]));
  });

  it("returns null when the claim matched nothing", async () => {
    const { db } = fakeDb({ data: [] });
    expect(await supabasePricebookEditStore(db).claimPreview("p1", "u-dave", "2026-11-21T15:01:00Z")).toBeNull();
  });

  it("lists pending service requests", async () => {
    const { db, calls } = fakeDb({ data: [] });
    await supabasePricebookEditStore(db).listPendingServices();
    expect(calls[0].ops).toEqual(expect.arrayContaining([["eq", ["kind", "service_request"]], ["eq", ["status", "pending"]]]));
  });

  it("throws with the operation name on error", async () => {
    const { db } = fakeDb({ error: { message: "denied" } });
    await expect(supabasePricebookEditStore(db).listBatch("b1")).rejects.toThrow("[pricebook] listBatch failed: denied");
  });
});
```

- [ ] **Step 4: Run it and confirm it fails** (module missing): `npx vitest run src/lib/pricebook`.

- [ ] **Step 5: Implement `store.ts`:**

```ts
// The editor's change log and previews (migration 0009). Server-only.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChangeRow, ChangeStatus, FieldValues, NewChange, PreviewRow, PricebookEditStore } from "./types";

const CHANGE_COLS =
  "id, batch_id, kind, item_uuid, item_name, item_kind, category_uuid, before, after, status, requested_by, resolved_by, error_code, slack_channel_id, slack_message_ts, created_at, resolved_at";
const PREVIEW_COLS = "id, created_by_user_id, payload, expires_at, applied_at";

function check(op: string, error: { message: string } | null): void {
  if (error) throw new Error(`[pricebook] ${op} failed: ${error.message}`);
}

function toChange(r: Record<string, unknown>): ChangeRow {
  return {
    id: Number(r.id),
    batchId: String(r.batch_id),
    kind: r.kind as ChangeRow["kind"],
    itemUuid: String(r.item_uuid),
    itemName: String(r.item_name),
    itemKind: r.item_kind as ChangeRow["itemKind"],
    categoryUuid: (r.category_uuid as string | null) ?? null,
    before: (r.before as FieldValues | null) ?? null,
    after: (r.after as FieldValues) ?? {},
    status: r.status as ChangeStatus,
    requestedBy: String(r.requested_by),
    resolvedBy: (r.resolved_by as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    slackChannelId: (r.slack_channel_id as string | null) ?? null,
    slackMessageTs: (r.slack_message_ts as string | null) ?? null,
    createdAt: String(r.created_at),
    resolvedAt: (r.resolved_at as string | null) ?? null,
  };
}

function toPreview(r: Record<string, unknown>): PreviewRow {
  return {
    id: String(r.id),
    createdBy: String(r.created_by_user_id),
    payload: (r.payload as PreviewRow["payload"]) ?? [],
    expiresAt: String(r.expires_at),
    appliedAt: (r.applied_at as string | null) ?? null,
  };
}

const rows = (data: unknown) => (data ?? []) as Record<string, unknown>[];

export function supabasePricebookEditStore(db: SupabaseClient): PricebookEditStore {
  return {
    async insertChanges(input: NewChange[]) {
      if (input.length === 0) return [];
      const { data, error } = await db
        .from("pricebook_changes")
        .insert(
          input.map((c) => ({
            batch_id: c.batchId,
            kind: c.kind,
            item_uuid: c.itemUuid,
            item_name: c.itemName,
            item_kind: c.itemKind,
            category_uuid: c.categoryUuid,
            before: c.before,
            after: c.after,
            status: c.status,
            requested_by: c.requestedBy,
            error_code: c.errorCode,
          }))
        )
        .select(CHANGE_COLS);
      check("insertChanges", error);
      return rows(data).map(toChange);
    },
    async getChange(id) {
      const { data, error } = await db.from("pricebook_changes").select(CHANGE_COLS).eq("id", id).maybeSingle();
      check("getChange", error);
      return data ? toChange(data as Record<string, unknown>) : null;
    },
    async listBatch(batchId) {
      const { data, error } = await db.from("pricebook_changes").select(CHANGE_COLS).eq("batch_id", batchId).order("id");
      check("listBatch", error);
      return rows(data).map(toChange);
    },
    async listRecent(sinceIso, limit) {
      const { data, error } = await db
        .from("pricebook_changes")
        .select(CHANGE_COLS)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(limit);
      check("listRecent", error);
      return rows(data).map(toChange);
    },
    async listPendingServices() {
      const { data, error } = await db
        .from("pricebook_changes")
        .select(CHANGE_COLS)
        .eq("kind", "service_request")
        .eq("status", "pending")
        .order("id");
      check("listPendingServices", error);
      return rows(data).map(toChange);
    },
    async setStatus(ids, status, opts = {}) {
      if (ids.length === 0) return;
      const { error } = await db
        .from("pricebook_changes")
        .update({
          status,
          resolved_by: opts.resolvedBy ?? null,
          resolved_at: opts.resolvedAt ?? null,
          ...(opts.errorCode !== undefined ? { error_code: opts.errorCode } : {}),
        })
        .in("id", ids);
      check("setStatus", error);
    },
    async updateAfter(id, after) {
      const { error } = await db.from("pricebook_changes").update({ after }).eq("id", id);
      check("updateAfter", error);
    },
    async setSlackMessage(batchId, channelId, ts) {
      const { error } = await db.from("pricebook_changes").update({ slack_channel_id: channelId, slack_message_ts: ts }).eq("batch_id", batchId);
      check("setSlackMessage", error);
    },
    async createPreview(p) {
      const { error } = await db
        .from("pricebook_previews")
        .insert({ id: p.id, created_by_user_id: p.createdBy, payload: p.payload, expires_at: p.expiresAt });
      check("createPreview", error);
    },
    async getPreview(id) {
      const { data, error } = await db.from("pricebook_previews").select(PREVIEW_COLS).eq("id", id).maybeSingle();
      check("getPreview", error);
      return data ? toPreview(data as Record<string, unknown>) : null;
    },
    async claimPreview(id, by, nowIso) {
      const { data, error } = await db
        .from("pricebook_previews")
        .update({ applied_at: nowIso })
        .eq("id", id)
        .is("applied_at", null)
        .eq("created_by_user_id", by)
        .gt("expires_at", nowIso)
        .select(PREVIEW_COLS);
      check("claimPreview", error);
      const r = rows(data);
      return r.length === 1 ? toPreview(r[0]) : null;
    },
  };
}
```

- [ ] **Step 6: Write `__tests__/fakes.ts`.** Later tasks import these:

```ts
// Test doubles for the price book editor.
import type { PricebookItem } from "@/lib/mcp/pricebook";
import { HcpWriteError, type HcpMaterialFields } from "@/lib/housecall/pricebookWrite";
import type { ChangeRow, NewChange, PreviewRow, PricebookEditStore } from "../types";

// 10:00 AM Eastern, Sat Nov 21 2026.
export const NOW = new Date("2026-11-21T15:00:00.000Z");
export const DAVE = "u-dave";
export const ELLA = "u-ella";

export function item(over: Partial<PricebookItem> & { uuid: string }): PricebookItem {
  return {
    kind: "material", name: "PEX tee", category: "PEX", categoryUuid: "c-pex", description: "1/2 inch PEX brass tee fitting",
    priceCents: 250, costCents: 90, unit: "each", partNumber: "PX-T12", updatedAt: null, taxable: true, ...over,
  };
}

export function memoryStore(now: () => Date = () => NOW) {
  const changes: ChangeRow[] = [];
  const previews = new Map<string, PreviewRow>();
  let nextId = 1;
  const store: PricebookEditStore = {
    async insertChanges(input: NewChange[]) {
      const out = input.map((c) => ({ ...c, id: nextId++, resolvedBy: null, slackChannelId: null, slackMessageTs: null, createdAt: now().toISOString(), resolvedAt: null }));
      changes.push(...out);
      return out.map((r) => ({ ...r }));
    },
    async getChange(id) { const r = changes.find((c) => c.id === id); return r ? { ...r } : null; },
    async listBatch(b) { return changes.filter((c) => c.batchId === b).map((c) => ({ ...c })); },
    async listRecent(since, limit) { return changes.filter((c) => c.createdAt >= since).slice().reverse().slice(0, limit).map((c) => ({ ...c })); },
    async listPendingServices() { return changes.filter((c) => c.kind === "service_request" && c.status === "pending").map((c) => ({ ...c })); },
    async setStatus(ids, status, opts = {}) {
      for (const c of changes) if (ids.includes(c.id)) {
        c.status = status; c.resolvedBy = opts.resolvedBy ?? null; c.resolvedAt = opts.resolvedAt ?? null;
        if (opts.errorCode !== undefined) c.errorCode = opts.errorCode;
      }
    },
    async updateAfter(id, after) { const c = changes.find((x) => x.id === id); if (c) c.after = after; },
    async setSlackMessage(b, ch, ts) { for (const c of changes) if (c.batchId === b) { c.slackChannelId = ch; c.slackMessageTs = ts; } },
    async createPreview(p) { previews.set(p.id, { ...p, appliedAt: null }); },
    async getPreview(id) { const p = previews.get(id); return p ? { ...p } : null; },
    async claimPreview(id, by, nowIso) {
      const p = previews.get(id);
      if (!p || p.appliedAt || p.createdBy !== by || p.expiresAt <= nowIso) return null;
      p.appliedAt = nowIso;
      return { ...p };
    },
  };
  return { store, changes, previews };
}

/** HCP with materials in memory; services are read-only like the real API. */
export function fakeWriter(initial: PricebookItem[]) {
  const items = new Map(initial.map((i) => [i.uuid, { ...i }]));
  const updates: Array<[string, HcpMaterialFields]> = [];
  const created: Array<[string, HcpMaterialFields]> = [];
  let failStatus: number | null = null;
  let failOnUuid: string | null = null;
  let n = 0;
  const writer = {
    async updateMaterial(uuid: string, f: HcpMaterialFields) {
      if (failStatus && (!failOnUuid || failOnUuid === uuid)) throw new HcpWriteError(failStatus, "/api/price_book/materials/{uuid}");
      const it = items.get(uuid);
      if (!it || it.kind !== "material") throw new HcpWriteError(404, "/api/price_book/materials/{uuid}");
      updates.push([uuid, f]);
      if (f.name !== undefined) it.name = f.name;
      if (f.description !== undefined) it.description = f.description;
      if (f.price !== undefined) it.priceCents = f.price;
      if (f.cost !== undefined) it.costCents = f.cost;
      if (f.unit_of_measure !== undefined) it.unit = f.unit_of_measure;
      if (f.part_number !== undefined) it.partNumber = f.part_number;
      if (f.taxable !== undefined) it.taxable = f.taxable;
    },
    async createMaterial(categoryUuid: string, f: HcpMaterialFields & { name: string; price: number }) {
      if (failStatus) throw new HcpWriteError(failStatus, "/api/price_book/materials");
      const uuid = `new-${++n}`;
      items.set(uuid, item({ uuid, name: f.name, priceCents: f.price, costCents: f.cost ?? null, description: f.description ?? "", categoryUuid, category: null }));
      created.push([categoryUuid, f]);
      return { uuid };
    },
    async getMaterial(uuid: string, _categoryUuid: string) {
      const it = items.get(uuid);
      return it && it.kind === "material" ? { ...it } : null;
    },
  };
  return {
    writer, items, updates, created,
    all: () => Array.from(items.values()).map((i) => ({ ...i })),
    /** Every write (or only writes to `uuid`) fails with this status; null clears it. */
    failWith(status: number | null, uuid: string | null = null) { failStatus = status; failOnUuid = uuid; },
  };
}

export function fakeSlack() {
  const posts: Array<{ channel: string; text: string; blocks: unknown[] }> = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  const replies: Array<{ channel: string; threadTs: string; text: string }> = [];
  let n = 0;
  return {
    posts, updates, replies,
    port: {
      async post(channel: string, text: string, blocks: unknown[]) { posts.push({ channel, text, blocks }); return `900.${++n}`; },
      async update(channel: string, ts: string, text: string, blocks: unknown[]) { updates.push({ channel, ts, text, blocks }); },
      async reply(channel: string, threadTs: string, text: string) { replies.push({ channel, threadTs, text }); },
    },
    lastBlocks(): unknown[] { const all = [...posts, ...updates]; return all.length ? all[all.length - 1].blocks : []; },
  };
}

export function ids() { let n = 0; return () => `id-${++n}`; }
```

If lint flags the unused `_categoryUuid`, use the repo's existing convention for unused parameters (check `.eslintrc`); otherwise drop the parameter, since TypeScript allows fewer parameters.

- [ ] **Step 7: Run the tests and typecheck.** `npx vitest run src/lib/pricebook` should PASS, and `npx tsc --noEmit` should show only the baseline errors.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/0009_pricebook_changes.sql src/lib/pricebook
git commit -m "feat(pricebook): change log and preview tables, store and test fakes"
```

---

### Task 3: Preview and guardrails (pure)

**Files:**
- Create: `src/lib/pricebook/edit/changes.ts`, `src/lib/pricebook/edit/__tests__/changes.test.ts`

**Interfaces produced:**
```ts
export type Money = number | string;
export type MaterialEdit = { uuid: string; price?: Money; cost?: Money; description?: string; name?: string; partNumber?: string; unit?: string; taxable?: boolean };
export type RuleEdit = { match: { query?: string; category?: string }; pricePercent?: number; costPercent?: number; round?: "cent" | "dollar" | "99" };
export type PreviewRequest = { items?: MaterialEdit[]; rule?: RuleEdit; allowBelowCost?: boolean };
export type Issue = { uuid: string | null; name: string | null; code: string; message: string };
export type Preview = { changes: PlannedChange[]; warnings: Issue[]; blocks: Issue[] };
export const MAX_ITEMS = 50, BIG_CHANGE = 0.25, SHORT_DESCRIPTION = 20;
export function parseMoney(v: Money): number | null;
export function applyPercent(cents: number, pct: number, round?: "cent" | "dollar" | "99"): number;
export function buildPreview(req: PreviewRequest, items: PricebookItem[]): Preview;
export function itemValues(item: PricebookItem): FieldValues;
export function fieldsDiffer(item: PricebookItem, values: FieldValues): boolean;
export function toHcpFields(v: FieldValues): HcpMaterialFields;
export function priceCheck(name: string, uuid: string, priceCents: number | null, costCents: number | null, allowBelowCost: boolean): Issue | null;
export function describeChange(before: FieldValues | null, after: FieldValues): string;
```

- [ ] **Step 1: Write the failing test** `src/lib/pricebook/edit/__tests__/changes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyPercent, buildPreview, describeChange, fieldsDiffer, parseMoney, toHcpFields, MAX_ITEMS } from "../changes";
import { item } from "./fakes";

const TEE = item({ uuid: "m1" });                                       // $2.50 / cost $0.90
const ELBOW = item({ uuid: "m2", name: "PEX elbow", priceCents: 300, costCents: 100 });
const NAVIEN = item({ uuid: "m3", name: "Navien NPE-240A", category: "Navien", categoryUuid: "c-nav", priceCents: 250000, costCents: 180000 });
const DRAIN = item({ uuid: "s1", kind: "service", name: "Drain cleaning", category: "Drains", categoryUuid: undefined, priceCents: 17500, costCents: null });
const BOOK = [TEE, ELBOW, NAVIEN, DRAIN];

describe("parseMoney / applyPercent", () => {
  it("parses dollars into cents", () => {
    expect(parseMoney(145)).toBe(14500);
    expect(parseMoney("145")).toBe(14500);
    expect(parseMoney("$1,145.50")).toBe(114550);
    expect(parseMoney("abc")).toBeNull();
  });
  it("rounds percentage results", () => {
    expect(applyPercent(250000, 8)).toBe(270000);
    expect(applyPercent(1999, 10, "dollar")).toBe(2200);
    expect(applyPercent(1999, 10, "99")).toBe(2199);
  });
});

describe("buildPreview", () => {
  it("plans per-item changes with only the changed fields", () => {
    const p = buildPreview({ items: [{ uuid: "m1", price: "2.75", description: "1/2 inch PEX brass tee, lead-free" }] }, BOOK);
    expect(p.blocks).toEqual([]);
    expect(p.changes).toEqual([{
      uuid: "m1", name: "PEX tee", category: "PEX", categoryUuid: "c-pex",
      before: { priceCents: 250, description: "1/2 inch PEX brass tee fitting" },
      after: { priceCents: 275, description: "1/2 inch PEX brass tee, lead-free" },
    }]);
  });

  it("applies a percentage rule to matching materials only", () => {
    const p = buildPreview({ rule: { match: { category: "navien" }, pricePercent: 8 } }, BOOK);
    expect(p.changes.map((c) => [c.uuid, c.after.priceCents])).toEqual([["m3", 270000]]);
  });

  it("blocks a price below cost unless allowed", () => {
    expect(buildPreview({ items: [{ uuid: "m1", price: 0.5 }] }, BOOK).blocks.map((b) => b.code)).toEqual(["below_cost"]);
    expect(buildPreview({ items: [{ uuid: "m1", price: 0.5 }], allowBelowCost: true }, BOOK).blocks).toEqual([]);
  });

  it("blocks zero prices, unknown ids, services and duplicates", () => {
    const p = buildPreview({ items: [{ uuid: "m1", price: 0 }, { uuid: "nope", price: 1 }, { uuid: "s1", price: 200 }, { uuid: "m2", price: 4 }, { uuid: "m2", price: 5 }] }, BOOK);
    expect(p.blocks.map((b) => b.code).sort()).toEqual(["duplicate_item", "price_not_positive", "service_not_editable", "unknown_item"]);
  });

  it(`blocks more than ${MAX_ITEMS} items`, () => {
    const many = Array.from({ length: 51 }, (_, i) => item({ uuid: `x${i}`, name: `Part ${i}` }));
    const p = buildPreview({ rule: { match: { category: "PEX" }, pricePercent: 1 } }, many);
    expect(p.blocks.map((b) => b.code)).toEqual(["too_many"]);
  });

  it("warns on big changes, short descriptions, duplicate names and no-ops", () => {
    const p = buildPreview({ items: [{ uuid: "m1", price: 5 }, { uuid: "m2", description: "short", name: "PEX tee" }, { uuid: "m3", price: 2500 }] }, BOOK);
    expect(p.warnings.map((w) => w.code).sort()).toEqual(["big_change", "duplicate_name", "no_change", "short_description"]);
    expect(p.changes.map((c) => c.uuid)).toEqual(["m1", "m2"]);
  });
});

describe("helpers", () => {
  it("fieldsDiffer compares only the given keys", () => {
    expect(fieldsDiffer(TEE, { priceCents: 250 })).toBe(false);
    expect(fieldsDiffer(TEE, { priceCents: 275 })).toBe(true);
  });
  it("toHcpFields maps to HCP names", () => {
    expect(toHcpFields({ priceCents: 275, costCents: 90, unit: "each", partNumber: "X", name: "n", description: "d", taxable: false }))
      .toEqual({ price: 275, cost: 90, unit_of_measure: "each", part_number: "X", name: "n", description: "d", taxable: false });
  });
  it("describes a change in plain words", () => {
    expect(describeChange({ priceCents: 250 }, { priceCents: 275, description: "x" })).toBe("price $2.50 → $2.75; description changed");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails** (module missing).

- [ ] **Step 3: Implement `changes.ts`:**

```ts
// Turning a request into an exact list of planned material changes, plus
// warnings (allowed, shown) and blocks (refused). Pure: no I/O.
import type { HcpMaterialFields } from "@/lib/housecall/pricebookWrite";
import { formatMoney, type PricebookItem } from "@/lib/mcp/pricebook";
import type { FieldValues, PlannedChange } from "./types";

export type Money = number | string;
export type MaterialEdit = { uuid: string; price?: Money; cost?: Money; description?: string; name?: string; partNumber?: string; unit?: string; taxable?: boolean };
export type RuleEdit = { match: { query?: string; category?: string }; pricePercent?: number; costPercent?: number; round?: "cent" | "dollar" | "99" };
export type PreviewRequest = { items?: MaterialEdit[]; rule?: RuleEdit; allowBelowCost?: boolean };
export type Issue = { uuid: string | null; name: string | null; code: string; message: string };
export type Preview = { changes: PlannedChange[]; warnings: Issue[]; blocks: Issue[] };

export const MAX_ITEMS = 50;
export const BIG_CHANGE = 0.25;
export const SHORT_DESCRIPTION = 20;

export function parseMoney(v: Money): number | null {
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function applyPercent(cents: number, pct: number, round: "cent" | "dollar" | "99" = "cent"): number {
  const raw = cents * (1 + pct / 100);
  if (round === "dollar") return Math.round(raw / 100) * 100;
  if (round === "99") return Math.max(99, Math.round(raw / 100) * 100 - 1);
  return Math.round(raw);
}

export function itemValues(i: PricebookItem): FieldValues {
  return {
    name: i.name,
    description: i.description,
    ...(i.priceCents !== null ? { priceCents: i.priceCents } : {}),
    ...(i.costCents !== null ? { costCents: i.costCents } : {}),
    ...(i.unit !== null ? { unit: i.unit } : {}),
    ...(i.partNumber !== null ? { partNumber: i.partNumber } : {}),
    ...(i.taxable !== null ? { taxable: i.taxable } : {}),
  };
}

const KEYS: Array<keyof FieldValues> = ["name", "description", "priceCents", "costCents", "unit", "partNumber", "taxable"];

export function fieldsDiffer(i: PricebookItem, values: FieldValues): boolean {
  const cur = itemValues(i);
  return KEYS.some((k) => values[k] !== undefined && values[k] !== cur[k]);
}

export function toHcpFields(v: FieldValues): HcpMaterialFields {
  const f: HcpMaterialFields = {};
  if (v.name !== undefined) f.name = v.name;
  if (v.description !== undefined) f.description = v.description;
  if (v.priceCents !== undefined) f.price = v.priceCents;
  if (v.costCents !== undefined) f.cost = v.costCents;
  if (v.unit !== undefined) f.unit_of_measure = v.unit;
  if (v.partNumber !== undefined) f.part_number = v.partNumber;
  if (v.taxable !== undefined) f.taxable = v.taxable;
  return f;
}

export function describeChange(before: FieldValues | null, after: FieldValues): string {
  const parts: string[] = [];
  if (after.priceCents !== undefined) parts.push(`price ${before?.priceCents !== undefined ? formatMoney(before.priceCents) : "new"} → ${formatMoney(after.priceCents)}`);
  if (after.costCents !== undefined) parts.push(`cost ${before?.costCents !== undefined ? formatMoney(before.costCents) : "new"} → ${formatMoney(after.costCents)}`);
  if (after.name !== undefined) parts.push(`name → "${after.name}"`);
  if (after.description !== undefined) parts.push("description changed");
  if (after.unit !== undefined) parts.push(`unit → ${after.unit}`);
  if (after.partNumber !== undefined) parts.push(`part number → ${after.partNumber}`);
  if (after.taxable !== undefined) parts.push(after.taxable ? "taxable" : "not taxable");
  return parts.join("; ");
}

export function priceCheck(name: string, uuid: string, priceCents: number | null, costCents: number | null, allowBelowCost: boolean): Issue | null {
  if (priceCents !== null && priceCents <= 0) return { uuid, name, code: "price_not_positive", message: `${name}: the price must be more than $0.00.` };
  if (!allowBelowCost && priceCents !== null && costCents !== null && priceCents < costCents) {
    return { uuid, name, code: "below_cost", message: `${name}: ${formatMoney(priceCents)} is below its cost of ${formatMoney(costCents)}. Ask again with allowBelowCost if that's intended.` };
  }
  return null;
}

const norm = (s: string) => s.trim().toLowerCase();

export function buildPreview(req: PreviewRequest, items: PricebookItem[]): Preview {
  const byUuid = new Map(items.map((i) => [i.uuid, i]));
  const warnings: Issue[] = [];
  const blocks: Issue[] = [];
  const edits: MaterialEdit[] = [];

  for (const e of req.items ?? []) edits.push(e);
  if (req.rule) {
    const { query, category } = req.rule.match;
    for (const i of items) {
      if (i.kind !== "material") continue;
      if (category && norm(i.category ?? "") !== norm(category)) continue;
      if (query && ![i.name, i.category ?? "", i.partNumber ?? ""].some((s) => norm(s).includes(norm(query)))) continue;
      const e: MaterialEdit = { uuid: i.uuid };
      if (req.rule.pricePercent !== undefined && i.priceCents !== null) e.price = applyPercent(i.priceCents, req.rule.pricePercent, req.rule.round) / 100;
      if (req.rule.costPercent !== undefined && i.costCents !== null) e.cost = applyPercent(i.costCents, req.rule.costPercent, req.rule.round) / 100;
      edits.push(e);
    }
  }

  if (edits.length > MAX_ITEMS) {
    return { changes: [], warnings: [], blocks: [{ uuid: null, name: null, code: "too_many", message: `That's ${edits.length} items; the limit is ${MAX_ITEMS} per change. Narrow it down.` }] };
  }

  const seen = new Set<string>();
  const changes: PlannedChange[] = [];
  for (const e of edits) {
    const it = byUuid.get(e.uuid);
    if (!it) { blocks.push({ uuid: e.uuid, name: null, code: "unknown_item", message: `No price book item has id ${e.uuid}.` }); continue; }
    if (it.kind === "service") { blocks.push({ uuid: it.uuid, name: it.name, code: "service_not_editable", message: `${it.name} is a service. HCP's API can't change services; use request_service_changes.` }); continue; }
    if (seen.has(e.uuid)) { blocks.push({ uuid: it.uuid, name: it.name, code: "duplicate_item", message: `${it.name} is in the request twice.` }); continue; }
    seen.add(e.uuid);

    const cur = itemValues(it);
    const want: FieldValues = {};
    if (e.price !== undefined) { const c = parseMoney(e.price); if (c === null) { blocks.push({ uuid: it.uuid, name: it.name, code: "bad_money", message: `${it.name}: "${e.price}" isn't a price.` }); continue; } want.priceCents = c; }
    if (e.cost !== undefined) { const c = parseMoney(e.cost); if (c === null) { blocks.push({ uuid: it.uuid, name: it.name, code: "bad_money", message: `${it.name}: "${e.cost}" isn't a cost.` }); continue; } want.costCents = c; }
    if (e.name !== undefined) want.name = e.name.trim();
    if (e.description !== undefined) want.description = e.description.trim();
    if (e.unit !== undefined) want.unit = e.unit.trim();
    if (e.partNumber !== undefined) want.partNumber = e.partNumber.trim();
    if (e.taxable !== undefined) want.taxable = e.taxable;

    const before: FieldValues = {};
    const after: FieldValues = {};
    for (const k of KEYS) {
      if (want[k] !== undefined && want[k] !== cur[k]) {
        (after as Record<string, unknown>)[k] = want[k];
        if (cur[k] !== undefined) (before as Record<string, unknown>)[k] = cur[k];
      }
    }
    if (Object.keys(after).length === 0) { warnings.push({ uuid: it.uuid, name: it.name, code: "no_change", message: `${it.name} already has those values; skipped.` }); continue; }

    const bad = priceCheck(it.name, it.uuid, after.priceCents ?? it.priceCents, after.costCents ?? it.costCents, Boolean(req.allowBelowCost));
    if (bad) { blocks.push(bad); continue; }

    if (after.priceCents !== undefined && it.priceCents) {
      const delta = Math.abs(after.priceCents - it.priceCents) / it.priceCents;
      if (delta > BIG_CHANGE) warnings.push({ uuid: it.uuid, name: it.name, code: "big_change", message: `${it.name}: price moves ${Math.round(delta * 100)}% (${formatMoney(it.priceCents)} → ${formatMoney(after.priceCents)}).` });
    }
    const desc = after.description ?? it.description;
    if (desc.trim().length < SHORT_DESCRIPTION) warnings.push({ uuid: it.uuid, name: it.name, code: "short_description", message: `${it.name}: the description is ${desc.trim() ? "very short" : "missing"}.` });
    const newName = after.name;
    if (newName !== undefined && items.some((o) => o.uuid !== it.uuid && o.kind === it.kind && norm(o.name) === norm(newName))) {
      warnings.push({ uuid: it.uuid, name: it.name, code: "duplicate_name", message: `Another material is already called "${newName}".` });
    }
    changes.push({ uuid: it.uuid, name: it.name, category: it.category, categoryUuid: it.categoryUuid ?? null, before, after });
  }
  return { changes, warnings, blocks };
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** `npx vitest run src/lib/pricebook`

- [ ] **Step 5: Commit**

```bash
git add src/lib/pricebook/edit/changes.ts src/lib/pricebook/edit/__tests__/changes.test.ts
git commit -m "feat(pricebook): preview builder and guardrails for material changes"
```

---

### Task 4: Preview, apply, add, write check and undo

**Files:**
- Create:
  - `src/lib/pricebook/edit/apply.ts`
  - `src/lib/pricebook/edit/undo.ts`
  - `src/lib/pricebook/edit/__tests__/apply.test.ts`
  - `src/lib/pricebook/edit/__tests__/undo.test.ts`

**Interfaces produced:**
```ts
// apply.ts
export interface MaterialWriter { updateMaterial(uuid: string, f: HcpMaterialFields): Promise<void>; createMaterial(categoryUuid: string, f: HcpMaterialFields & { name: string; price: number }): Promise<{ uuid: string }>; getMaterial(uuid: string, categoryUuid: string): Promise<PricebookItem | null> }
export type EditDeps = { store: PricebookEditStore; writer: MaterialWriter; loadItems(): Promise<PricebookItem[]>; now(): Date; newId(): string };
export class EditError extends Error { readonly code: string }   // preview_not_found | preview_other_editor | preview_expired | preview_already_applied | key_cannot_write | no_materials | change_not_found
export const PREVIEW_TTL_MS = 15 * 60_000;
export async function createPreview(deps, req: PreviewRequest, editorId: string): Promise<Preview & { previewId: string | null; expiresAt: string | null }>;
export type ApplyResult = { batchId: string; applied: Array<{ uuid: string; name: string; change: string }>; failed: Array<{ uuid: string; name: string; code: string }>; skipped: Array<{ uuid: string; name: string; code: string; current: FieldValues | null }> };
export async function applyPreview(deps, previewId: string, editorId: string): Promise<ApplyResult>;
export type NewMaterial = { categoryUuid: string; name: string; price: Money; cost?: Money; description?: string; unit?: string; partNumber?: string; taxable?: boolean; allowBelowCost?: boolean };
export async function addMaterial(deps, input: NewMaterial, editorId: string): Promise<{ created: { uuid: string; name: string } | null; blocks: Issue[]; warnings: Issue[] }>;
export async function checkWriteAccess(deps): Promise<{ ok: boolean; status?: number; item?: string }>;
// undo.ts
export const UNDO_DAYS = 30;
export type UndoResult = { undone: Array<{ id: number; name: string }>; dismissed: Array<{ id: number; name: string }>; skipped: Array<{ id: number; name: string; code: string; current?: FieldValues | null }>; serviceBatches: string[] };
export async function undoChange(deps: EditDeps, ref: { changeId?: number; batchId?: string }, editorId: string): Promise<UndoResult>;
```

- [ ] **Step 1: Write the failing tests.** `src/lib/pricebook/edit/__tests__/apply.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { addMaterial, applyPreview, checkWriteAccess, createPreview, type EditDeps } from "../apply";
import { DAVE, ELLA, NOW, fakeWriter, ids, item, memoryStore } from "./fakes";

function setup() {
  const hcp = fakeWriter([item({ uuid: "m1" }), item({ uuid: "m2", name: "PEX elbow", priceCents: 300, costCents: 100 })]);
  let clock = NOW;
  const mem = memoryStore(() => clock);
  const deps: EditDeps = { store: mem.store, writer: hcp.writer, loadItems: async () => hcp.all(), now: () => clock, newId: ids() };
  return { deps, hcp, mem, advance(ms: number) { clock = new Date(clock.getTime() + ms); } };
}

describe("createPreview / applyPreview", () => {
  it("stores a preview and applies exactly that list, logging each change", async () => {
    const { deps, hcp, mem } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }] }, DAVE);
    expect(p.previewId).toBe("id-1");
    expect(hcp.updates).toEqual([]);
    const r = await applyPreview(deps, p.previewId!, DAVE);
    expect(hcp.updates).toEqual([["m1", { price: 275 }]]);
    expect(r.applied).toEqual([{ uuid: "m1", name: "PEX tee", change: "price $2.50 → $2.75" }]);
    expect(mem.changes[0]).toMatchObject({ kind: "material_update", status: "applied", before: { priceCents: 250 }, after: { priceCents: 275 }, requestedBy: DAVE, batchId: r.batchId, categoryUuid: "c-pex" });
  });

  it("issues no previewId when anything is blocked", async () => {
    const { deps } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 0.1 }] }, DAVE);
    expect(p.previewId).toBeNull();
    expect(p.blocks[0].code).toBe("below_cost");
  });

  it("refuses a preview made by the other editor, a reused one, and an expired one", async () => {
    const { deps, advance } = setup();
    const a = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }] }, DAVE);
    await expect(applyPreview(deps, a.previewId!, ELLA)).rejects.toMatchObject({ code: "preview_other_editor" });
    await applyPreview(deps, a.previewId!, DAVE);
    await expect(applyPreview(deps, a.previewId!, DAVE)).rejects.toMatchObject({ code: "preview_already_applied" });
    const b = await createPreview(deps, { items: [{ uuid: "m2", price: 3.25 }] }, DAVE);
    advance(16 * 60_000);
    await expect(applyPreview(deps, b.previewId!, DAVE)).rejects.toMatchObject({ code: "preview_expired" });
  });

  it("skips an item changed in HCP since the preview", async () => {
    const { deps, hcp } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }] }, DAVE);
    hcp.items.get("m1")!.priceCents = 260;
    const r = await applyPreview(deps, p.previewId!, DAVE);
    expect(r.skipped).toEqual([{ uuid: "m1", name: "PEX tee", code: "changed_since", current: expect.objectContaining({ priceCents: 260 }) }]);
    expect(hcp.updates).toEqual([]);
  });

  it("keeps applied items when HCP fails partway, and logs the failure", async () => {
    const { deps, hcp, mem } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }, { uuid: "m2", price: 3.25 }] }, DAVE);
    hcp.failWith(500, "m2");
    const r = await applyPreview(deps, p.previewId!, DAVE);
    expect(r.applied.map((a) => a.uuid)).toEqual(["m1"]);
    expect(r.failed).toEqual([{ uuid: "m2", name: "PEX elbow", code: "http_500" }]);
    expect(mem.changes.map((c) => c.status)).toEqual(["applied", "failed"]);
  });

  it("turns a 401/403 into key_cannot_write", async () => {
    const { deps, hcp } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }] }, DAVE);
    hcp.failWith(403);
    await expect(applyPreview(deps, p.previewId!, DAVE)).rejects.toMatchObject({ code: "key_cannot_write" });
  });
});

describe("addMaterial", () => {
  it("creates and logs a new material", async () => {
    const { deps, hcp, mem } = setup();
    const r = await addMaterial(deps, { categoryUuid: "c-pex", name: "PEX cap", price: "1.25", cost: 0.4, description: "1/2 inch PEX brass cap fitting" }, ELLA);
    expect(r.created).toEqual({ uuid: "new-1", name: "PEX cap" });
    expect(hcp.created[0]).toEqual(["c-pex", { name: "PEX cap", price: 125, cost: 40, description: "1/2 inch PEX brass cap fitting" }]);
    expect(mem.changes[0]).toMatchObject({ kind: "material_create", before: null, status: "applied", requestedBy: ELLA });
  });
  it("blocks below cost without creating anything", async () => {
    const { deps, hcp } = setup();
    const r = await addMaterial(deps, { categoryUuid: "c-pex", name: "PEX cap", price: 0.1, cost: 0.4 }, ELLA);
    expect(r.created).toBeNull();
    expect(r.blocks[0].code).toBe("below_cost");
    expect(hcp.created).toEqual([]);
  });
});

describe("checkWriteAccess", () => {
  it("saves one material back unchanged", async () => {
    const { deps, hcp } = setup();
    expect(await checkWriteAccess(deps)).toEqual({ ok: true, item: "PEX tee" });
    expect(hcp.updates).toEqual([["m1", { name: "PEX tee" }]]);
  });
  it("reports a read-only key", async () => {
    const { deps, hcp } = setup();
    hcp.failWith(401);
    expect(await checkWriteAccess(deps)).toEqual({ ok: false, status: 401, item: "PEX tee" });
  });
});
```

`src/lib/pricebook/edit/__tests__/undo.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { addMaterial, applyPreview, createPreview, type EditDeps } from "../apply";
import { undoChange } from "../undo";
import { DAVE, NOW, fakeWriter, ids, item, memoryStore } from "./fakes";

function setup() {
  const hcp = fakeWriter([item({ uuid: "m1" }), item({ uuid: "m2", name: "PEX elbow", priceCents: 300, costCents: 100 })]);
  let clock = NOW;
  const mem = memoryStore(() => NOW);
  const deps: EditDeps = { store: mem.store, writer: hcp.writer, loadItems: async () => hcp.all(), now: () => clock, newId: ids() };
  return { deps, hcp, mem, setNow(d: Date) { clock = d; } };
}

async function applied(deps: EditDeps) {
  const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }, { uuid: "m2", price: 3.25 }] }, DAVE);
  return applyPreview(deps, p.previewId!, DAVE);
}

describe("undoChange", () => {
  it("puts a whole batch back and logs the undo", async () => {
    const { deps, hcp, mem } = setup();
    const r = await applied(deps);
    const u = await undoChange(deps, { batchId: r.batchId }, DAVE);
    expect(u.undone.map((x) => x.name)).toEqual(["PEX tee", "PEX elbow"]);
    expect(hcp.items.get("m1")!.priceCents).toBe(250);
    expect(mem.changes.filter((c) => c.kind === "undo")).toHaveLength(2);
    expect(mem.changes.filter((c) => c.kind === "material_update").every((c) => c.status === "undone")).toBe(true);
  });

  it("stops for an item changed since, without overwriting it", async () => {
    const { deps, hcp, mem } = setup();
    const r = await applied(deps);
    hcp.items.get("m1")!.priceCents = 299;
    const u = await undoChange(deps, { batchId: r.batchId }, DAVE);
    const teeId = mem.changes.find((c) => c.itemUuid === "m1")!.id;
    expect(u.skipped).toEqual([{ id: teeId, name: "PEX tee", code: "changed_since", current: expect.objectContaining({ priceCents: 299 }) }]);
    expect(hcp.items.get("m1")!.priceCents).toBe(299);
    expect(u.undone.map((x) => x.name)).toEqual(["PEX elbow"]);
  });

  it("can't undo a new material, and says so", async () => {
    const { deps, mem } = setup();
    await addMaterial(deps, { categoryUuid: "c-pex", name: "PEX cap", price: 1.25, cost: 0.4 }, DAVE);
    const u = await undoChange(deps, { changeId: mem.changes[0].id }, DAVE);
    expect(u.skipped[0].code).toBe("create_cannot_be_undone");
  });

  it("refuses changes older than 30 days", async () => {
    const { deps, setNow } = setup();
    const r = await applied(deps);
    setNow(new Date(NOW.getTime() + 31 * 86_400_000));
    const u = await undoChange(deps, { batchId: r.batchId }, DAVE);
    expect(u.skipped.map((s) => s.code)).toEqual(["too_old", "too_old"]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail** (modules missing).

- [ ] **Step 3: Implement `apply.ts`:**

```ts
// Preview → apply for materials, adding a material, and the write-access check.
// HCP is written one item at a time; each result is logged as it happens, so a
// failure partway leaves everything that landed recorded.
import { HcpWriteError, type HcpMaterialFields } from "@/lib/housecall/pricebookWrite";
import type { PricebookItem } from "@/lib/mcp/pricebook";
import { buildPreview, describeChange, fieldsDiffer, itemValues, parseMoney, priceCheck, toHcpFields, type Issue, type Money, type Preview, type PreviewRequest } from "./changes";
import type { FieldValues, PricebookEditStore } from "./types";

export interface MaterialWriter {
  updateMaterial(uuid: string, f: HcpMaterialFields): Promise<void>;
  createMaterial(categoryUuid: string, f: HcpMaterialFields & { name: string; price: number }): Promise<{ uuid: string }>;
  getMaterial(uuid: string, categoryUuid: string): Promise<PricebookItem | null>;
}
export type EditDeps = { store: PricebookEditStore; writer: MaterialWriter; loadItems(): Promise<PricebookItem[]>; now(): Date; newId(): string };

export class EditError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EditError";
  }
}

export const PREVIEW_TTL_MS = 15 * 60_000;
export const KEY_CANNOT_WRITE = "The Housecall Pro API key can't write to the price book. Make a key with write access in HCP and update HOUSECALL_API_KEY.";

export function isAuthError(err: unknown): boolean {
  return err instanceof HcpWriteError && (err.status === 401 || err.status === 403);
}

export async function createPreview(deps: EditDeps, req: PreviewRequest, editorId: string): Promise<Preview & { previewId: string | null; expiresAt: string | null }> {
  const preview = buildPreview(req, await deps.loadItems());
  if (preview.blocks.length > 0 || preview.changes.length === 0) return { ...preview, previewId: null, expiresAt: null };
  const id = deps.newId();
  const expiresAt = new Date(deps.now().getTime() + PREVIEW_TTL_MS).toISOString();
  await deps.store.createPreview({ id, createdBy: editorId, payload: preview.changes, expiresAt });
  return { ...preview, previewId: id, expiresAt };
}

export type ApplyResult = {
  batchId: string;
  applied: Array<{ uuid: string; name: string; change: string }>;
  failed: Array<{ uuid: string; name: string; code: string }>;
  skipped: Array<{ uuid: string; name: string; code: string; current: FieldValues | null }>;
};

export async function applyPreview(deps: EditDeps, previewId: string, editorId: string): Promise<ApplyResult> {
  const nowIso = deps.now().toISOString();
  const claimed = await deps.store.claimPreview(previewId, editorId, nowIso);
  if (!claimed) {
    const p = await deps.store.getPreview(previewId);
    if (!p) throw new EditError("preview_not_found", "That preview doesn't exist. Preview the changes again.");
    if (p.createdBy !== editorId) throw new EditError("preview_other_editor", "That preview was made by the other editor. Preview the changes again yourself.");
    if (p.appliedAt) throw new EditError("preview_already_applied", "That preview was already applied.");
    throw new EditError("preview_expired", "That preview expired (they last 15 minutes). Preview the changes again.");
  }

  const batchId = deps.newId();
  const result: ApplyResult = { batchId, applied: [], failed: [], skipped: [] };
  for (const c of claimed.payload) {
    const current = c.categoryUuid ? await deps.writer.getMaterial(c.uuid, c.categoryUuid) : null;
    if (!current) { result.skipped.push({ uuid: c.uuid, name: c.name, code: "not_found", current: null }); continue; }
    if (fieldsDiffer(current, c.before)) { result.skipped.push({ uuid: c.uuid, name: c.name, code: "changed_since", current: itemValues(current) }); continue; }
    const base = { batchId, kind: "material_update" as const, itemUuid: c.uuid, itemName: c.name, itemKind: "material" as const, categoryUuid: c.categoryUuid, before: c.before, after: c.after, requestedBy: editorId };
    try {
      await deps.writer.updateMaterial(c.uuid, toHcpFields(c.after));
    } catch (err) {
      if (isAuthError(err)) throw new EditError("key_cannot_write", KEY_CANNOT_WRITE);
      const code = err instanceof HcpWriteError ? `http_${err.status}` : "error";
      await deps.store.insertChanges([{ ...base, status: "failed", errorCode: code }]);
      result.failed.push({ uuid: c.uuid, name: c.name, code });
      continue;
    }
    await deps.store.insertChanges([{ ...base, status: "applied", errorCode: null }]);
    result.applied.push({ uuid: c.uuid, name: c.name, change: describeChange(c.before, c.after) });
  }
  return result;
}

export type NewMaterial = { categoryUuid: string; name: string; price: Money; cost?: Money; description?: string; unit?: string; partNumber?: string; taxable?: boolean; allowBelowCost?: boolean };

export async function addMaterial(deps: EditDeps, input: NewMaterial, editorId: string): Promise<{ created: { uuid: string; name: string } | null; blocks: Issue[]; warnings: Issue[] }> {
  const name = input.name.trim();
  const price = parseMoney(input.price);
  const cost = input.cost !== undefined ? parseMoney(input.cost) : null;
  const blocks: Issue[] = [];
  const warnings: Issue[] = [];
  if (price === null) blocks.push({ uuid: null, name, code: "bad_money", message: `"${input.price}" isn't a price.` });
  const bad = priceCheck(name, "", price, cost, Boolean(input.allowBelowCost));
  if (bad) blocks.push(bad);
  if (blocks.length > 0 || price === null) return { created: null, blocks, warnings };

  const items = await deps.loadItems();
  if (items.some((i) => i.kind === "material" && i.name.trim().toLowerCase() === name.toLowerCase())) {
    warnings.push({ uuid: null, name, code: "duplicate_name", message: `Another material is already called "${name}".` });
  }
  const after: FieldValues = { name, priceCents: price };
  if (cost !== null) after.costCents = cost;
  if (input.description !== undefined) after.description = input.description.trim();
  if (input.unit !== undefined) after.unit = input.unit.trim();
  if (input.partNumber !== undefined) after.partNumber = input.partNumber.trim();
  if (input.taxable !== undefined) after.taxable = input.taxable;

  let uuid: string;
  try {
    ({ uuid } = await deps.writer.createMaterial(input.categoryUuid, { ...toHcpFields(after), name, price }));
  } catch (err) {
    if (isAuthError(err)) throw new EditError("key_cannot_write", KEY_CANNOT_WRITE);
    throw err;
  }
  await deps.store.insertChanges([{ batchId: deps.newId(), kind: "material_create", itemUuid: uuid, itemName: name, itemKind: "material", categoryUuid: input.categoryUuid, before: null, after, status: "applied", requestedBy: editorId, errorCode: null }]);
  return { created: { uuid, name }, blocks, warnings };
}

export async function checkWriteAccess(deps: EditDeps): Promise<{ ok: boolean; status?: number; item?: string }> {
  const m = (await deps.loadItems()).find((i) => i.kind === "material" && i.categoryUuid);
  if (!m) throw new EditError("no_materials", "There are no materials in the price book to test with.");
  try {
    await deps.writer.updateMaterial(m.uuid, { name: m.name });
    return { ok: true, item: m.name };
  } catch (err) {
    if (err instanceof HcpWriteError) return { ok: false, status: err.status, item: m.name };
    throw err;
  }
}
```

In the `addMaterial` test, `hcp.created[0][1]` must equal `{ name, price: 125, cost: 40, description }`. `toHcpFields(after)` produces `{ name, description, price, cost }` with the keys in a different order, and `toEqual` ignores key order, so that's fine.

Implement `undo.ts`:

```ts
// Undo a logged change or batch, up to 30 days back. Never overwrites an item
// that changed since: it stops for that item and reports what HCP holds now.
import { HcpWriteError } from "@/lib/housecall/pricebookWrite";
import { EditError, KEY_CANNOT_WRITE, isAuthError, type EditDeps } from "./apply";
import { fieldsDiffer, itemValues, toHcpFields } from "./changes";
import type { ChangeRow, FieldValues } from "./types";

export const UNDO_DAYS = 30;

export type UndoResult = {
  undone: Array<{ id: number; name: string }>;
  dismissed: Array<{ id: number; name: string }>;
  skipped: Array<{ id: number; name: string; code: string; current?: FieldValues | null }>;
  serviceBatches: string[];
};

export async function undoChange(deps: EditDeps, ref: { changeId?: number; batchId?: string }, editorId: string): Promise<UndoResult> {
  let rows: ChangeRow[] = [];
  if (ref.changeId !== undefined) { const r = await deps.store.getChange(ref.changeId); rows = r ? [r] : []; }
  else if (ref.batchId) rows = await deps.store.listBatch(ref.batchId);
  if (rows.length === 0) throw new EditError("change_not_found", "No change with that id. Use recent_changes to find it.");

  const now = deps.now();
  const nowIso = now.toISOString();
  const cutoff = now.getTime() - UNDO_DAYS * 86_400_000;
  const undoBatch = deps.newId();
  const out: UndoResult = { undone: [], dismissed: [], skipped: [], serviceBatches: [] };

  for (const r of rows) {
    if (Date.parse(r.createdAt) < cutoff) { out.skipped.push({ id: r.id, name: r.itemName, code: "too_old" }); continue; }
    if (r.kind === "material_create") { out.skipped.push({ id: r.id, name: r.itemName, code: "create_cannot_be_undone" }); continue; }
    if (r.kind === "service_request" && r.status === "pending") {
      await deps.store.setStatus([r.id], "dismissed", { resolvedBy: editorId, resolvedAt: nowIso });
      out.dismissed.push({ id: r.id, name: r.itemName });
      if (!out.serviceBatches.includes(r.batchId)) out.serviceBatches.push(r.batchId);
      continue;
    }
    if (r.kind !== "material_update" || r.status !== "applied" || !r.before || !r.categoryUuid) { out.skipped.push({ id: r.id, name: r.itemName, code: "not_undoable" }); continue; }

    const current = await deps.writer.getMaterial(r.itemUuid, r.categoryUuid);
    if (!current) { out.skipped.push({ id: r.id, name: r.itemName, code: "not_found", current: null }); continue; }
    if (fieldsDiffer(current, r.after)) { out.skipped.push({ id: r.id, name: r.itemName, code: "changed_since", current: itemValues(current) }); continue; }
    try {
      await deps.writer.updateMaterial(r.itemUuid, toHcpFields(r.before));
    } catch (err) {
      if (isAuthError(err)) throw new EditError("key_cannot_write", KEY_CANNOT_WRITE);
      out.skipped.push({ id: r.id, name: r.itemName, code: err instanceof HcpWriteError ? `http_${err.status}` : "error" });
      continue;
    }
    await deps.store.setStatus([r.id], "undone", { resolvedBy: editorId, resolvedAt: nowIso });
    await deps.store.insertChanges([{ batchId: undoBatch, kind: "undo", itemUuid: r.itemUuid, itemName: r.itemName, itemKind: "material", categoryUuid: r.categoryUuid, before: r.after, after: r.before, status: "applied", requestedBy: editorId, errorCode: null }]);
    out.undone.push({ id: r.id, name: r.itemName });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** `npx vitest run src/lib/pricebook`

- [ ] **Step 5: Commit**

```bash
git add src/lib/pricebook/edit
git commit -m "feat(pricebook): apply previews, add materials, check write access, undo"
```

---

### Task 5: The services checklist in Slack

**Files:**
- Create: `src/lib/pricebook/edit/serviceChecklist.ts`, `src/lib/pricebook/edit/__tests__/serviceChecklist.test.ts`
- Modify: `src/lib/slack/web.ts` (add `postThreadReply`), `src/lib/slack/__tests__/web.test.ts` (append)

**Interfaces produced:**
```ts
// web.ts
export async function postThreadReply(token: string, channel: string, threadTs: string, text: string): Promise<void>;
// serviceChecklist.ts
export const PB_ACTION_PREFIX = "pb_cb";
export const PB_NOT_ALLOWED_TEXT = "Only Dave and Ella can check these off.";
export function pbActionId(batchId: string, chunk: number): string;
export function parsePbActionId(id: string): { batchId: string; chunk: number } | null;
export interface ChecklistSlack { post(channel: string, text: string, blocks: unknown[]): Promise<string>; update(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void>; reply(channel: string, threadTs: string, text: string): Promise<void> }
export type ServiceDeps = { store: PricebookEditStore; slack: ChecklistSlack; channelId: string; loadItems(): Promise<PricebookItem[]>; now(): Date; newId(): string; nameOf(userId: string): string };
export type ServiceRequestInput = { uuid: string; price?: Money; description?: string; name?: string };
export async function requestServiceChanges(deps, items: ServiceRequestInput[], editorId: string, opts?: { allowBelowCost?: boolean }): Promise<{ batchId: string | null; requested: Array<{ id: number; name: string; change: string }>; merged: Array<{ id: number; name: string }>; blocks: Issue[]; warnings: Issue[] }>;
export function renderServiceBatch(rows: ChangeRow[], askedBy: string): { text: string; blocks: unknown[] };
export async function rerenderBatch(deps, batchId: string): Promise<void>;
export async function handleServiceTap(payload: BlockActionsPayload, deps: ServiceDeps, opts: { allowedUsers: string[]; note(url: string, text: string): Promise<unknown> }): Promise<void>;
```

- [ ] **Step 1: Write the failing tests.** Append to `src/lib/slack/__tests__/web.test.ts`, and add `postThreadReply` to its import:

```ts
describe("postThreadReply", () => {
  it("posts into the thread", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, ts: "2" }));
    await postThreadReply(TOKEN, "C1", "900.1", "hello");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ channel: "C1", thread_ts: "900.1", text: "hello" });
  });
});
```

`src/lib/pricebook/edit/__tests__/serviceChecklist.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { PB_NOT_ALLOWED_TEXT, handleServiceTap, parsePbActionId, pbActionId, requestServiceChanges, type ServiceDeps } from "../serviceChecklist";
import type { PricebookItem } from "@/lib/mcp/pricebook";
import { DAVE, ELLA, NOW, fakeSlack, ids, item, memoryStore } from "./fakes";

const DRAIN = item({ uuid: "s1", kind: "service", name: "Drain cleaning", category: "Drains", priceCents: 17500, costCents: 6000, description: "Main line drain cleaning up to 100 ft" });
const HEATER = item({ uuid: "s2", kind: "service", name: "Water heater install", category: "Heaters", priceCents: 180000, costCents: 90000, description: "Standard 50 gal tank install" });

function setup() {
  const mem = memoryStore();
  const slack = fakeSlack();
  let book: PricebookItem[] = [DRAIN, HEATER, item({ uuid: "m1" })];
  const deps: ServiceDeps = { store: mem.store, slack: slack.port, channelId: "C_PB", loadItems: async () => book, now: () => NOW, newId: ids(), nameOf: (u) => (u === DAVE ? "Dave" : u === ELLA ? "Ella" : u) };
  return { deps, mem, slack, setBook(b: PricebookItem[]) { book = b; } };
}

const tap = (blocks: unknown[], actionId: string, selected: string[], user = "U_DAVE") => ({
  type: "block_actions", user: { id: user }, response_url: "https://hooks.slack.com/actions/x",
  message: { blocks }, actions: [{ action_id: actionId, selected_options: selected.map((value) => ({ value })) }],
});
const last = <T,>(a: T[]) => a[a.length - 1];

describe("requestServiceChanges", () => {
  it("logs pending requests and posts one checklist with a thread for descriptions", async () => {
    const { deps, mem, slack } = setup();
    const r = await requestServiceChanges(deps, [{ uuid: "s1", price: 195, description: "Main line drain cleaning up to 150 ft, camera check included" }], DAVE);
    expect(r.requested).toEqual([{ id: 1, name: "Drain cleaning", change: "price $175.00 → $195.00; description changed" }]);
    expect(mem.changes[0]).toMatchObject({ kind: "service_request", status: "pending", itemKind: "service", requestedBy: DAVE, slackMessageTs: "900.1" });
    expect(slack.posts[0].channel).toBe("C_PB");
    expect(JSON.stringify(slack.posts[0].blocks)).toContain("Drain cleaning: $175.00 → $195.00");
    expect(slack.replies[0].text).toContain("camera check included");
  });

  it("blocks materials, unknown ids and below-cost prices", async () => {
    const { deps, slack } = setup();
    const r = await requestServiceChanges(deps, [{ uuid: "m1", price: 3 }, { uuid: "zz", price: 1 }, { uuid: "s1", price: 10 }], DAVE);
    expect(r.blocks.map((b) => b.code).sort()).toEqual(["below_cost", "material_use_preview", "unknown_item"]);
    expect(slack.posts).toEqual([]);
  });

  it("merges into an existing pending request for the same service", async () => {
    const { deps, mem, slack } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    const r = await requestServiceChanges(deps, [{ uuid: "s1", price: 199 }], ELLA);
    expect(r.merged).toEqual([{ id: 1, name: "Drain cleaning" }]);
    expect(mem.changes).toHaveLength(1);
    expect(mem.changes[0].after.priceCents).toBe(19900);
    expect(slack.updates).toHaveLength(1);
  });
});

describe("handleServiceTap", () => {
  it("marks a ticked service done and replies when HCP still differs", async () => {
    const { deps, mem, slack } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    const note = vi.fn(async () => true);
    await handleServiceTap(tap(slack.lastBlocks(), pbActionId(mem.changes[0].batchId, 0), ["1"]), deps, { allowedUsers: ["U_DAVE"], note });
    expect(mem.changes[0]).toMatchObject({ status: "done", resolvedBy: "U_DAVE" });
    expect(last(slack.replies).text).toBe("HCP still shows $175.00 for Drain cleaning.");
  });

  it("doesn't reply when HCP matches", async () => {
    const { deps, mem, slack, setBook } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    setBook([{ ...DRAIN, priceCents: 19500 }, HEATER]);
    const before = slack.replies.length;
    await handleServiceTap(tap(slack.lastBlocks(), pbActionId(mem.changes[0].batchId, 0), ["1"]), deps, { allowedUsers: ["U_DAVE"], note: async () => true });
    expect(slack.replies.length).toBe(before);
  });

  it("snaps back for anyone else", async () => {
    const { deps, mem, slack } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    const note = vi.fn(async () => true);
    await handleServiceTap(tap(slack.lastBlocks(), pbActionId(mem.changes[0].batchId, 0), ["1"], "U_OTHER"), deps, { allowedUsers: ["U_DAVE"], note });
    expect(mem.changes[0].status).toBe("pending");
    expect(note).toHaveBeenCalledWith("https://hooks.slack.com/actions/x", PB_NOT_ALLOWED_TEXT);
  });

  it("parses its own action ids only", () => {
    expect(parsePbActionId(pbActionId("b-1", 2))).toEqual({ batchId: "b-1", chunk: 2 });
    expect(parsePbActionId("fieldy_cb:1:0")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement.** In `src/lib/slack/web.ts`, add:

```ts
/** A reply in a message's thread. Same chat:write scope. */
export async function postThreadReply(token: string, channel: string, threadTs: string, text: string): Promise<void> {
  await call("chat.postMessage", token, { json: { channel, thread_ts: threadTs, text, unfurl_links: false, unfurl_media: false } });
}
```

Create `src/lib/pricebook/edit/serviceChecklist.ts`:

```ts
// Service changes can't go through HCP's API, so they're requests: logged as
// pending, posted to a Slack checklist, applied by hand in HCP, then ticked.
// A tick is checked against HCP (services are readable) and a mismatch gets a
// thread reply. One tap = one change, the same stale-message rule as the Fieldy list.
import { formatMoney, type PricebookItem } from "@/lib/mcp/pricebook";
import { optionValuesFor, type BlockActionsPayload } from "@/lib/tasks/interact";
import { fitText } from "@/lib/tasks/organize";
import { escapeMrkdwn, optionLabel } from "@/lib/tasks/render";
import { BIG_CHANGE, describeChange, itemValues, parseMoney, priceCheck, type Issue, type Money } from "./changes";
import type { ChangeRow, FieldValues, PricebookEditStore } from "./types";

export const PB_ACTION_PREFIX = "pb_cb";
export const PB_NOT_ALLOWED_TEXT = "Only Dave and Ella can check these off.";
const PER_ELEMENT = 10;
const DESC_MAX = 75;

export function pbActionId(batchId: string, chunk: number): string {
  return `${PB_ACTION_PREFIX}:${batchId}:${chunk}`;
}
export function parsePbActionId(id: string): { batchId: string; chunk: number } | null {
  const m = /^pb_cb:([0-9a-zA-Z-]+):(\d+)$/.exec(id);
  return m ? { batchId: m[1], chunk: Number(m[2]) } : null;
}

export interface ChecklistSlack {
  post(channel: string, text: string, blocks: unknown[]): Promise<string>;
  update(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void>;
  reply(channel: string, threadTs: string, text: string): Promise<void>;
}
export type ServiceDeps = { store: PricebookEditStore; slack: ChecklistSlack; channelId: string; loadItems(): Promise<PricebookItem[]>; now(): Date; newId(): string; nameOf(userId: string): string };
export type ServiceRequestInput = { uuid: string; price?: Money; description?: string; name?: string };

function label(r: ChangeRow): string {
  if (r.after.priceCents !== undefined) return `${r.itemName}: ${r.before?.priceCents !== undefined ? formatMoney(r.before.priceCents) : "?"} → ${formatMoney(r.after.priceCents)}`;
  if (r.after.name !== undefined) return `${r.itemName} → rename to "${r.after.name}"`;
  return `${r.itemName}: new description`;
}

export function renderServiceBatch(rows: ChangeRow[], askedBy: string): { text: string; blocks: unknown[] } {
  const live = rows.filter((r) => r.status !== "dismissed");
  const done = live.filter((r) => r.status === "done").length;
  const heading = `Price book: ${live.length} service change${live.length === 1 ? "" : "s"} to make in HCP`;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: heading } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Asked by ${escapeMrkdwn(askedBy)}. HCP's API can't change services, so make these in HCP, then tick them here.` }] },
  ];
  if (live.length === 0) blocks.push({ type: "section", text: { type: "mrkdwn", text: "All of these were dismissed." } });
  const elements: unknown[] = [];
  for (let i = 0; i < live.length; i += PER_ELEMENT) {
    const chunk = live.slice(i, i + PER_ELEMENT);
    const options = chunk.map((r) => ({
      text: { type: "mrkdwn", text: optionLabel(label(r), r.status === "done") },
      value: String(r.id),
      ...(r.after.description !== undefined ? { description: { type: "plain_text", text: fitText(r.after.description, DESC_MAX) } } : {}),
    }));
    const initial = options.filter((_, k) => chunk[k].status === "done");
    elements.push({ type: "checkboxes", action_id: pbActionId(rows[0].batchId, i / PER_ELEMENT), options, ...(initial.length ? { initial_options: initial } : {}) });
  }
  if (elements.length) blocks.push({ type: "actions", elements });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${done} of ${live.length} done` }] });
  return { text: `${heading}: ${done} of ${live.length} done`, blocks };
}

export async function rerenderBatch(deps: ServiceDeps, batchId: string): Promise<void> {
  const rows = await deps.store.listBatch(batchId);
  if (rows.length === 0 || !rows[0].slackMessageTs || !rows[0].slackChannelId) return;
  const msg = renderServiceBatch(rows, deps.nameOf(rows[0].requestedBy));
  await deps.slack.update(rows[0].slackChannelId, rows[0].slackMessageTs, msg.text, msg.blocks);
}

export async function requestServiceChanges(
  deps: ServiceDeps,
  items: ServiceRequestInput[],
  editorId: string,
  opts: { allowBelowCost?: boolean } = {}
): Promise<{ batchId: string | null; requested: Array<{ id: number; name: string; change: string }>; merged: Array<{ id: number; name: string }>; blocks: Issue[]; warnings: Issue[] }> {
  const book = await deps.loadItems();
  const byUuid = new Map(book.map((i) => [i.uuid, i]));
  const blocks: Issue[] = [];
  const warnings: Issue[] = [];
  const planned: Array<{ it: PricebookItem; before: FieldValues; after: FieldValues }> = [];

  for (const req of items) {
    const it = byUuid.get(req.uuid);
    if (!it) { blocks.push({ uuid: req.uuid, name: null, code: "unknown_item", message: `No price book item has id ${req.uuid}.` }); continue; }
    if (it.kind !== "service") { blocks.push({ uuid: it.uuid, name: it.name, code: "material_use_preview", message: `${it.name} is a material; change it with preview_material_changes.` }); continue; }
    const cur = itemValues(it);
    const after: FieldValues = {};
    if (req.price !== undefined) { const c = parseMoney(req.price); if (c === null) { blocks.push({ uuid: it.uuid, name: it.name, code: "bad_money", message: `"${req.price}" isn't a price.` }); continue; } after.priceCents = c; }
    if (req.name !== undefined) after.name = req.name.trim();
    if (req.description !== undefined) after.description = req.description.trim();
    const bad = priceCheck(it.name, it.uuid, after.priceCents ?? it.priceCents, it.costCents, Boolean(opts.allowBelowCost));
    if (bad) { blocks.push(bad); continue; }
    if (after.priceCents !== undefined && it.priceCents && Math.abs(after.priceCents - it.priceCents) / it.priceCents > BIG_CHANGE) {
      warnings.push({ uuid: it.uuid, name: it.name, code: "big_change", message: `${it.name}: price moves more than 25%.` });
    }
    const before: FieldValues = {};
    for (const k of Object.keys(after) as Array<keyof FieldValues>) if (cur[k] !== undefined) (before as Record<string, unknown>)[k] = cur[k];
    planned.push({ it, before, after });
  }
  if (blocks.length > 0 || planned.length === 0) return { batchId: null, requested: [], merged: [], blocks, warnings };

  const pending = await deps.store.listPendingServices();
  const merged: Array<{ id: number; name: string }> = [];
  const touchedBatches: string[] = [];
  const fresh: typeof planned = [];
  for (const p of planned) {
    const existing = pending.find((r) => r.itemUuid === p.it.uuid);
    if (existing) {
      await deps.store.updateAfter(existing.id, { ...existing.after, ...p.after });
      merged.push({ id: existing.id, name: existing.itemName });
      if (!touchedBatches.includes(existing.batchId)) touchedBatches.push(existing.batchId);
    } else fresh.push(p);
  }
  for (const b of touchedBatches) await rerenderBatch(deps, b);
  if (fresh.length === 0) return { batchId: null, requested: [], merged, blocks, warnings };

  const batchId = deps.newId();
  const rows = await deps.store.insertChanges(
    fresh.map((p) => ({ batchId, kind: "service_request" as const, itemUuid: p.it.uuid, itemName: p.it.name, itemKind: "service" as const, categoryUuid: null, before: p.before, after: p.after, status: "pending" as const, requestedBy: editorId, errorCode: null }))
  );
  const msg = renderServiceBatch(rows, deps.nameOf(editorId));
  const ts = await deps.slack.post(deps.channelId, msg.text, msg.blocks);
  await deps.store.setSlackMessage(batchId, deps.channelId, ts);
  const withDesc = rows.filter((r) => r.after.description !== undefined);
  if (withDesc.length > 0) {
    await deps.slack.reply(deps.channelId, ts, withDesc.map((r) => `*${escapeMrkdwn(r.itemName)}*, new description:\n${escapeMrkdwn(r.after.description ?? "")}`).join("\n\n"));
  }
  return { batchId, requested: rows.map((r) => ({ id: r.id, name: r.itemName, change: describeChange(r.before, r.after) })), merged, blocks, warnings };
}

function hcpMismatch(r: ChangeRow, now: PricebookItem | undefined): string | null {
  if (!now) return `HCP no longer lists ${r.itemName}.`;
  if (r.after.priceCents !== undefined && now.priceCents !== r.after.priceCents) return `HCP still shows ${formatMoney(now.priceCents)} for ${r.itemName}.`;
  if (r.after.name !== undefined && now.name.trim() !== r.after.name) return `HCP still shows the name "${now.name}" for ${r.itemName}.`;
  if (r.after.description !== undefined && now.description.trim() !== r.after.description) return `HCP's description for ${r.itemName} doesn't match the request yet.`;
  return null;
}

export async function handleServiceTap(
  payload: BlockActionsPayload,
  deps: ServiceDeps,
  opts: { allowedUsers: string[]; note(url: string, text: string): Promise<unknown> }
): Promise<void> {
  const userId = payload.user?.id ?? "";
  for (const action of payload.actions ?? []) {
    const aid = action.action_id ?? "";
    const parsed = parsePbActionId(aid);
    if (!parsed) continue;
    const rows = await deps.store.listBatch(parsed.batchId);
    if (rows.length === 0) continue;
    if (!opts.allowedUsers.includes(userId)) {
      await rerenderBatch(deps, parsed.batchId);
      if (payload.response_url) await opts.note(payload.response_url, PB_NOT_ALLOWED_TEXT);
      continue;
    }
    const values = optionValuesFor(payload.message?.blocks, aid) ?? [];
    const selected = new Set((action.selected_options ?? []).map((o) => o.value));
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const tick: ChangeRow[] = [];
    const untick: ChangeRow[] = [];
    for (const v of values) {
      const r = byId.get(v);
      if (!r || r.status === "dismissed") continue;
      if (selected.has(v) && r.status === "pending") tick.push(r);
      if (!selected.has(v) && r.status === "done") untick.push(r);
    }
    const nowIso = deps.now().toISOString();
    if (tick.length > 0) {
      await deps.store.setStatus(tick.map((r) => r.id), "done", { resolvedBy: userId, resolvedAt: nowIso });
    } else if (untick.length === 1) {
      await deps.store.setStatus([untick[0].id], "pending", { resolvedBy: null, resolvedAt: null });
    }
    await rerenderBatch(deps, parsed.batchId);
    if (tick.length > 0) {
      const byUuid = new Map((await deps.loadItems()).map((i) => [i.uuid, i]));
      for (const r of tick) {
        const msg = hcpMismatch(r, byUuid.get(r.itemUuid));
        if (msg && r.slackChannelId && r.slackMessageTs) await deps.slack.reply(r.slackChannelId, r.slackMessageTs, msg);
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** `npx vitest run src/lib/pricebook src/lib/slack`

- [ ] **Step 5: Commit**

```bash
git add src/lib/pricebook/edit/serviceChecklist.ts src/lib/pricebook/edit/__tests__/serviceChecklist.test.ts src/lib/slack
git commit -m "feat(pricebook): service change requests as a Slack checklist, checked against HCP on tick"
```

---

### Task 6: Live wiring and the Slack tap router

**Files:**
- Create: `src/lib/pricebook/edit/deps.ts`, `src/lib/pricebook/edit/__tests__/deps.test.ts`
- Modify: `src/app/api/slack/interact/route.ts`, `src/app/api/slack/interact/__tests__/route.test.ts`

**Interfaces produced (`deps.ts`):**
```ts
export const NOT_EDITOR_TEXT = "The price book editor is only available to Dave and Ella.";
export function pricebookEditEnabled(): boolean;
export function parseEditors(raw: string | undefined): Map<string, string>;
export function pricebookSlackUsers(): string[];
export function serviceConfigMissing(): string | null;
export function liveEditDeps(): EditDeps;
export function liveServiceDeps(editors?: Map<string, string>): ServiceDeps;
export async function listAllCategories(): Promise<Array<{ uuid: string; name: string; parentUuid: string | null }>>;
```

- [ ] **Step 1: Write the failing tests.** `src/lib/pricebook/edit/__tests__/deps.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseEditors, pricebookEditEnabled, pricebookSlackUsers, serviceConfigMissing } from "../deps";

afterEach(() => vi.unstubAllEnvs());

describe("deps config", () => {
  it("parses editors with optional names", () => {
    expect(Array.from(parseEditors(" u1:Dave , u2:Ella ,u3 ").entries())).toEqual([["u1", "Dave"], ["u2", "Ella"], ["u3", "u3"]]);
    expect(parseEditors(undefined).size).toBe(0);
  });
  it("is off unless exactly 'true'", () => {
    vi.stubEnv("MCP_PRICEBOOK_EDIT_ENABLED", "TRUE");
    expect(pricebookEditEnabled()).toBe(false);
    vi.stubEnv("MCP_PRICEBOOK_EDIT_ENABLED", "true");
    expect(pricebookEditEnabled()).toBe(true);
  });
  it("names the first missing Slack setting and parses allowed users", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-1");
    vi.stubEnv("SLACK_PRICEBOOK_CHANNEL_ID", "");
    expect(serviceConfigMissing()).toBe("SLACK_PRICEBOOK_CHANNEL_ID is not set");
    vi.stubEnv("SLACK_PRICEBOOK_ALLOWED_USERS", "U1, U2");
    expect(pricebookSlackUsers()).toEqual(["U1", "U2"]);
  });
});
```

In `src/app/api/slack/interact/__tests__/route.test.ts`:
- Add `pbTapMock: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})` to the `vi.hoisted` block.
- Add two mocks:
  - `vi.mock("@/lib/pricebook/edit/serviceChecklist", async (orig) => ({ ...(await orig<typeof import("@/lib/pricebook/edit/serviceChecklist")>()), handleServiceTap: pbTapMock }))`
  - `vi.mock("@/lib/pricebook/edit/deps", async (orig) => ({ ...(await orig<typeof import("@/lib/pricebook/edit/deps")>()), liveServiceDeps: () => ({}), serviceConfigMissing: () => null }))`
- Add `pbTapMock.mockClear()` to `beforeEach`.
- Append:

```ts
const PB_TAP = { type: "block_actions", user: { id: "U_DAVE" }, actions: [{ action_id: "pb_cb:b-1:0", selected_options: [{ value: "1" }] }] };

describe("/api/slack/interact price book taps", () => {
  it("routes pb_cb taps to the price book handler when its switch is on", async () => {
    vi.stubEnv("MCP_PRICEBOOK_EDIT_ENABLED", "true");
    vi.stubEnv("SLACK_PRICEBOOK_ALLOWED_USERS", "U_DAVE,U_ELLA");
    const res = await POST(signedRequest(PB_TAP));
    expect(res.status).toBe(200);
    expect(pbTapMock).toHaveBeenCalledTimes(1);
    expect(pbTapMock.mock.calls[0][2]).toMatchObject({ allowedUsers: ["U_DAVE", "U_ELLA"] });
    expect(tapMock).not.toHaveBeenCalled();
  });

  it("ignores pb_cb taps while the price book switch is off", async () => {
    await POST(signedRequest(PB_TAP));
    expect(pbTapMock).not.toHaveBeenCalled();
  });

  it("doesn't run Fieldy taps when only the price book switch is on", async () => {
    vi.stubEnv("SLACK_FIELDY_ENABLED", "false");
    vi.stubEnv("MCP_PRICEBOOK_EDIT_ENABLED", "true");
    await POST(signedRequest(TAP));
    expect(tapMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement `deps.ts`:**

```ts
// Live wiring for the Trinity Price Book Editor, its switches and settings.
import { randomUUID } from "node:crypto";
import { HousecallPricebookClient } from "@/lib/housecall/pricebook";
import { HousecallPricebookWriter } from "@/lib/housecall/pricebookWrite";
import { createPricebookLoader, type PricebookItem } from "@/lib/mcp/pricebook";
import { postMessage, postThreadReply, updateMessage } from "@/lib/slack/web";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import type { EditDeps } from "./apply";
import type { ServiceDeps } from "./serviceChecklist";
import { supabasePricebookEditStore } from "./store";

export const NOT_EDITOR_TEXT = "The price book editor is only available to Dave and Ella.";

export function pricebookEditEnabled(): boolean {
  return process.env.MCP_PRICEBOOK_EDIT_ENABLED === "true";
}

export function parseEditors(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf(":");
    const id = (i === -1 ? p : p.slice(0, i)).trim();
    const name = (i === -1 ? "" : p.slice(i + 1)).trim();
    if (id) out.set(id, name || id);
  }
  return out;
}

export function pricebookSlackUsers(): string[] {
  return (process.env.SLACK_PRICEBOOK_ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function serviceConfigMissing(): string | null {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return "SLACK_BOT_TOKEN is not set";
  if (!token.startsWith("xoxb-")) return "SLACK_BOT_TOKEN is not a bot token (xoxb-…)";
  if (!process.env.SLACK_PRICEBOOK_CHANNEL_ID) return "SLACK_PRICEBOOK_CHANNEL_ID is not set";
  return null;
}

// Fresh every time (ttl 0): edits must see HCP as it is now.
function freshItems(): () => Promise<PricebookItem[]> {
  const load = createPricebookLoader(new HousecallPricebookClient(), { ttlMs: 0, includeCategoryUuid: true });
  return async () => (await load()).items;
}

export function liveEditDeps(): EditDeps {
  return {
    store: supabasePricebookEditStore(getSupabaseServerClient()),
    writer: new HousecallPricebookWriter(),
    loadItems: freshItems(),
    now: () => new Date(),
    newId: () => randomUUID(),
  };
}

export function liveServiceDeps(editors: Map<string, string> = parseEditors(process.env.MCP_PRICEBOOK_EDITORS)): ServiceDeps {
  const token = () => process.env.SLACK_BOT_TOKEN ?? "";
  return {
    store: supabasePricebookEditStore(getSupabaseServerClient()),
    slack: {
      post: (channel, text, blocks) => postMessage(token(), channel, text, blocks),
      update: (channel, ts, text, blocks) => updateMessage(token(), channel, ts, text, blocks),
      reply: (channel, threadTs, text) => postThreadReply(token(), channel, threadTs, text),
    },
    channelId: process.env.SLACK_PRICEBOOK_CHANNEL_ID ?? "",
    loadItems: freshItems(),
    now: () => new Date(),
    newId: () => randomUUID(),
    nameOf: (id) => editors.get(id) ?? id,
  };
}

export async function listAllCategories(): Promise<Array<{ uuid: string; name: string; parentUuid: string | null }>> {
  const client = new HousecallPricebookClient();
  const out: Array<{ uuid: string; name: string; parentUuid: string | null }> = [];
  let level: Array<string | undefined> = [undefined];
  while (level.length > 0 && out.length < 300) {
    const next: string[] = [];
    for (const parent of level) {
      const res = await client.listMaterialCategories(parent);
      for (const c of res.items) {
        out.push({ uuid: c.uuid, name: c.name ?? "", parentUuid: parent ?? null });
        next.push(c.uuid);
      }
    }
    level = next;
  }
  return out;
}
```

Then change `src/app/api/slack/interact/route.ts`:

(a) Add the imports:

```ts
import { liveServiceDeps, pricebookEditEnabled, pricebookSlackUsers, serviceConfigMissing } from "@/lib/pricebook/edit/deps";
import { handleServiceTap, parsePbActionId } from "@/lib/pricebook/edit/serviceChecklist";
```

(b) Replace everything inside `POST` with:

```ts
  const fieldyOn = fieldyEnabled();
  const pbOn = pricebookEditEnabled();
  if (!fieldyOn && !pbOn) return OK();

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return NextResponse.json({ error: "SLACK_SIGNING_SECRET is not set on this deployment" }, { status: 503 });
  }

  const rawBody = await req.text();
  const ok = verifySlackSignature({
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    signingSecret,
    nowMs: Date.now(),
  });
  if (!ok) return new NextResponse("Unauthorized", { status: 401 });

  let payload: BlockActionsPayload;
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "");
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (payload?.type !== "block_actions" || !Array.isArray(payload.actions)) return OK();
  const actions = payload.actions;

  const jobs: Promise<unknown>[] = [];
  const log = (what: string) => (err: unknown) =>
    console.error(`[slack] ${what} tap failed:`, err instanceof Error ? err.message : String(err));

  if (fieldyOn && actions.some((a) => a.action_id && parseActionId(a.action_id))) {
    const missing = checklistConfigMissing();
    if (missing) console.warn(`[fieldy] checklist tap ignored: ${missing}`);
    else jobs.push(handleChecklistTap(payload, liveChecklistDeps(), { allowedUsers: allowedSlackUsers(), note: postEphemeralNote }).catch(log("checklist")));
  }
  if (pbOn && actions.some((a) => a.action_id && parsePbActionId(a.action_id))) {
    const missing = serviceConfigMissing();
    if (missing) console.warn(`[pricebook] service tap ignored: ${missing}`);
    else jobs.push(handleServiceTap(payload, liveServiceDeps(), { allowedUsers: pricebookSlackUsers(), note: postEphemeralNote }).catch(log("price book")));
  }
  // Slack wants an answer within 3 seconds; the work finishes after the reply.
  if (jobs.length > 0) waitUntil(Promise.all(jobs));
  return OK();
```

(c) Update the header comment to say the route handles `fieldy_cb:` (Fieldy checklist) and `pb_cb:` (price book service changes) taps, each with its own switch.

- [ ] **Step 4: Run the tests and confirm they pass.** `npx vitest run src/lib/pricebook src/app/api/slack src/lib/tasks`. Every existing Fieldy route test must pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pricebook/edit/deps.ts src/lib/pricebook/edit/__tests__/deps.test.ts src/app/api/slack/interact
git commit -m "feat(pricebook): live wiring, and route pb_cb Slack taps beside Fieldy's"
```

---

### Task 7: The Trinity Price Book Editor connector

**Files:**
- Modify: `src/lib/mcp/auth.ts`
- Create:
  - `src/lib/mcp/pricebookEdit/server.ts`
  - `src/lib/mcp/pricebookEdit/__tests__/server.test.ts`
  - `src/app/api/mcp/pricebook-edit/route.ts`
  - `src/app/api/mcp/pricebook-edit/__tests__/route.test.ts`
  - `src/app/.well-known/oauth-protected-resource/api/mcp/pricebook-edit/route.ts`

**Interfaces produced:**
```ts
export const PRICEBOOK_EDIT_RESOURCE: McpResource;   // path "/api/mcp/pricebook-edit", metadataPath "/.well-known/oauth-protected-resource/api/mcp/pricebook-edit", name "Trinity Plumbing price book editor (Dave and Ella)"
export interface PricebookEditToolDeps { edit: EditDeps; service: ServiceDeps; editors: Map<string, string>; listCategories(): Promise<Array<{ uuid: string; name: string; parentUuid: string | null }>>; serviceConfigMissing(): string | null }
export const SERVER_INSTRUCTIONS: string;
export function createPricebookEditMcpServer(deps: PricebookEditToolDeps, callerUserId: string | null): McpServer;
```

- [ ] **Step 1: Write the failing tests.** `src/lib/mcp/pricebookEdit/__tests__/server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPricebookEditMcpServer, type PricebookEditToolDeps } from "../server";
import { NOT_EDITOR_TEXT } from "@/lib/pricebook/edit/deps";
import { DAVE, ELLA, NOW, fakeSlack, fakeWriter, ids, item, memoryStore } from "@/lib/pricebook/edit/__tests__/fakes";

const BOOK = [item({ uuid: "m1" }), item({ uuid: "s1", kind: "service", name: "Drain cleaning", category: "Drains", categoryUuid: undefined, priceCents: 17500, costCents: 6000 })];

async function connect(caller: string | null) {
  const hcp = fakeWriter(BOOK);
  const mem = memoryStore();
  const slack = fakeSlack();
  const next = ids();
  const deps: PricebookEditToolDeps = {
    edit: { store: mem.store, writer: hcp.writer, loadItems: async () => hcp.all(), now: () => NOW, newId: next },
    service: { store: mem.store, slack: slack.port, channelId: "C_PB", loadItems: async () => hcp.all(), now: () => NOW, newId: next, nameOf: (u) => (u === DAVE ? "Dave" : "Ella") },
    editors: new Map([[DAVE, "Dave"], [ELLA, "Ella"]]),
    listCategories: async () => [{ uuid: "c-pex", name: "PEX", parentUuid: null }],
    serviceConfigMissing: () => null,
  };
  const server = createPricebookEditMcpServer(deps, caller);
  const client = new Client({ name: "t", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, hcp, mem, slack };
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("Trinity Price Book Editor", () => {
  it("lists nine tools with honest hints", async () => {
    const { client } = await connect(DAVE);
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(Object.keys(hints).sort()).toEqual(["add_material", "apply_material_changes", "check_write_access", "find_items", "list_categories", "preview_material_changes", "recent_changes", "request_service_changes", "undo_change"]);
    expect(hints.preview_material_changes).toMatchObject({ readOnlyHint: true });
    expect(hints.apply_material_changes).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("refuses every tool for anyone else, before any work", async () => {
    const { client, hcp } = await connect("someone");
    const calls: Array<[string, Record<string, unknown>]> = [["find_items", { query: "pex" }], ["check_write_access", {}], ["undo_change", { changeId: 1 }]];
    for (const [name, args] of calls) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(NOT_EDITOR_TEXT);
    }
    expect(hcp.updates).toEqual([]);
  });

  it("previews then applies a price change", async () => {
    const { client, hcp } = await connect(ELLA);
    const p = JSON.parse(text(await client.callTool({ name: "preview_material_changes", arguments: { items: [{ uuid: "m1", price: "2.75" }] } })));
    expect(p.previewId).toBeTruthy();
    expect(p.changes[0]).toMatchObject({ uuid: "m1", change: "price $2.50 → $2.75" });
    const a = JSON.parse(text(await client.callTool({ name: "apply_material_changes", arguments: { previewId: p.previewId } })));
    expect(a.applied).toHaveLength(1);
    expect(hcp.updates).toEqual([["m1", { price: 275 }]]);
  });

  it("explains a missing preview", async () => {
    const { client } = await connect(DAVE);
    const r = await client.callTool({ name: "apply_material_changes", arguments: { previewId: "nope" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/doesn't exist/);
  });

  it("routes service changes to the Slack checklist", async () => {
    const { client, slack } = await connect(DAVE);
    const r = JSON.parse(text(await client.callTool({ name: "request_service_changes", arguments: { items: [{ uuid: "s1", price: 195 }] } })));
    expect(r.requested[0]).toMatchObject({ name: "Drain cleaning" });
    expect(slack.posts).toHaveLength(1);
  });

  it("shows recent changes with who made them", async () => {
    const { client } = await connect(DAVE);
    const p = JSON.parse(text(await client.callTool({ name: "preview_material_changes", arguments: { items: [{ uuid: "m1", price: 3 }] } })));
    await client.callTool({ name: "apply_material_changes", arguments: { previewId: p.previewId } });
    const r = JSON.parse(text(await client.callTool({ name: "recent_changes", arguments: {} })));
    expect(r.changes[0]).toMatchObject({ item: "PEX tee", by: "Dave", status: "applied", change: "price $2.50 → $3.00" });
  });
});
```

Write `src/app/api/mcp/pricebook-edit/__tests__/route.test.ts` by copying `src/app/api/mcp/tasks/__tests__/route.test.ts` and substituting:
- `MCP_TASKS_ENABLED` → `MCP_PRICEBOOK_EDIT_ENABLED`
- `TASKS_RESOURCE` → `PRICEBOOK_EDIT_RESOURCE`
- `/api/mcp/tasks` → `/api/mcp/pricebook-edit`, in both the endpoint and metadata paths
- the "anyone but Dave" test → a non-editor caller gets `NOT_EDITOR_TEXT`

That test builds the server with `createPricebookEditMcpServer` and fakes, as in the server test: an `editors` map without the caller.

- [ ] **Step 2: Run the tests and confirm they fail.**

- [ ] **Step 3: Implement.** In `auth.ts`, after `TASKS_RESOURCE`:

```ts
export const PRICEBOOK_EDIT_RESOURCE: McpResource = {
  path: "/api/mcp/pricebook-edit",
  metadataPath: "/.well-known/oauth-protected-resource/api/mcp/pricebook-edit",
  name: "Trinity Plumbing price book editor (Dave and Ella)",
};
```

Create `src/lib/mcp/pricebookEdit/server.ts`:

```ts
// The "Trinity Price Book Editor" ChatGPT connector, for Dave and Ella only.
// Materials: preview → apply (HCP written directly), add, undo. Services:
// HCP's API can't change them, so they become a Slack checklist.
// Spec: docs/superpowers/specs/2026-11-21-pricebook-edit-design.md
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatMoney, searchPricebook } from "@/lib/mcp/pricebook";
import { EditError, addMaterial, applyPreview, checkWriteAccess, createPreview, type EditDeps } from "@/lib/pricebook/edit/apply";
import { describeChange } from "@/lib/pricebook/edit/changes";
import { NOT_EDITOR_TEXT } from "@/lib/pricebook/edit/deps";
import { requestServiceChanges, rerenderBatch, type ServiceDeps } from "@/lib/pricebook/edit/serviceChecklist";
import type { ChangeRow } from "@/lib/pricebook/edit/types";
import { undoChange } from "@/lib/pricebook/edit/undo";

export interface PricebookEditToolDeps {
  edit: EditDeps;
  service: ServiceDeps;
  editors: Map<string, string>;
  listCategories(): Promise<Array<{ uuid: string; name: string; parentUuid: string | null }>>;
  serviceConfigMissing(): string | null;
}

export const SERVER_INSTRUCTIONS = [
  "Trinity Price Book Editor changes Trinity Plumbing's Housecall Pro price book for Dave and Ella.",
  "Materials (parts) are changed directly: ALWAYS call preview_material_changes first, show the user the full old → new list and every warning, and call apply_material_changes only after they say yes to that exact preview.",
  "Services (flat-rate jobs) can't be changed through Housecall Pro's API: use request_service_changes, which posts them to a Slack checklist for Dave or Ella to make in HCP, and tell the user that.",
  "Use find_items to get ids; never invent ids. Prices are in dollars. Deleting items isn't possible here.",
  "If something was changed by mistake, use recent_changes to find it and undo_change to put it back.",
].join(" ");

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
type ToolResult = { isError?: boolean; content: { type: "text"; text: string }[] };
const json = (b: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(b, null, 2) }] });
const refuse = (t: string): ToolResult => ({ isError: true, content: [{ type: "text", text: t }] });
const MONEY = z.union([z.number(), z.string().max(20)]);

export function createPricebookEditMcpServer(deps: PricebookEditToolDeps, callerUserId: string | null): McpServer {
  const server = new McpServer({ name: "trinity-pricebook-edit", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  const editor = callerUserId !== null && deps.editors.has(callerUserId) ? callerUserId : null;
  const nameOf = (id: string) => deps.editors.get(id) ?? id;

  async function run(tool: string, body: (editorId: string) => Promise<ToolResult>): Promise<ToolResult> {
    if (!editor) return refuse(NOT_EDITOR_TEXT);
    try {
      return await body(editor);
    } catch (err) {
      if (err instanceof EditError) return refuse(err.message);
      console.error(`[mcp-pricebook-edit] ${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
      return refuse("Something went wrong on Trinity's side. Check recent_changes before retrying.");
    }
  }

  const view = (r: ChangeRow) => ({ id: r.id, batchId: r.batchId, when: r.createdAt, by: nameOf(r.requestedBy), kind: r.kind, item: r.itemName, change: describeChange(r.before, r.after), status: r.status, error: r.errorCode });

  server.registerTool("find_items", {
    title: "Find price book items",
    description: "Search services and materials by name, category or part number. Returns ids, kind, category, price, cost and description.",
    inputSchema: { query: z.string().min(1).max(200), kind: z.enum(["service", "material"]).optional() },
    annotations: READ,
  }, async ({ query, kind }) => run("find_items", async () => {
    const items = searchPricebook(await deps.edit.loadItems(), query, kind, 50);
    return json({ items: items.map((i) => ({ id: i.uuid, kind: i.kind, name: i.name, category: i.category, categoryId: i.categoryUuid ?? null, price: formatMoney(i.priceCents), cost: formatMoney(i.costCents), description: i.description, partNumber: i.partNumber })) });
  }));

  server.registerTool("list_categories", {
    title: "List material categories",
    description: "The material category tree with ids, for add_material.",
    inputSchema: {},
    annotations: READ,
  }, async () => run("list_categories", async () => json({ categories: await deps.listCategories() })));

  server.registerTool("recent_changes", {
    title: "Recent price book changes",
    description: "Changes made through this editor in the last `days` (default 7, max 30): who, when, what, status. Includes pending service changes.",
    inputSchema: { days: z.number().int().min(1).max(30).optional() },
    annotations: READ,
  }, async ({ days }) => run("recent_changes", async () => {
    const since = new Date(deps.edit.now().getTime() - (days ?? 7) * 86_400_000).toISOString();
    const rows = await deps.edit.store.listRecent(since, 100);
    const pending = await deps.edit.store.listPendingServices();
    return json({ changes: rows.map(view), pendingServiceChanges: pending.map(view) });
  }));

  server.registerTool("check_write_access", {
    title: "Check write access",
    description: "Saves one material back unchanged to check that the Housecall Pro API key can write. Changes nothing.",
    inputSchema: {},
    annotations: { ...WRITE, idempotentHint: true },
  }, async () => run("check_write_access", async () => {
    const r = await checkWriteAccess(deps.edit);
    return json(r.ok
      ? { ok: true, note: `The HCP key can write (tested on ${r.item}, nothing changed).` }
      : { ok: false, status: r.status, note: "The HCP API key can't write to the price book. Dave needs to make a key with write access in HCP." });
  }));

  const editSchema = z.object({
    uuid: z.string().min(1).max(200),
    price: MONEY.optional(),
    cost: MONEY.optional(),
    description: z.string().max(2000).optional(),
    name: z.string().min(1).max(200).optional(),
    partNumber: z.string().max(100).optional(),
    unit: z.string().max(50).optional(),
    taxable: z.boolean().optional(),
  });

  server.registerTool("preview_material_changes", {
    title: "Preview material changes",
    description: "Builds the exact old → new list for material changes, with warnings and blocks, and returns a previewId (valid 15 minutes). Changes nothing. Give `items` (per item) or `rule` (e.g. category + pricePercent).",
    inputSchema: {
      items: z.array(editSchema).max(50).optional(),
      rule: z.object({
        match: z.object({ query: z.string().max(200).optional(), category: z.string().max(200).optional() }),
        pricePercent: z.number().min(-90).max(500).optional(),
        costPercent: z.number().min(-90).max(500).optional(),
        round: z.enum(["cent", "dollar", "99"]).optional(),
      }).optional(),
      allowBelowCost: z.boolean().optional(),
    },
    annotations: READ,
  }, async (args) => run("preview_material_changes", async (editorId) => {
    const p = await createPreview(deps.edit, args, editorId);
    return json({
      previewId: p.previewId,
      expiresAt: p.expiresAt,
      changes: p.changes.map((c) => ({ uuid: c.uuid, name: c.name, category: c.category, change: describeChange(c.before, c.after), before: c.before, after: c.after })),
      warnings: p.warnings,
      blocks: p.blocks,
      note: p.previewId ? "Show this list to the user and apply only if they confirm." : "Nothing can be applied: fix the blocks (or there was nothing to change).",
    });
  }));

  server.registerTool("apply_material_changes", {
    title: "Apply material changes",
    description: "Applies a previewId from preview_material_changes in Housecall Pro. Only after the user confirmed that exact preview.",
    inputSchema: { previewId: z.string().min(1).max(100) },
    annotations: WRITE,
  }, async ({ previewId }) => run("apply_material_changes", async (editorId) => {
    const r = await applyPreview(deps.edit, previewId, editorId);
    return json({ ...r, note: "Applied in HCP. The read-only Trinity Price Book connector may show old values for up to 2 minutes. Undo with undo_change and this batchId." });
  }));

  server.registerTool("add_material", {
    title: "Add a material",
    description: "Creates a new material in a category (ids from list_categories). Checks price vs cost first. Can't be deleted afterwards.",
    inputSchema: {
      categoryUuid: z.string().min(1).max(200),
      name: z.string().min(1).max(200),
      price: MONEY,
      cost: MONEY.optional(),
      description: z.string().max(2000).optional(),
      unit: z.string().max(50).optional(),
      partNumber: z.string().max(100).optional(),
      taxable: z.boolean().optional(),
      allowBelowCost: z.boolean().optional(),
    },
    annotations: WRITE,
  }, async (args) => run("add_material", async (editorId) => json(await addMaterial(deps.edit, args, editorId))));

  server.registerTool("request_service_changes", {
    title: "Request service changes",
    description: "Housecall Pro's API can't change services. This records the wanted changes and posts them to the #pricebook-changes Slack checklist for Dave or Ella to make in HCP.",
    inputSchema: {
      items: z.array(z.object({
        uuid: z.string().min(1).max(200),
        price: MONEY.optional(),
        description: z.string().max(2000).optional(),
        name: z.string().min(1).max(200).optional(),
      })).min(1).max(50),
      allowBelowCost: z.boolean().optional(),
    },
    annotations: WRITE,
  }, async ({ items, allowBelowCost }) => run("request_service_changes", async (editorId) => {
    const missing = deps.serviceConfigMissing();
    if (missing) return refuse(`The Slack checklist isn't set up yet: ${missing}.`);
    return json(await requestServiceChanges(deps.service, items, editorId, { allowBelowCost }));
  }));

  server.registerTool("undo_change", {
    title: "Undo a change",
    description: "Puts back the old values for a change id or a whole batchId (from recent_changes), up to 30 days. Skips items changed since. Dismisses pending service requests.",
    inputSchema: { changeId: z.number().int().positive().optional(), batchId: z.string().min(1).max(100).optional() },
    annotations: WRITE,
  }, async ({ changeId, batchId }) => run("undo_change", async (editorId) => {
    if (changeId === undefined && !batchId) return refuse("Give a changeId or a batchId from recent_changes.");
    const r = await undoChange(deps.edit, { changeId, batchId }, editorId);
    for (const b of r.serviceBatches) await rerenderBatch(deps.service, b).catch(() => undefined);
    return json(r);
  }));

  return server;
}
```

Create `src/app/api/mcp/pricebook-edit/route.ts`:

```ts
// MCP endpoint for the Trinity Price Book Editor (Dave and Ella only; writes HCP materials).
// Spec: docs/superpowers/specs/2026-11-21-pricebook-edit-design.md
//
// Not covered by src/middleware.ts on purpose: ChatGPT has no cookie session.
// Every request must carry a Supabase-issued OAuth access token instead.
import { PRICEBOOK_EDIT_RESOURCE, supabaseClaimsVerifier, type ClaimsVerifier } from "@/lib/mcp/auth";
import { methodNotAllowed, serveMcp } from "@/lib/mcp/handler";
import { createPricebookEditMcpServer, type PricebookEditToolDeps } from "@/lib/mcp/pricebookEdit/server";
import { listAllCategories, liveEditDeps, liveServiceDeps, parseEditors, pricebookEditEnabled, serviceConfigMissing } from "@/lib/pricebook/edit/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

let verify: ClaimsVerifier | null = null;

function liveToolDeps(): PricebookEditToolDeps {
  const editors = parseEditors(process.env.MCP_PRICEBOOK_EDITORS);
  return { edit: liveEditDeps(), service: liveServiceDeps(editors), editors, listCategories: listAllCategories, serviceConfigMissing };
}

export async function POST(req: Request): Promise<Response> {
  if (!pricebookEditEnabled()) {
    return Response.json({ error: "disabled", message: "The Trinity Price Book Editor is turned off." }, { status: 503 });
  }
  verify ??= supabaseClaimsVerifier();
  return serveMcp(req, {
    verify,
    resource: PRICEBOOK_EDIT_RESOURCE,
    createServer: (caller) => createPricebookEditMcpServer(liveToolDeps(), caller.userId),
  });
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
```

Create `src/app/.well-known/oauth-protected-resource/api/mcp/pricebook-edit/route.ts`:

```ts
// RFC 9728 path-specific metadata for /api/mcp/pricebook-edit.
import { PRICEBOOK_EDIT_RESOURCE, metadataResponse } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return metadataResponse(req, PRICEBOOK_EDIT_RESOURCE);
}
```

- [ ] **Step 4: Run the tests and confirm they pass.**

Run: `npx vitest run src/lib/mcp src/app/api/mcp src/lib/pricebook src/__tests__/middleware.test.ts`
Then run `npx tsc --noEmit` (baseline only) and `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp src/app/api/mcp/pricebook-edit "src/app/.well-known/oauth-protected-resource/api/mcp/pricebook-edit"
git commit -m "feat(mcp): Trinity Price Book Editor connector for Dave and Ella"
```

---

### Task 8: Rollout doc and full verification

**Files:**
- Modify: `docs/SLACK-ROLLOUT.md` (append a new section at the end)

- [ ] **Step 1: Append this section:**

````markdown
## Price book editor — Trinity Price Book Editor (ChatGPT) and #pricebook-changes

Dave and Ella can change the HCP price book by asking ChatGPT. Materials
(parts) change directly — always previewed first, logged, and undoable for 30
days. Services can't be changed through HCP's API, so ChatGPT posts them to a
Slack checklist; whoever makes the change in HCP ticks it, and the app checks
HCP and replies in the thread if it doesn't match yet. Spec:
`docs/superpowers/specs/2026-11-21-pricebook-edit-design.md`.

### Go-live (Ryan)

1. Run `supabase/migrations/0009_pricebook_changes.sql` in the ops Supabase
   (`wrvaenkyrfvbooogqhev`) SQL editor — before merging is fine, it only adds
   tables.
2. Slack: create a **private** channel (e.g. `#pricebook-changes`), add Dave and
   Ella, `/invite @<the Trinity bot>`, and copy its channel ID (channel name →
   About → bottom, starts with `C`). The Interactivity URL is already set from
   the Fieldy rollout — nothing to change in the Slack app.
3. Vercel → Production:
   - `MCP_PRICEBOOK_EDIT_ENABLED=true`
   - `MCP_PRICEBOOK_EDITORS` — `<Dave's Supabase user id>:Dave,<Ella's>:Ella`
     (Supabase → Authentication → Users → User UID)
   - `SLACK_PRICEBOOK_CHANNEL_ID` — the `C…` id
   - `SLACK_PRICEBOOK_ALLOWED_USERS` — Dave's and Ella's Slack member ids,
     comma-separated (profile → ⋮ → Copy member ID)

   Redeploy.
4. ChatGPT (Trinity workspace) → Plugins → Add custom MCP server: name
   `Trinity Price Book Editor`, URL
   `https://ops.trinity.plumbing/api/mcp/pricebook-edit`, OAuth. Publish; Dave
   and Ella connect with their ops logins.
5. In ChatGPT: "check write access". If it says the key can't write, Dave makes
   an HCP API key with write access and Ryan replaces `HOUSECALL_API_KEY`.
6. Try it: change one part's price → undo it; preview +1% on a small category →
   apply; request one service change → make it in HCP → tick it in Slack.

### If something's off

| What you see | Cause |
|---|---|
| "only available to Dave and Ella" for one of them | Their Supabase user id isn't in `MCP_PRICEBOOK_EDITORS` |
| "The HCP API key can't write" | The key is read-only — make one with write access in HCP |
| "That preview expired" | Previews last 15 minutes — preview again |
| A service tick does nothing | `MCP_PRICEBOOK_EDIT_ENABLED` is off, or the bot isn't in the channel |
| "HCP still shows $…" in the thread | The change isn't saved in HCP yet, or there's a typo — fix it in HCP, then untick and tick again |

### Rollback

Set `MCP_PRICEBOOK_EDIT_ENABLED` to anything but `true` and redeploy. Nothing
already changed in HCP is reverted; use `undo_change` first if needed.
````

- [ ] **Step 2: Full verification**

Run these and record each summary:
- `npx vitest run`: all pass.
- `npx tsc --noEmit`: the 8 baseline errors only.
- `npm run lint`: clean.
- `npm run build`: passes, and lists `/api/mcp/pricebook-edit` and `/.well-known/oauth-protected-resource/api/mcp/pricebook-edit`.

- [ ] **Step 3: Audit the logging.** Run `git diff origin/main -- src | grep -n "console\."`. Every new log line should be a fixed prefix plus an error message or code, with no price book text, key or `response_url`.

- [ ] **Step 4: Commit**

```bash
git add docs/SLACK-ROLLOUT.md
git commit -m "docs: price book editor rollout"
```
