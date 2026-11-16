# ChatGPT Jobs & Customers Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, read-only ChatGPT MCP connector at `/api/mcp/jobs` that looks up customers, job history, single jobs, the schedule and a money summary from the Supabase mirror.

**Architecture:** The existing price book connector's auth helpers and request handler are generalized to take a "resource" (endpoint path, metadata path, display name), with defaults that keep the price book's behavior identical. A new `createJobsMcpServer(deps)` registers 5 tools that wrap the existing query functions, injected through a `JobsDeps` object so tests never touch Supabase. A new route serves it behind the `MCP_JOBS_ENABLED` kill switch, with its own RFC 9728 metadata document.

**Tech Stack:** Next.js 14 App Router (route handlers, Node runtime), `@modelcontextprotocol/sdk` 1.32 (`McpServer`, `WebStandardStreamableHTTPServerTransport`), `zod` 4, Supabase Auth (OAuth 2.1 server, beta), Vitest 4.

**Spec:** `docs/superpowers/specs/2026-11-17-chatgpt-jobs-connector-design.md`

## Global Constraints

- **Read-only.** No writes to HouseCall Pro or Supabase anywhere in this code.
- Every tool is annotated `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`.
- Endpoint path `/api/mcp/jobs`. Metadata path `/.well-known/oauth-protected-resource/api/mcp/jobs`. Display name `Trinity Plumbing jobs & customers (read-only)`.
- Kill switch `MCP_JOBS_ENABLED`: on only when exactly `"true"`. When off, return 503 **before** the token check, and run no query.
- **The price book connector must not change.** `/api/mcp` behavior, its 4 tools, its metadata JSON and every existing test in `src/app/api/mcp/__tests__/route.test.ts`, `src/lib/mcp/__tests__/auth.test.ts` and `src/lib/mcp/__tests__/server.test.ts` stay as they are and keep passing.
- Money is shown as `formatMoney(cents)` from `src/lib/mcp/pricebook.ts` (`"$1,234.50"`, `"n/a"` for null) **plus** the raw cents value.
- Every tool result is JSON text containing `dataAsOf` (from `mirrorSyncedAt`, or `null`).
- A query failure returns `isError: true` with a short fixed message. **Never** the raw error text: it can contain customer rows.
- No new date arithmetic. Use `localDateKey` (`src/lib/notifications/schedule.ts`), `dayLabelFromKey` and `timeLabel` (`src/lib/slack/format.ts`), and the existing `T16:00:00Z` anchor trick from `src/lib/slack/commands.ts`.
- No middleware change. `src/middleware.ts`'s matcher must not gain any entry starting with `/api/mcp` or `/.well-known`.
- Work only in the worktree `d:/TrinityPlumbing/.worktrees/housecallpro-chatgpt-jobs` on branch `feat/chatgpt-jobs`. All commands below run from that directory.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/mcp/auth.ts` | Modify | Add `McpResource`, `PRICEBOOK_RESOURCE`, `JOBS_RESOURCE`, `metadataResponse()`. Optional `resource` parameter on `protectedResourceMetadata` and `wwwAuthenticate`. |
| `src/app/.well-known/oauth-protected-resource/route.ts` | Modify | Delegate to `metadataResponse(req, PRICEBOOK_RESOURCE)` |
| `src/lib/mcp/handler.ts` | Modify | Add generic `serveMcp()` and `methodNotAllowed()`. `handleMcpRequest()` becomes a thin price book wrapper with the same signature. |
| `src/lib/slack/format.ts` | Modify | `export` the existing `timeLabel` (no behavior change) |
| `src/lib/mcp/jobs/server.ts` | Create | `JobsDeps` type and `createJobsMcpServer(deps)` with the 5 tools |
| `src/lib/mcp/jobs/deps.ts` | Create | `liveJobsDeps()` (real query functions) and `mcpJobsEnabled()` |
| `src/app/api/mcp/jobs/route.ts` | Create | POST (kill switch → `serveMcp`), GET/DELETE 405 |
| `src/app/.well-known/oauth-protected-resource/api/mcp/jobs/route.ts` | Create | `metadataResponse(req, JOBS_RESOURCE)` |
| `src/lib/mcp/jobs/__tests__/fixtures.ts` | Create | Sample rows and `stubDeps()` shared by the jobs tests |
| `src/lib/mcp/jobs/__tests__/server.test.ts` | Create | Tool behavior |
| `src/lib/mcp/__tests__/handler.test.ts` | Create | `serveMcp` with a non-default resource |
| `src/app/api/mcp/jobs/__tests__/route.test.ts` | Create | Kill switch, 401 challenge, end-to-end tools, 405, metadata |
| `README.md`, `.env.example` | Modify | Setup notes and the new env var |

---

### Task 1: Generalize the auth helpers to a "resource"

**Files:**
- Modify: `src/lib/mcp/auth.ts:6-7` and `:63-76`
- Modify: `src/app/.well-known/oauth-protected-resource/route.ts`
- Test: `src/lib/mcp/__tests__/auth.test.ts`, `src/app/api/mcp/__tests__/route.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (in `src/lib/mcp/auth.ts`):
  - `export interface McpResource { path: string; metadataPath: string; name: string }`
  - `export const PRICEBOOK_RESOURCE: McpResource` (`/api/mcp`, `/.well-known/oauth-protected-resource`, `"Trinity Plumbing price book (read-only)"`)
  - `export const JOBS_RESOURCE: McpResource` (`/api/mcp/jobs`, `/.well-known/oauth-protected-resource/api/mcp/jobs`, `"Trinity Plumbing jobs & customers (read-only)"`)
  - `protectedResourceMetadata(origin: string, supabaseUrl: string, resource: McpResource = PRICEBOOK_RESOURCE)`
  - `wwwAuthenticate(origin: string, invalidToken: boolean, resource: McpResource = PRICEBOOK_RESOURCE): string`
  - `metadataResponse(req: Request, resource: McpResource): Response`

- [ ] **Step 1: Install dependencies and record the baseline**

The worktree is new and has no `node_modules`.

Run: `npm ci && npx vitest run`
Expected: install succeeds; all existing tests PASS. If anything fails here, stop and report it: it's a pre-existing failure, not something this plan caused.

- [ ] **Step 2: Pin the price book metadata JSON (regression test, should already pass)**

Add this test inside the existing `describe("/.well-known/oauth-protected-resource", ...)` block in `src/app/api/mcp/__tests__/route.test.ts`:

```ts
  // Pinned to the exact bytes served before the jobs connector existed. The
  // jobs work refactors the helpers behind this route; ChatGPT has already
  // registered against this document, so it must not move.
  it("serves exactly the same price book metadata as before", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    const res = metadataGET(new Request("https://ops.example.com/.well-known/oauth-protected-resource"));
    expect(await res.text()).toBe(
      '{"resource":"https://ops.example.com/api/mcp","authorization_servers":["https://abc.supabase.co/auth/v1"],"scopes_supported":["openid","email","profile"],"bearer_methods_supported":["header"],"resource_name":"Trinity Plumbing price book (read-only)"}'
    );
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });
```

Run: `npx vitest run src/app/api/mcp/__tests__/route.test.ts`
Expected: PASS (it pins current behavior).

- [ ] **Step 3: Write the failing tests for the resource parameter**

