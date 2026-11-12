# ChatGPT Price Book Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only MCP server at `/api/mcp` that ChatGPT can connect to with Supabase OAuth, to review the HouseCall Pro price book.

**Architecture:** A GET-only HCP price book client feeds a normalize/audit module. That module backs 4 MCP tools, served through the MCP SDK's web-standard Streamable HTTP transport in stateless JSON mode. A Supabase OAuth 2.1 token, checked with `getClaims` plus a required `client_id` claim, guards the route. A protected-resource metadata route and a consent page under `/app/` complete the OAuth flow.

**Tech Stack:** Next.js 14 App Router, TypeScript, `@modelcontextprotocol/sdk@1.32.2`, `zod@4`, `@supabase/supabase-js@2.110`, `@supabase/ssr`, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-11-13-chatgpt-pricebook-connector-design.md`

**Note on format:** This plan was written to be executed inline in the same session as the spec. Each task lists its interfaces and exact test cases. The code is in the commit for that task, not repeated here.

## Global Constraints

- Read-only: no POST, PUT, PATCH or DELETE to HCP anywhere in the new code.
- Every MCP tool is annotated `readOnlyHint: true`.
- Errors returned to ChatGPT never include an HCP response body, stack trace, or credential.
- Caps: 40 pages per list, 300 material categories, 5 concurrent HCP requests, 2-minute cache, 50 search results.
- Consent page path: `/app/oauth/consent`. Middleware stays unchanged.
- Env vars used: `HOUSECALL_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`. No new env vars.
- Test command: `npx vitest run <path>`. Full suite: `npm test`. Build: `npm run build`.

---

### Task 1: HCP price book client (GET-only)

**Files:** Create `src/lib/housecall/pricebook.ts`, `src/lib/housecall/__tests__/pricebook.test.ts`

**Produces:**
```ts
export interface HcpPricebookService { uuid: string; name?: string; description?: string; task_number?: string; price?: number; cost?: number; unit_of_measure?: string; taxable?: boolean; category?: { uuid?: string; name?: string } | null; updated_at?: string; created_at?: string }
export interface HcpMaterialCategory { uuid: string; name?: string; parent_uuid?: string | null }
export interface HcpMaterial { uuid: string; name?: string; description?: string; price?: number; cost?: number; unit_of_measure?: string; part_number?: string; material_category_uuid?: string; material_category_name?: string; taxable?: boolean; updated_at?: string; created_at?: string }
export interface ListAll<T> { items: T[]; truncated: boolean }
export const MAX_PAGES = 40;
export class HcpPricebookError extends Error { status: number }
export class HousecallPricebookClient {
  constructor(apiKey?: string, fetchImpl?: typeof fetch)
  listServices(): Promise<ListAll<HcpPricebookService>>
  listMaterialCategories(parentUuid?: string): Promise<ListAll<HcpMaterialCategory>>
  listMaterials(categoryUuid: string): Promise<ListAll<HcpMaterial>>
}
```

Tests:
- [ ] Requests `https://api.housecallpro.com/api/price_book/services?page=1&page_size=100` with `Authorization: Bearer <key>`, and pages until `page >= total_pages_count`.
- [ ] Reads list data from `data`, or from `services` / `material_categories` / `materials` if `data` is missing.
- [ ] `listMaterials(uuid)` sends `material_category_uuid=<uuid>`. `listMaterialCategories(parent)` sends `parent_uuid`, and omits it when there's no parent.
- [ ] Stops at `MAX_PAGES` and returns `truncated: true`.
- [ ] A non-2xx response throws `HcpPricebookError` with the status. The message doesn't contain the response body.
- [ ] Every `fetch` call uses method GET or no method. Checked across all tests with a spy.
- [ ] Throws when `HOUSECALL_API_KEY` is missing and no key is passed in.

Commit: `feat(mcp): read-only HouseCall Pro price book client`

### Task 2: Normalize, load, search, audit

**Files:** Create `src/lib/mcp/pricebook.ts`, `src/lib/mcp/__tests__/pricebook.test.ts`