Replace the two import lines at the top of `src/lib/mcp/__tests__/auth.test.ts` (the `vitest` import and the `../auth` import) with:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  verifyMcpToken,
  protectedResourceMetadata,
  requestOrigin,
  wwwAuthenticate,
  metadataResponse,
  JOBS_RESOURCE,
  PRICEBOOK_RESOURCE,
} from "../auth";
```

Append to the end of the file:

```ts
describe("per-connector resources", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to the price book resource", () => {
    expect(protectedResourceMetadata("https://o.example", "https://abc.supabase.co")).toEqual(
      protectedResourceMetadata("https://o.example", "https://abc.supabase.co", PRICEBOOK_RESOURCE)
    );
    expect(wwwAuthenticate("https://o.example", false)).toBe(
      wwwAuthenticate("https://o.example", false, PRICEBOOK_RESOURCE)
    );
  });

  it("describes the jobs connector at its own path", () => {
    expect(protectedResourceMetadata("https://o.example", "https://abc.supabase.co", JOBS_RESOURCE)).toEqual({
      resource: "https://o.example/api/mcp/jobs",
      authorization_servers: ["https://abc.supabase.co/auth/v1"],
      scopes_supported: ["openid", "email", "profile"],
      bearer_methods_supported: ["header"],
      resource_name: "Trinity Plumbing jobs & customers (read-only)",
    });
  });

  it("points the jobs challenge at the jobs metadata document", () => {
    expect(wwwAuthenticate("https://o.example", false, JOBS_RESOURCE)).toBe(
      'Bearer resource_metadata="https://o.example/.well-known/oauth-protected-resource/api/mcp/jobs"'
    );
    expect(wwwAuthenticate("https://o.example", true, JOBS_RESOURCE)).toBe(
      'Bearer error="invalid_token", resource_metadata="https://o.example/.well-known/oauth-protected-resource/api/mcp/jobs"'
    );
  });

  it("builds the metadata response, and fails closed without Supabase", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    const res = metadataResponse(new Request("https://o.example/x"), JOBS_RESOURCE);
    expect(res.status).toBe(200);
    expect((await res.json()).resource).toBe("https://o.example/api/mcp/jobs");

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(metadataResponse(new Request("https://o.example/x"), JOBS_RESOURCE).status).toBe(500);
  });
});
```

Run: `npx vitest run src/lib/mcp/__tests__/auth.test.ts`
Expected: FAIL (`JOBS_RESOURCE`, `PRICEBOOK_RESOURCE` and `metadataResponse` are not exported).

- [ ] **Step 4: Implement**

In `src/lib/mcp/auth.ts`, directly below the existing `MCP_PATH` and `RESOURCE_METADATA_PATH` constants (keep both), add:

```ts
// One protected resource per ChatGPT connector. Each has its own endpoint and
// its own RFC 9728 metadata document, and the 401 challenge names the right
// one, so ChatGPT registers each connector separately. Both use the same
// Supabase authorization server and the same token check.
export interface McpResource {
  /** The MCP endpoint path, e.g. "/api/mcp". */
  path: string;
  /** Where that endpoint's protected-resource metadata is served. */
  metadataPath: string;
  /** Shown to users as the connector's name. */
  name: string;
}

export const PRICEBOOK_RESOURCE: McpResource = {
  path: MCP_PATH,
  metadataPath: RESOURCE_METADATA_PATH,
  name: "Trinity Plumbing price book (read-only)",
};

export const JOBS_RESOURCE: McpResource = {
  path: "/api/mcp/jobs",
  metadataPath: "/.well-known/oauth-protected-resource/api/mcp/jobs",
  name: "Trinity Plumbing jobs & customers (read-only)",
};
```

Replace the existing `protectedResourceMetadata` and `wwwAuthenticate` functions (keep the key order exactly as shown, because the pinned test compares bytes):

```ts
export function protectedResourceMetadata(
  origin: string,
  supabaseUrl: string,
  resource: McpResource = PRICEBOOK_RESOURCE
) {
  return {
    resource: `${origin}${resource.path}`,
    authorization_servers: [`${supabaseUrl.replace(/\/+$/, "")}/auth/v1`],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
    resource_name: resource.name,
  };
}

export function wwwAuthenticate(
  origin: string,
  invalidToken: boolean,
  resource: McpResource = PRICEBOOK_RESOURCE
): string {
  const meta = `resource_metadata="${origin}${resource.metadataPath}"`;
  return invalidToken ? `Bearer error="invalid_token", ${meta}` : `Bearer ${meta}`;
}

// The body of every protected-resource metadata route. Fails closed when the
// Supabase URL is missing rather than advertising an authorization server
// that doesn't exist.
export function metadataResponse(req: Request, resource: McpResource): Response {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }
  return Response.json(protectedResourceMetadata(requestOrigin(req), supabaseUrl, resource), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
```

Replace the whole of `src/app/.well-known/oauth-protected-resource/route.ts` with:

```ts
// RFC 9728 protected-resource metadata. ChatGPT reads this after its first
// 401 from /api/mcp to learn that Supabase Auth is where users sign in.
import { metadataResponse, PRICEBOOK_RESOURCE } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return metadataResponse(req, PRICEBOOK_RESOURCE);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/mcp src/app/api/mcp`
Expected: all PASS, including the pinned metadata test and every pre-existing test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mcp/auth.ts src/lib/mcp/__tests__/auth.test.ts "src/app/.well-known/oauth-protected-resource/route.ts" src/app/api/mcp/__tests__/route.test.ts
git commit -m "refactor(mcp): describe each connector as a protected resource"
```

---

### Task 2: Generic `serveMcp` handler

**Files:**
- Modify: `src/lib/mcp/handler.ts`
- Test: `src/lib/mcp/__tests__/handler.test.ts` (create)

**Interfaces:**
- Consumes: `McpResource`, `PRICEBOOK_RESOURCE`, `JOBS_RESOURCE`, `wwwAuthenticate(origin, invalid, resource)` from Task 1.
- Produces (in `src/lib/mcp/handler.ts`):
  - `export interface ServeMcpDeps { verify: ClaimsVerifier; resource: McpResource; createServer: () => McpServer }`
  - `export async function serveMcp(req: Request, deps: ServeMcpDeps): Promise<Response>`
  - `export function methodNotAllowed(): Response` (405 JSON-RPC error, `Allow: POST`)
  - `handleMcpRequest(req, { verify, load })` keeps its current signature and behavior.

- [ ] **Step 1: Write the failing test**

Create `src/lib/mcp/__tests__/handler.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { methodNotAllowed, serveMcp } from "../handler";
import { JOBS_RESOURCE } from "../auth";

const goodVerify = async () => ({ sub: "u1", role: "authenticated", client_id: "c1" });

function tinyServer() {
  const s = new McpServer({ name: "tiny", version: "1.0.0" });
  s.registerTool("ping", { description: "Reply with pong.", inputSchema: {} }, async () => ({
    content: [{ type: "text" as const, text: "pong" }],
  }));
  return s;
}

function rpc(body: unknown, auth?: string) {
  return new Request("https://ops.example.com/api/mcp/jobs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

const deps = { verify: goodVerify, resource: JOBS_RESOURCE, createServer: tinyServer };

describe("serveMcp", () => {
  it("challenges with the resource's own metadata URL", async () => {
    const res = await serveMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/jobs"'
    );
  });

  it("marks a rejected token as invalid_token", async () => {
    const res = await serveMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "Bearer x"), {
      ...deps,
      verify: async () => null,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token", resource_metadata=".*\/api\/mcp\/jobs"$/);
  });

  it("serves the server it was given", async () => {
    const res = await serveMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "Bearer ok"), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).result.tools.map((t: { name: string }) => t.name)).toEqual(["ping"]);
  });

  it("builds a 405 for stateless servers", async () => {
    const res = methodNotAllowed();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
```

Run: `npx vitest run src/lib/mcp/__tests__/handler.test.ts`
Expected: FAIL (`serveMcp` and `methodNotAllowed` are not exported).

- [ ] **Step 2: Implement**

Replace the whole of `src/lib/mcp/handler.ts` with:

```ts
// Request handling for the ChatGPT MCP endpoints, kept out of the route files
// because Next.js only allows HTTP-method and config exports from route.ts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  PRICEBOOK_RESOURCE,
  requestOrigin,
  verifyMcpToken,
  wwwAuthenticate,
  type ClaimsVerifier,
  type McpResource,
} from "./auth";
import type { PricebookLoader } from "./pricebook";
import { createPricebookMcpServer } from "./server";

export interface ServeMcpDeps {
  verify: ClaimsVerifier;
  resource: McpResource;
  createServer: () => McpServer;
}

export async function serveMcp(req: Request, deps: ServeMcpDeps): Promise<Response> {
  const header = req.headers.get("authorization");
  const caller = await verifyMcpToken(header, deps.verify);
  if (!caller) {
    return Response.json(
      { error: header ? "invalid_token" : "unauthorized" },
      {
        status: 401,
        headers: { "WWW-Authenticate": wwwAuthenticate(requestOrigin(req), Boolean(header), deps.resource) },
      }
    );
  }

  // Stateless: a fresh server and transport per request, plain JSON replies.
  const server = deps.createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, {
      authInfo: { token: caller.token, clientId: caller.clientId, scopes: [], extra: { userId: caller.userId } },
    });
  } finally {
    await server.close();
  }
}

// The price book connector's entry point, unchanged for its route and tests.
export async function handleMcpRequest(
  req: Request,
  deps: { verify: ClaimsVerifier; load: PricebookLoader }
): Promise<Response> {
  return serveMcp(req, {
    verify: deps.verify,
    resource: PRICEBOOK_RESOURCE,
    createServer: () => createPricebookMcpServer(deps.load),
  });
}

// Stateless servers have no SSE stream to open and no session to delete.
export function methodNotAllowed(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
    { status: 405, headers: { Allow: "POST" } }
  );
}
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/lib/mcp src/app/api/mcp`
Expected: all PASS, including the unchanged `/api/mcp` route tests.

- [ ] **Step 4: Commit**

```bash
git add src/lib/mcp/handler.ts src/lib/mcp/__tests__/handler.test.ts
git commit -m "refactor(mcp): serve any connector through one handler"
```

---

### Task 3: Jobs server with the customer and job tools

**Files:**
- Create: `src/lib/mcp/jobs/server.ts`
- Create: `src/lib/mcp/jobs/__tests__/fixtures.ts`
- Create: `src/lib/mcp/jobs/__tests__/server.test.ts`
- Modify: `src/lib/slack/format.ts` (add `export` to `function timeLabel`)

**Interfaces:**
- Consumes: `formatMoney(cents: number | null): string` from `src/lib/mcp/pricebook.ts`; `localDateKey(now: Date): string` from `src/lib/notifications/schedule.ts`; `timeLabel(iso: string | null): string` from `src/lib/slack/format.ts`; types `CustomerHit`, `CustomerDetail` (`src/lib/mobile/customers.ts`), `JobDetail` (`src/lib/mobile/jobDetail.ts`), `EstimateHit`, `InvoiceHit` (`src/lib/mobile/money.ts`), `MirrorResource` (`src/lib/mobile/mirrorFreshness.ts`), `TodayScheduleRow`, `DashboardSnapshot` (`src/lib/dashboard/queries.ts`).
- Produces (in `src/lib/mcp/jobs/server.ts`):
  ```ts
  export interface ScheduleDay { dateKey: string; rows: TodayScheduleRow[] }
  export type Revenue = Pick<DashboardSnapshot, "revenueBookedThisWeekCents" | "revenueScheduledNextWeekCents">;
  export interface JobsDeps {
    searchCustomers(query: string): Promise<CustomerHit[]>;
    getCustomerDetail(id: string): Promise<CustomerDetail | null>;
    getJobDetail(id: string): Promise<JobDetail | null>;
    getScheduleDays(anchor: Date, days: number): Promise<ScheduleDay[]>;
    listOpenEstimates(): Promise<EstimateHit[]>;
    listUnpaidInvoices(): Promise<InvoiceHit[]>;
    getRevenue(): Promise<Revenue>;
    mirrorSyncedAt(resources: MirrorResource[]): Promise<string | null>;
    now(): Date;
  }
  export function createJobsMcpServer(deps: JobsDeps): McpServer; // server name "trinity-jobs"
  ```
  This task registers `find_customer`, `get_customer_history`, `get_job`. Tasks 4 and 5 add `get_schedule` and `get_money_summary` to the same function.
- Produces (in `src/lib/mcp/jobs/__tests__/fixtures.ts`): `CUSTOMER_HIT`, `CUSTOMER_DETAIL`, `JOB_DETAIL`, `SYNCED_AT`, `NOW`, `scheduleRow(over)`, `stubDeps(over?: Partial<JobsDeps>): { deps: JobsDeps; freshnessCalls: MirrorResource[][] }`, `connect(deps)`, `text(result)`.

- [ ] **Step 1: Export `timeLabel`**

In `src/lib/slack/format.ts`, change `function timeLabel(iso: string | null): string {` to `export function timeLabel(iso: string | null): string {`. Change nothing else.

- [ ] **Step 2: Create the shared test fixtures**

Create `src/lib/mcp/jobs/__tests__/fixtures.ts`:

```ts
// Sample rows and a stubbed JobsDeps for the jobs connector tests. Synthetic
// data only: no real customers.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CustomerDetail, CustomerHit } from "@/lib/mobile/customers";
import type { JobDetail } from "@/lib/mobile/jobDetail";
import type { MirrorResource } from "@/lib/mobile/mirrorFreshness";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { createJobsMcpServer, type JobsDeps } from "../server";

export const SYNCED_AT = "2026-11-17T12:45:00.000Z";
// 8:00 AM Eastern on Tue Nov 17 2026.
export const NOW = new Date("2026-11-17T13:00:00.000Z");

export const CUSTOMER_HIT: CustomerHit = {
  id: "cus_1",
  name: "Pat Example",
  phone: "5185550142",
  address: "12 Elm St, Averill Park",
};

export const CUSTOMER_DETAIL: CustomerDetail = {
  ...CUSTOMER_HIT,
  company: null,
  email: "pat@example.com",
  lifetimeCents: 52500,
  jobs: [
    // 9:30 AM Eastern on Nov 10.
    { id: "job_1", scheduledStart: "2026-11-10T14:30:00Z", service: "Drain cleaning", status: "Completed", amountCents: 17500 },
    { id: "job_2", scheduledStart: null, service: "Water heater repair", status: "Needs Scheduling", amountCents: null },
  ],
};

export const JOB_DETAIL: JobDetail = {
  id: "job_1",
  customerId: "cus_1",
  customerName: "Pat Example",
  customerPhone: "5185550142",
  scheduledStart: "2026-11-10T14:30:00Z",
  scheduledEnd: "2026-11-10T16:00:00Z",
  address: "12 Elm St, Averill Park",
  technicianName: "Dan Tech",
  service: "Drain cleaning",
  status: "Completed",
  amountCents: 17500,
  invoice: { id: "inv_1", status: "paid", amountCents: 17500 },
  notes: [{ content: "Cabled the main line.", author: "Dan Tech", createdAt: "2026-11-10T16:05:00Z" }],
};

export function scheduleRow(over: Partial<TodayScheduleRow>): TodayScheduleRow {
  return {
    id: "job_9",
    scheduledStart: "2026-11-17T14:30:00Z",
    customerName: "Pat Example",
    technicianName: "Dan Tech",
    zone: "Averill Park",
    compass: "E",
    miles: 3,
    driveMinutes: 8,
    address: "12 Elm St, Averill Park",
    service: "Drain cleaning",
    customerPhone: "5185550142",
    status: "Scheduled",
    lat: 42.6,
    lng: -73.5,
    ...over,
  };
}

export function stubDeps(over: Partial<JobsDeps> = {}) {
  const freshnessCalls: MirrorResource[][] = [];
  const deps: JobsDeps = {
    searchCustomers: async () => [CUSTOMER_HIT],
    getCustomerDetail: async (id) => (id === CUSTOMER_DETAIL.id ? CUSTOMER_DETAIL : null),
    getJobDetail: async (id) => (id === JOB_DETAIL.id ? JOB_DETAIL : null),
    getScheduleDays: async () => [],
    listOpenEstimates: async () => [],
    listUnpaidInvoices: async () => [],
    getRevenue: async () => ({ revenueBookedThisWeekCents: 0, revenueScheduledNextWeekCents: 0 }),
    mirrorSyncedAt: async (resources) => {
      freshnessCalls.push(resources);
      return SYNCED_AT;
    },
    now: () => NOW,
    ...over,
  };
  return { deps, freshnessCalls };
}

export async function connect(deps: JobsDeps) {
  const server = createJobsMcpServer(deps);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

export function text(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0].text;
}
```

- [ ] **Step 3: Write the failing tests**

Create `src/lib/mcp/jobs/__tests__/server.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { CUSTOMER_HIT, SYNCED_AT, connect, stubDeps, text } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

describe("createJobsMcpServer: customers and jobs", () => {
  it("marks every tool read-only", async () => {
    const client = await connect(stubDeps().deps);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("finds customers and stamps the customers sync time", async () => {
    const queries: string[] = [];
    const { deps, freshnessCalls } = stubDeps({
      searchCustomers: async (q) => {
        queries.push(q);
        return [CUSTOMER_HIT];
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "find_customer", arguments: { query: "pat" } })));
    expect(queries).toEqual(["pat"]);
    expect(body).toMatchObject({ query: "pat", count: 1, dataAsOf: SYNCED_AT });
    expect(body.customers[0]).toEqual(CUSTOMER_HIT);
    expect(freshnessCalls).toEqual([["customers"]]);
  });

  it("returns a customer's history with dates and money", async () => {
    const { deps, freshnessCalls } = stubDeps();
    const client = await connect(deps);
    const body = JSON.parse(
      text(await client.callTool({ name: "get_customer_history", arguments: { customerId: "cus_1" } }))
    );
    expect(body.found).toBe(true);
    expect(body.customer).toMatchObject({ id: "cus_1", name: "Pat Example", email: "pat@example.com" });
    expect(body).toMatchObject({ lifetime: "$525.00", lifetimeCents: 52500, jobCount: 2 });
    expect(body.jobs[0]).toEqual({
      id: "job_1",
      date: "2026-11-10",
      scheduledStart: "2026-11-10T14:30:00Z",
      service: "Drain cleaning",
      status: "Completed",
      amount: "$175.00",
      amountCents: 17500,
    });
    expect(body.jobs[1]).toMatchObject({ date: null, amount: "n/a", amountCents: null });
    expect(freshnessCalls).toEqual([["customers", "jobs"]]);
  });

  it("says when a customer doesn't exist, without an error", async () => {
    const client = await connect(stubDeps().deps);
    const res = await client.callTool({ name: "get_customer_history", arguments: { customerId: "nope" } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(text(res));
    expect(body.found).toBe(false);
    expect(body.note).toMatch(/find_customer/);
  });

  it("returns one job with its local time, invoice and notes", async () => {
    const { deps, freshnessCalls } = stubDeps();
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "get_job", arguments: { jobId: "job_1" } })));
    expect(body.found).toBe(true);
    expect(body.job).toMatchObject({
      id: "job_1",
      customerName: "Pat Example",
      technician: "Dan Tech",
      date: "2026-11-10",
      time: "9:30 AM",
      amount: "$175.00",
      amountCents: 17500,
      invoice: { id: "inv_1", status: "paid", amount: "$175.00", amountCents: 17500 },
    });
    expect(body.job.notes).toEqual([
      { content: "Cabled the main line.", author: "Dan Tech", createdAt: "2026-11-10T16:05:00Z" },
    ]);
    expect(freshnessCalls).toEqual([["jobs", "invoices"]]);
  });

  it("says when a job doesn't exist, without an error", async () => {
    const client = await connect(stubDeps().deps);
    const res = await client.callTool({ name: "get_job", arguments: { jobId: "nope" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res)).found).toBe(false);
  });

  it("hides the raw error when a query fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = stubDeps({
      getCustomerDetail: async () => {
        throw new Error("customers query failed: Pat Example, 12 Elm St");
      },
    });
    const client = await connect(deps);
    const res = await client.callTool({ name: "get_customer_history", arguments: { customerId: "cus_1" } });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toMatch(/Pat Example|Elm/);
    expect(text(res)).toMatch(/Try again/);
  });

  it("still answers when the sync time can't be read", async () => {
    const { deps } = stubDeps({ mirrorSyncedAt: async () => null });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "find_customer", arguments: { query: "pat" } })));
    expect(body.dataAsOf).toBeNull();
  });
});
```

Run: `npx vitest run src/lib/mcp/jobs`
Expected: FAIL (`../server` does not exist).

- [ ] **Step 4: Implement**

Create `src/lib/mcp/jobs/server.ts`:

```ts
// The MCP server for the ChatGPT jobs & customers connector: read-only lookups
// over Trinity's Supabase copy of HouseCall Pro. Every tool wraps an existing
// query function; nothing here queries the database itself.
// Spec: docs/superpowers/specs/2026-11-17-chatgpt-jobs-connector-design.md
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CustomerDetail, CustomerHit } from "@/lib/mobile/customers";
import type { JobDetail } from "@/lib/mobile/jobDetail";
import type { EstimateHit, InvoiceHit } from "@/lib/mobile/money";
import type { MirrorResource } from "@/lib/mobile/mirrorFreshness";
import type { DashboardSnapshot, TodayScheduleRow } from "@/lib/dashboard/queries";
import { localDateKey } from "@/lib/notifications/schedule";
import { timeLabel } from "@/lib/slack/format";
import { formatMoney } from "@/lib/mcp/pricebook";

export interface ScheduleDay {
  dateKey: string;
  rows: TodayScheduleRow[];
}

export type Revenue = Pick<DashboardSnapshot, "revenueBookedThisWeekCents" | "revenueScheduledNextWeekCents">;

// Injected so tests can stub every lookup without touching Supabase.
export interface JobsDeps {
  searchCustomers(query: string): Promise<CustomerHit[]>;
  getCustomerDetail(id: string): Promise<CustomerDetail | null>;
  getJobDetail(id: string): Promise<JobDetail | null>;
  getScheduleDays(anchor: Date, days: number): Promise<ScheduleDay[]>;
  listOpenEstimates(): Promise<EstimateHit[]>;
  listUnpaidInvoices(): Promise<InvoiceHit[]>;
  getRevenue(): Promise<Revenue>;
  mirrorSyncedAt(resources: MirrorResource[]): Promise<string | null>;
  now(): Date;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const SOURCE_NOTE =
  "Data comes from Trinity's copy of HouseCall Pro, updated about every 15 minutes; dataAsOf is when it was last synced. Read-only.";

type ToolResult = { isError?: boolean; content: { type: "text"; text: string }[] };

function dateOf(iso: string | null): string | null {
  return iso ? localDateKey(new Date(iso)) : null;
}

// Every successful result carries the age of the data it came from.
async function ok(deps: JobsDeps, resources: MirrorResource[], body: Record<string, unknown>): Promise<ToolResult> {
  const dataAsOf = await deps.mirrorSyncedAt(resources).catch(() => null);
  return { content: [{ type: "text", text: JSON.stringify({ ...body, dataAsOf }, null, 2) }] };
}

// A fixed message for ChatGPT; the real error goes to the server log only. The
// query layer's error text can include customer rows, so it never leaves here.
function fail(tool: string, message: string, err: unknown): ToolResult {
  console.error(`[mcp-jobs] ${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function createJobsMcpServer(deps: JobsDeps): McpServer {
  const server = new McpServer({ name: "trinity-jobs", version: "1.0.0" });

  server.registerTool(
    "find_customer",
    {
      title: "Find customer",
      description: `Find Trinity Plumbing customers by name or phone number. Returns up to 25 matches, each with the id that get_customer_history needs. ${SOURCE_NOTE}`,
      inputSchema: {
        query: z.string().min(1).max(100).describe("A name or phone number, e.g. 'Smith' or '518 555 0142'."),
      },
      annotations: READ_ONLY,
    },
    async ({ query }) => {
      try {
        const customers = await deps.searchCustomers(query);
        return await ok(deps, ["customers"], { query, count: customers.length, customers });
      } catch (err) {
        return fail("find_customer", "Couldn't search customers just now. Try again in a minute.", err);
      }
    }
  );

  server.registerTool(
    "get_customer_history",
    {
      title: "Customer history",
      description: `One customer's contact details, lifetime spend and every job Trinity has done or scheduled for them. Get the id from find_customer. ${SOURCE_NOTE}`,
      inputSchema: {
        customerId: z.string().min(1).max(100).describe("The customer id from find_customer."),
      },
      annotations: READ_ONLY,
    },
    async ({ customerId }) => {
      try {
        const c = await deps.getCustomerDetail(customerId);
        if (!c) {
          return await ok(deps, ["customers"], {
            found: false,
            customerId,
            note: "No customer with that id. Use find_customer to look up the id.",
          });
        }
        return await ok(deps, ["customers", "jobs"], {
          found: true,
          customer: { id: c.id, name: c.name, company: c.company, phone: c.phone, email: c.email, address: c.address },
          lifetime: formatMoney(c.lifetimeCents),
          lifetimeCents: c.lifetimeCents,
          jobCount: c.jobs.length,
          jobs: c.jobs.map((j) => ({
            id: j.id,
            date: dateOf(j.scheduledStart),
            scheduledStart: j.scheduledStart,
            service: j.service,
            status: j.status,
            amount: formatMoney(j.amountCents),
            amountCents: j.amountCents,
          })),
        });
      } catch (err) {
        return fail("get_customer_history", "Couldn't read that customer's history just now. Try again in a minute.", err);
      }
    }
  );

  server.registerTool(
    "get_job",
    {
      title: "Job details",
      description: `One job in full: customer, address, technician, date and time (Eastern), service, status, amount, invoice and the notes written on it. Job ids come from get_customer_history or get_schedule. ${SOURCE_NOTE}`,
      inputSchema: {
        jobId: z.string().min(1).max(100).describe("The job id from get_customer_history or get_schedule."),
      },
      annotations: READ_ONLY,
    },
    async ({ jobId }) => {
      try {
        const j = await deps.getJobDetail(jobId);
        if (!j) {
          return await ok(deps, ["jobs"], {
            found: false,
            jobId,
            note: "No job with that id. Job ids come from get_customer_history or get_schedule.",
          });
        }
        return await ok(deps, ["jobs", "invoices"], {
          found: true,
          job: {
            id: j.id,
            customerId: j.customerId,
            customerName: j.customerName,
            customerPhone: j.customerPhone,
            address: j.address,
            technician: j.technicianName,
            service: j.service,
            status: j.status,
            date: dateOf(j.scheduledStart),
            time: j.scheduledStart ? timeLabel(j.scheduledStart) : null,
            scheduledStart: j.scheduledStart,
            scheduledEnd: j.scheduledEnd,
            amount: formatMoney(j.amountCents),
            amountCents: j.amountCents,
            invoice: j.invoice
              ? {
                  id: j.invoice.id,
                  status: j.invoice.status,
                  amount: formatMoney(j.invoice.amountCents),
                  amountCents: j.invoice.amountCents,
                }
              : null,
            notes: j.notes,
          },
        });
      } catch (err) {
        return fail("get_job", "Couldn't read that job just now. Try again in a minute.", err);
      }
    }
  );

  return server;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/mcp/jobs src/lib/slack`
Expected: all PASS (the Slack tests confirm exporting `timeLabel` changed nothing).

- [ ] **Step 6: Commit**

```bash
git add src/lib/mcp/jobs src/lib/slack/format.ts
git commit -m "feat(mcp): jobs connector customer and job lookups"
```

---

### Task 4: `get_schedule` tool

**Files:**
- Modify: `src/lib/mcp/jobs/server.ts` (add a tool inside `createJobsMcpServer`, before `return server;`)
- Test: `src/lib/mcp/jobs/__tests__/server.test.ts` (append)

**Interfaces:**
- Consumes: `JobsDeps.getScheduleDays(anchor, days)`, `JobsDeps.now()`, `ok`, `fail`, `READ_ONLY`, `SOURCE_NOTE`, `timeLabel`, `localDateKey` (all from Task 3); `dayLabelFromKey(dateKey: string): string` from `src/lib/slack/format.ts`.
- Produces: tool `get_schedule` with input `{ startDate?: "YYYY-MM-DD"; days?: 1..14; technician?: string }`.

- [ ] **Step 1: Write the failing tests**

Change the fixtures import at the top of `src/lib/mcp/jobs/__tests__/server.test.ts` to:

```ts
import { CUSTOMER_HIT, NOW, SYNCED_AT, connect, scheduleRow, stubDeps, text } from "./fixtures";
import type { JobsDeps } from "../server";
```

Append to the end of the file:

```ts
describe("get_schedule", () => {
  function recording() {
    const calls: { anchor: string; days: number }[] = [];
    const getScheduleDays: JobsDeps["getScheduleDays"] = async (anchor, days) => {
      calls.push({ anchor: anchor.toISOString(), days });
      return [
        {
          dateKey: "2026-11-17",
          rows: [
            scheduleRow({ id: "job_a", technicianName: "Dan Tech" }),
            scheduleRow({ id: "job_b", technicianName: "Mike Other", scheduledStart: null }),
          ],
        },
        { dateKey: "2026-11-18", rows: [] },
      ];
    };
    return { calls, getScheduleDays };
  }

  it("defaults to 7 days from now", async () => {
    const { calls, getScheduleDays } = recording();
    const { deps, freshnessCalls } = stubDeps({ getScheduleDays });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "get_schedule", arguments: {} })));
    expect(calls).toEqual([{ anchor: NOW.toISOString(), days: 7 }]);
    expect(body).toMatchObject({ days: 7, technician: null, totalJobs: 2, dataAsOf: SYNCED_AT });
    expect(freshnessCalls).toEqual([["jobs", "customers"]]);
  });

  it("anchors a start date inside that Eastern day and labels each day", async () => {
    const { calls, getScheduleDays } = recording();
    const client = await connect(stubDeps({ getScheduleDays }).deps);
    const body = JSON.parse(
      text(await client.callTool({ name: "get_schedule", arguments: { startDate: "2026-11-17", days: 2 } }))
    );
    expect(calls).toEqual([{ anchor: "2026-11-17T16:00:00.000Z", days: 2 }]);
    expect(body.startDate).toBe("2026-11-17");
    expect(body.schedule.map((d: { label: string }) => d.label)).toEqual(["Tue Nov 17", "Wed Nov 18"]);
    expect(body.schedule[0].jobs[0]).toEqual({
      id: "job_a",
      time: "9:30 AM",
      scheduledStart: "2026-11-17T14:30:00Z",
      customer: "Pat Example",
      phone: "5185550142",
      address: "12 Elm St, Averill Park",
      service: "Drain cleaning",
      technician: "Dan Tech",
      status: "Scheduled",
      zone: "Averill Park",
    });
    expect(body.schedule[0].jobs[1].time).toBe("Time TBD");
  });

  it("filters by technician name, case-insensitively", async () => {
    const { getScheduleDays } = recording();
    const client = await connect(stubDeps({ getScheduleDays }).deps);
    const body = JSON.parse(
      text(await client.callTool({ name: "get_schedule", arguments: { technician: "dan" } }))
    );
    expect(body.totalJobs).toBe(1);
    expect(body.schedule[0]).toMatchObject({ jobCount: 1 });
    expect(body.schedule[0].jobs[0].id).toBe("job_a");
  });

  it("rejects a date that doesn't exist without querying", async () => {
    const { calls, getScheduleDays } = recording();
    const client = await connect(stubDeps({ getScheduleDays }).deps);
    const res = await client.callTool({ name: "get_schedule", arguments: { startDate: "2026-02-30" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/isn't a real date/);
    expect(calls).toHaveLength(0);
  });

  it("refuses more than 14 days without querying", async () => {
    const { calls, getScheduleDays } = recording();
    const client = await connect(stubDeps({ getScheduleDays }).deps);
    const res = await client
      .callTool({ name: "get_schedule", arguments: { days: 30 } })
      .catch(() => ({ isError: true }));
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("hides the raw error when the schedule query fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(
      stubDeps({
        getScheduleDays: async () => {
          throw new Error("jobs query failed: Pat Example");
        },
      }).deps
    );
    const res = await client.callTool({ name: "get_schedule", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toMatch(/Pat Example/);
  });
});
```

Run: `npx vitest run src/lib/mcp/jobs`
Expected: the new `get_schedule` tests FAIL (tool not found); Task 3's tests still PASS.

- [ ] **Step 2: Implement**

In `src/lib/mcp/jobs/server.ts`, change the format import to:

```ts
import { dayLabelFromKey, timeLabel } from "@/lib/slack/format";
```

Add this function below `fail`:

```ts
function scheduleJob(r: TodayScheduleRow) {
  return {
    id: r.id,
    time: timeLabel(r.scheduledStart),
    scheduledStart: r.scheduledStart,
    customer: r.customerName,
    phone: r.customerPhone,
    address: r.address,
    service: r.service,
    technician: r.technicianName,
    status: r.status,
    zone: r.zone,
  };
}
```

Add this tool inside `createJobsMcpServer`, immediately before `return server;`:

```ts
  server.registerTool(
    "get_schedule",
    {
      title: "Schedule",
      description: `Trinity's jobs day by day (Eastern time), the same schedule as the dashboard and /trinity week. Canceled jobs are left out. Optionally only one technician's jobs. ${SOURCE_NOTE}`,
      inputSchema: {
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("First day, as YYYY-MM-DD in Eastern time. Defaults to today."),
        days: z.number().int().min(1).max(14).optional().describe("How many days, 1 to 14. Defaults to 7."),
        technician: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe("Only jobs whose technician name contains this text, e.g. 'Dan'."),
      },
      annotations: READ_ONLY,
    },
    async ({ startDate, days, technician }) => {
      // 16:00 UTC is midday Eastern under either offset, so the anchor always
      // falls inside the requested day (the same trick as /trinity in
      // src/lib/slack/commands.ts). Round-tripping through localDateKey also
      // catches dates like 2026-02-30 that the regex lets through.
      let anchor = deps.now();
      if (startDate) {
        anchor = new Date(`${startDate}T16:00:00Z`);
        if (Number.isNaN(anchor.getTime()) || localDateKey(anchor) !== startDate) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `"${startDate}" isn't a real date. Use YYYY-MM-DD, e.g. 2026-11-17.` }],
          };
        }
      }
      const dayCount = days ?? 7;
      const needle = technician?.trim().toLowerCase();

      try {
        const schedule = (await deps.getScheduleDays(anchor, dayCount)).map((d) => {
          const rows = needle
            ? d.rows.filter((r) => (r.technicianName ?? "").toLowerCase().includes(needle))
            : d.rows;
          return { date: d.dateKey, label: dayLabelFromKey(d.dateKey), jobCount: rows.length, jobs: rows.map(scheduleJob) };
        });
        return await ok(deps, ["jobs", "customers"], {
          startDate: schedule[0]?.date ?? startDate ?? localDateKey(anchor),
          days: dayCount,
          technician: technician ?? null,
          totalJobs: schedule.reduce((n, d) => n + d.jobCount, 0),
          schedule,
        });
      } catch (err) {
        return fail("get_schedule", "Couldn't read the schedule just now. Try again in a minute.", err);
      }
    }
  );
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/lib/mcp/jobs`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/mcp/jobs
git commit -m "feat(mcp): jobs connector schedule lookup"
```