**Consumes:** Task 1 types and client.
**Produces:**
```ts
export type ItemKind = "service" | "material";
export interface PricebookItem { kind: ItemKind; uuid: string; name: string; category: string | null; description: string; priceCents: number | null; costCents: number | null; unit: string | null; partNumber: string | null; updatedAt: string | null; taxable: boolean | null }
export interface Pricebook { items: PricebookItem[]; truncated: boolean; loadedAt: string }
export type PricebookLoader = () => Promise<Pricebook>;
export function normalizeService(s: HcpPricebookService): PricebookItem
export function normalizeMaterial(m: HcpMaterial, categoryName?: string): PricebookItem
export function createPricebookLoader(client: Pick<HousecallPricebookClient, "listServices" | "listMaterialCategories" | "listMaterials">, opts?: { ttlMs?: number; now?: () => number; maxCategories?: number; concurrency?: number }): PricebookLoader
export function searchPricebook(items: PricebookItem[], query: string, kind?: ItemKind, limit?: number): PricebookItem[]
export type AuditRule = "zero_price" | "below_cost" | "missing_description" | "short_description" | "duplicate_name" | "stale";
export interface AuditReport { totalItems: number; staleCheck: "ran" | "unavailable"; counts: Record<AuditRule, number>; findings: Record<AuditRule, PricebookItem[]> }
export function auditPricebook(items: PricebookItem[], opts?: { staleMonths?: number; now?: Date }): AuditReport
export function formatMoney(cents: number | null): string   // "$1,234.50" or "n/a"
```

Tests:
- [ ] Normalizing fills missing fields with null or "". Trims the name. Takes the service category from `category.name`. Takes the material category from `material_category_name`, or the walked category's name.
- [ ] The loader walks the category tree breadth-first (root, then children), collects materials from every category, and merges them with services.
- [ ] The loader stops at `maxCategories` and sets `truncated`. Any truncated list also sets `truncated`.
- [ ] The loader caches for `ttlMs`: a second call within the TTL makes no fetches, and a call after the TTL fetches again. A failed load isn't cached.
- [ ] Search is case-insensitive across name, description, category and part number. It respects `kind` and `limit`. An empty query returns [].
- [ ] Audit rules:
  - `zero_price`: price is null or 0.
  - `below_cost`: price is less than cost, and cost is greater than 0.
  - `missing_description`: description is empty after trimming.
  - `short_description`: description is 1–19 characters after trimming.
  - `duplicate_name`: same kind and same lowercased, trimmed name. Lists every item in the group.
  - `stale`: `updatedAt` is older than `staleMonths`. `staleCheck` is "unavailable" when no item has `updatedAt`.
- [ ] `formatMoney(123450)` returns "$1,234.50". `formatMoney(null)` returns "n/a".

Commit: `feat(mcp): price book normalize, cache, search and audit`

### Task 3: MCP server with 4 tools

**Files:** Create `src/lib/mcp/server.ts`, `src/lib/mcp/__tests__/server.test.ts`. Add `zod` to dependencies.

**Consumes:** Task 2.
**Produces:** `export function createPricebookMcpServer(load: PricebookLoader): McpServer`. Tools: `pricebook_audit_report { staleMonths?: int 1..120 }`, `search_pricebook { query: string(1..100), kind?: "service"|"material" }`, `list_services {}`, `list_materials { category?: string }`. Each returns `content: [{ type: "text", text: JSON }]`, with prices shown as `price` ("$x") plus `priceCents`. Errors return `isError: true` with the text "HouseCall Pro price book request failed (status N)" or "Price book lookup failed".

Tests (using an in-memory linked transport pair and the SDK `Client`):
- [ ] `listTools` returns exactly the 4 names, each with `annotations.readOnlyHint === true`.
- [ ] The audit tool returns counts from a stubbed loader.
- [ ] Search returns matches. `list_materials` with `category` filters case-insensitively.
- [ ] A loader that throws `HcpPricebookError(429)` produces `isError` and a message with the status and no body. A generic error produces "Price book lookup failed".
- [ ] When `truncated` is true, the payload includes `truncated: true` and a note.

Commit: `feat(mcp): price book MCP tools`

### Task 4: Token check + `/api/mcp` route + protected-resource metadata