---

### Task 5: `get_money_summary` tool

**Files:**
- Modify: `src/lib/mcp/jobs/server.ts` (add a tool before `return server;`)
- Test: `src/lib/mcp/jobs/__tests__/server.test.ts` (append)

**Interfaces:**
- Consumes: `JobsDeps.listOpenEstimates()`, `JobsDeps.listUnpaidInvoices()`, `JobsDeps.getRevenue()`, `ok`, `fail`, `READ_ONLY`, `SOURCE_NOTE`, `formatMoney`. `InvoiceHit.overdueDays` is `null` unless the invoice is overdue (then a positive number).
- Produces: tool `get_money_summary` with no input.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/mcp/jobs/__tests__/server.test.ts`:

```ts
describe("get_money_summary", () => {
  it("totals open estimates, unpaid invoices and revenue", async () => {
    const { deps, freshnessCalls } = stubDeps({
      listOpenEstimates: async () => [
        { id: "est_1", customerId: "cus_1", customerName: "Pat Example", amountCents: 125000, status: null },
      ],
      listUnpaidInvoices: async () => [
        { id: "inv_2", customerId: "cus_1", customerName: "Pat Example", amountCents: 40000, status: "open", dueDate: "2026-11-01", overdueDays: 16 },
        { id: "inv_3", customerId: null, customerName: null, amountCents: null, status: "open", dueDate: null, overdueDays: null },
      ],
      getRevenue: async () => ({ revenueBookedThisWeekCents: 350000, revenueScheduledNextWeekCents: 0 }),
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "get_money_summary", arguments: {} })));

    expect(body.openEstimates).toMatchObject({ count: 1, total: "$1,250.00", totalCents: 125000 });
    expect(body.openEstimates.items[0]).toMatchObject({ id: "est_1", amount: "$1,250.00", amountCents: 125000 });
    expect(body.unpaidInvoices).toMatchObject({ count: 2, overdueCount: 1, total: "$400.00", totalCents: 40000 });
    expect(body.unpaidInvoices.items[1]).toMatchObject({ id: "inv_3", amount: "n/a", amountCents: null });
    expect(body).toMatchObject({
      revenueBookedThisWeek: "$3,500.00",
      revenueBookedThisWeekCents: 350000,
      revenueScheduledNextWeek: "$0.00",
      revenueScheduledNextWeekCents: 0,
      dataAsOf: SYNCED_AT,
    });
    expect(freshnessCalls).toEqual([["estimates", "invoices", "jobs"]]);
  });

  it("hides the raw error when a money query fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(
      stubDeps({
        listUnpaidInvoices: async () => {
          throw new Error("invoices query failed: Pat Example");
        },
      }).deps
    );
    const res = await client.callTool({ name: "get_money_summary", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toMatch(/Pat Example/);
  });

  it("registers exactly the five tools", async () => {
    const client = await connect(stubDeps().deps);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "find_customer",
      "get_customer_history",
      "get_job",
      "get_money_summary",
      "get_schedule",
    ]);
  });
});
```

Run: `npx vitest run src/lib/mcp/jobs`
Expected: the new tests FAIL (tool not found / only 4 tools).

- [ ] **Step 2: Implement**

Add this tool inside `createJobsMcpServer`, immediately before `return server;`:

```ts
  server.registerTool(
    "get_money_summary",
    {
      title: "Money summary",
      description: `Open estimates, unpaid and overdue invoices (most overdue first), and revenue booked this week and scheduled next week. ${SOURCE_NOTE}`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const [estimates, invoices, revenue] = await Promise.all([
          deps.listOpenEstimates(),
          deps.listUnpaidInvoices(),
          deps.getRevenue(),
        ]);
        const sum = (rows: { amountCents: number | null }[]) => rows.reduce((t, r) => t + (r.amountCents ?? 0), 0);
        const estimatesCents = sum(estimates);
        const invoicesCents = sum(invoices);
        return await ok(deps, ["estimates", "invoices", "jobs"], {
          openEstimates: {
            count: estimates.length,
            total: formatMoney(estimatesCents),
            totalCents: estimatesCents,
            items: estimates.map((e) => ({ ...e, amount: formatMoney(e.amountCents) })),
          },
          unpaidInvoices: {
            count: invoices.length,
            overdueCount: invoices.filter((i) => i.overdueDays !== null).length,
            total: formatMoney(invoicesCents),
            totalCents: invoicesCents,
            items: invoices.map((i) => ({ ...i, amount: formatMoney(i.amountCents) })),
          },
          revenueBookedThisWeek: formatMoney(revenue.revenueBookedThisWeekCents),
          revenueBookedThisWeekCents: revenue.revenueBookedThisWeekCents,
          revenueScheduledNextWeek: formatMoney(revenue.revenueScheduledNextWeekCents),
          revenueScheduledNextWeekCents: revenue.revenueScheduledNextWeekCents,
        });
      } catch (err) {
        return fail("get_money_summary", "Couldn't read estimates and invoices just now. Try again in a minute.", err);
      }
    }
  );
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/lib/mcp/jobs`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/mcp/jobs
git commit -m "feat(mcp): jobs connector money summary"
```