**Files:** Create:
- `src/lib/mcp/auth.ts`
- `src/lib/mcp/__tests__/auth.test.ts`
- `src/app/api/mcp/route.ts`
- `src/app/api/mcp/__tests__/route.test.ts`
- `src/app/.well-known/oauth-protected-resource/route.ts`
- `src/app/.well-known/oauth-protected-resource/__tests__/route.test.ts`

**Produces:**
```ts
// auth.ts
export interface McpCaller { userId: string; clientId: string }
export type ClaimsVerifier = (jwt: string) => Promise<Record<string, unknown> | null>;
export function supabaseClaimsVerifier(): ClaimsVerifier   // anon client, auth.getClaims(jwt)
export async function verifyMcpToken(header: string | null, verify?: ClaimsVerifier): Promise<McpCaller | null>
// route.ts
export async function POST(req: Request): Promise<Response>
export async function GET(): Promise<Response>      // 405
export async function DELETE(): Promise<Response>   // 405
export function handleMcpRequest(req: Request, deps: { verify: ClaimsVerifier; load: PricebookLoader }): Promise<Response>
// .well-known
export function GET(req: Request): Response
export function protectedResourceMetadata(origin: string, supabaseUrl: string): object
```

Tests:
- [ ] `verifyMcpToken`:
  - null, `Basic x`, or `Bearer ` (empty) returns null.
  - A verifier that returns null or throws returns null.
  - `role !== "authenticated"` returns null.
  - A missing `client_id` returns null.
  - `is_anonymous: true` returns null.
  - Valid claims return `{ userId: sub, clientId }`.
- [ ] Route: no token gives 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
- [ ] Route: a valid token with JSON-RPC `initialize` returns 200. `tools/list` returns the 4 tools (stateless, `enableJsonResponse`).
- [ ] Route: GET and DELETE return 405.
- [ ] Metadata:
  - `resource` = `<origin>/api/mcp`
  - `authorization_servers` = [`<supabase>/auth/v1`]
  - `bearer_methods_supported` = ["header"]
  - `scopes_supported` includes "openid"
  - Response is JSON

Origin: `x-forwarded-proto` + `x-forwarded-host`/`host`, falling back to `new URL(req.url).origin`.

Commit: `feat(mcp): OAuth-protected /api/mcp endpoint and resource metadata`

### Task 5: Consent page + middleware guard test

**Files:** Create:
- `src/app/app/oauth/consent/page.tsx`
- `src/app/app/oauth/consent/actions.ts`
- `src/app/app/oauth/consent/__tests__/actions.test.ts`
- `src/__tests__/middleware-matcher.test.ts`

**Produces:**
```ts
// actions.ts ("use server")
export async function decideAuthorization(formData: FormData): Promise<void>   // fields: authorization_id, decision=approve|deny; redirect(redirect_url) or redirect to the page with ?error=
export async function runDecision(oauth: OAuthApi, id: string, decision: "approve" | "deny"): Promise<{ redirectUrl: string } | { error: string }>
```
`page.tsx` is a server component:
- No `authorization_id`: shows an error message.
- `getAuthorizationDetails` returns a redirect: calls `redirect(redirect_url)`.
- Otherwise: renders the client name, "read-only access to the Trinity price book", the signed-in email, and Approve/Deny buttons that post to `decideAuthorization`.

Tests:
- [ ] `runDecision` approve calls `approveAuthorization(id, { skipBrowserRedirect: true })` and returns the redirect URL. Deny calls `denyAuthorization`. An error returns `{ error }`. An empty id returns an error without calling the API.
- [ ] The middleware `config.matcher` covers `/app/:path*` (so it applies to `/app/oauth/consent`) and contains no entry starting `/api/mcp` or `/.well-known`.

Commit: `feat(mcp): OAuth consent page for the ChatGPT connector`

### Task 6: Verify + docs

- [ ] `npm test` passes, with the full suite green.
- [ ] `npm run build` passes.
- [ ] Add a "ChatGPT price book connector" section to the README with the setup steps from the spec.
- [ ] Commit: `docs: ChatGPT connector setup`