---

### Task 6: Endpoint, metadata route, kill switch and live wiring

**Files:**
- Create: `src/lib/mcp/jobs/deps.ts`
- Create: `src/app/api/mcp/jobs/route.ts`
- Create: `src/app/.well-known/oauth-protected-resource/api/mcp/jobs/route.ts`
- Test: `src/app/api/mcp/jobs/__tests__/route.test.ts` (create)

**Interfaces:**
- Consumes: `serveMcp`, `methodNotAllowed` (Task 2); `JOBS_RESOURCE`, `metadataResponse`, `supabaseClaimsVerifier`, `ClaimsVerifier` (Task 1 and existing `auth.ts`); `createJobsMcpServer`, `JobsDeps` (Tasks 3–5); `stubDeps`, `CUSTOMER_HIT` from `src/lib/mcp/jobs/__tests__/fixtures.ts`.
- Produces: `liveJobsDeps(): JobsDeps` and `mcpJobsEnabled(): boolean` in `src/lib/mcp/jobs/deps.ts`; the `POST`, `GET`, `DELETE` route exports.

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/mcp/jobs/__tests__/route.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { POST, GET, DELETE } from "../route";
import { GET as metadataGET } from "@/app/.well-known/oauth-protected-resource/api/mcp/jobs/route";
import { serveMcp } from "@/lib/mcp/handler";
import { JOBS_RESOURCE } from "@/lib/mcp/auth";
import { createJobsMcpServer } from "@/lib/mcp/jobs/server";
import { CUSTOMER_HIT, stubDeps } from "@/lib/mcp/jobs/__tests__/fixtures";

afterEach(() => vi.unstubAllEnvs());

function rpc(body: unknown, auth?: string) {
  return new Request("https://ops.example.com/api/mcp/jobs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

describe("/api/mcp/jobs kill switch", () => {
  it.each([undefined, "", "TRUE", "1", "yes"])("is off when MCP_JOBS_ENABLED is %j", async (value) => {
    if (value !== undefined) vi.stubEnv("MCP_JOBS_ENABLED", value);
    const res = await POST(rpc(LIST, "Bearer anything"));
    expect(res.status).toBe(503);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("challenges with the jobs metadata URL when on", async () => {
    vi.stubEnv("MCP_JOBS_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const res = await POST(rpc(LIST));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/jobs"'
    );
  });
});

describe("/api/mcp/jobs with a valid token", () => {
  const verify = async () => ({ sub: "u1", role: "authenticated", client_id: "c1" });
  const serve = (body: unknown) =>
    serveMcp(rpc(body, "Bearer ok"), {
      verify,
      resource: JOBS_RESOURCE,
      createServer: () => createJobsMcpServer(stubDeps().deps),
    });

  it("initializes as trinity-jobs and lists the five tools", async () => {
    const init = await serve({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect((await init.json()).result.serverInfo.name).toBe("trinity-jobs");

    const list = await serve(LIST);
    const names = (await list.json()).result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["find_customer", "get_customer_history", "get_job", "get_money_summary", "get_schedule"]);
  });

  it("runs a tool end to end", async () => {
    const res = await serve({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "find_customer", arguments: { query: "pat" } },
    });
    const body = JSON.parse((await res.json()).result.content[0].text);
    expect(body.customers).toEqual([CUSTOMER_HIT]);
  });
});

describe("/api/mcp/jobs other methods", () => {
  it("answers GET and DELETE with 405", async () => {
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
  });
});

describe("/.well-known/oauth-protected-resource/api/mcp/jobs", () => {
  it("describes the jobs connector", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    const res = metadataGET(
      new Request("https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/jobs")
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: "https://ops.example.com/api/mcp/jobs",
      authorization_servers: ["https://abc.supabase.co/auth/v1"],
      scopes_supported: ["openid", "email", "profile"],
      bearer_methods_supported: ["header"],
      resource_name: "Trinity Plumbing jobs & customers (read-only)",
    });
  });
});
```

Run: `npx vitest run src/app/api/mcp/jobs`
Expected: FAIL (the route modules don't exist).

- [ ] **Step 2: Implement the live deps and kill switch**

Create `src/lib/mcp/jobs/deps.ts`:

```ts
// Real query functions for the jobs connector, plus its kill switch. Kept out
// of server.ts so the tools (and their tests) never import Supabase wiring.
import { getCustomerDetail, searchCustomers } from "@/lib/mobile/customers";
import { getJobDetail } from "@/lib/mobile/jobDetail";
import { listOpenEstimates, listUnpaidInvoices } from "@/lib/mobile/money";
import { mirrorSyncedAt } from "@/lib/mobile/mirrorFreshness";
import { getDashboardSnapshot, getScheduleDays } from "@/lib/dashboard/queries";
import type { JobsDeps } from "./server";

export function liveJobsDeps(): JobsDeps {
  return {
    searchCustomers: (query) => searchCustomers(query),
    getCustomerDetail,
    getJobDetail,
    getScheduleDays,
    listOpenEstimates,
    listUnpaidInvoices: () => listUnpaidInvoices(),
    getRevenue: () => getDashboardSnapshot(),
    mirrorSyncedAt,
    now: () => new Date(),
  };
}

// Off unless exactly "true", like SLACK_ALERTS_ENABLED: the code can deploy
// before customer data is reachable, and unsetting it cuts access.
export function mcpJobsEnabled(): boolean {
  return process.env.MCP_JOBS_ENABLED === "true";
}
```

- [ ] **Step 3: Implement the endpoint**

Create `src/app/api/mcp/jobs/route.ts`:

```ts
// MCP endpoint for the ChatGPT jobs & customers connector (read-only).
// Spec: docs/superpowers/specs/2026-11-17-chatgpt-jobs-connector-design.md
//
// Not covered by src/middleware.ts on purpose: ChatGPT has no cookie session.
// Every request must carry a Supabase-issued OAuth access token instead.
import { JOBS_RESOURCE, supabaseClaimsVerifier, type ClaimsVerifier } from "@/lib/mcp/auth";
import { methodNotAllowed, serveMcp } from "@/lib/mcp/handler";
import { liveJobsDeps, mcpJobsEnabled } from "@/lib/mcp/jobs/deps";
import { createJobsMcpServer } from "@/lib/mcp/jobs/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Built on first use so a missing env var fails the request, not the build.
let verify: ClaimsVerifier | null = null;

export async function POST(req: Request): Promise<Response> {
  // Before the token check, so a switched-off connector reveals nothing and
  // runs nothing.
  if (!mcpJobsEnabled()) {
    return Response.json(
      { error: "disabled", message: "The Trinity jobs connector is turned off." },
      { status: 503 }
    );
  }
  verify ??= supabaseClaimsVerifier();
  const deps = liveJobsDeps();
  return serveMcp(req, { verify, resource: JOBS_RESOURCE, createServer: () => createJobsMcpServer(deps) });
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
```

- [ ] **Step 4: Implement the metadata route**

Create `src/app/.well-known/oauth-protected-resource/api/mcp/jobs/route.ts`:

```ts
// RFC 9728 path-specific metadata for /api/mcp/jobs. The 401 from that
// endpoint points here, so ChatGPT registers the jobs connector on its own.
import { JOBS_RESOURCE, metadataResponse } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return metadataResponse(req, JOBS_RESOURCE);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/app/api/mcp src/lib/mcp src/__tests__/middleware.test.ts`
Expected: all PASS. The middleware test's existing "leaves the ChatGPT connector routes outside the gate" check covers both new paths.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mcp/jobs/deps.ts src/app/api/mcp/jobs "src/app/.well-known/oauth-protected-resource/api"
git commit -m "feat(mcp): /api/mcp/jobs endpoint behind MCP_JOBS_ENABLED"
```

---

### Task 7: Setup docs and full verification

**Files:**
- Modify: `README.md` (after the "ChatGPT price book connector (`/api/mcp`)" section, before `## Deploy`)
- Modify: `.env.example` (append)

**Interfaces:**
- Consumes: everything above.
- Produces: setup instructions and the documented env var.

- [ ] **Step 1: Document the env var**

Append to `.env.example`:

```bash

# --- ChatGPT jobs & customers connector (/api/mcp/jobs) ------------------------
# Kill switch. The connector answers only when this is exactly "true"; anything
# else returns 503 before any sign-in check or query. Results include customer
# names, addresses and phone numbers, so leave this unset until rollout.
MCP_JOBS_ENABLED=
```

- [ ] **Step 2: Document setup in the README**

Insert this section in `README.md` directly before the `## Deploy` heading:

```markdown
## ChatGPT jobs & customers connector (`/api/mcp/jobs`)

A second, separate read-only ChatGPT connector: customer lookup, a customer's
job history, single job details, the schedule and a money summary. It reads
the Supabase copy of HouseCall Pro (up to ~15 minutes behind) and never
writes. Anyone who can sign in to the Trinity app can use it. It uses the same
Supabase OAuth setup as the price book connector above, so there's no extra
Supabase configuration.
Spec: `docs/superpowers/specs/2026-11-17-chatgpt-jobs-connector-design.md`.

1. Deploy with `MCP_JOBS_ENABLED` unset. `POST /api/mcp/jobs` should return
   503, the price book connector should still work ("run the price book
   audit"), and `/.well-known/oauth-protected-resource` should be unchanged.
2. Set `MCP_JOBS_ENABLED=true` in Vercel and redeploy. `/api/mcp/jobs` should
   return 401 without a token, and
   `/.well-known/oauth-protected-resource/api/mcp/jobs` should name
   `/api/mcp/jobs`.
3. **ChatGPT (workspace admin):** Plugins → Add custom MCP server → URL
   `https://<app>/api/mcp/jobs`, authentication **OAuth** → publish. Sign in
   and approve.
4. Check: "what's on this week?" against `/trinity week`; one customer's
   history against the mobile app; "what's unpaid?" against `/trinity money`.

To turn it off, unset `MCP_JOBS_ENABLED` and redeploy.
```

- [ ] **Step 3: Run the full verification**

Run each and confirm the expected result:

- `npx vitest run` → all tests PASS (the baseline from Task 1 Step 1 plus the new ones).
- `npx tsc --noEmit` → no errors.
- `npm run lint` → no errors.
- `npm run build` → build succeeds, and the route list includes `/api/mcp/jobs` and `/.well-known/oauth-protected-resource/api/mcp/jobs`.

If any fails, fix it in the task that introduced the problem's file and re-run.

- [ ] **Step 4: Commit**

```bash
git add README.md .env.example
git commit -m "docs: ChatGPT jobs connector setup"
```
