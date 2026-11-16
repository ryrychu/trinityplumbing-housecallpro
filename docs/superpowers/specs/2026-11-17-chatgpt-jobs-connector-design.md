# ChatGPT Jobs & Customers Connector: Design

**Date:** 2026-11-17
**Status:** Approved by Ryan on 2026-11-17.
**Builds on:** the ChatGPT price book connector (`2026-11-13-chatgpt-pricebook-connector-design.md`, merged in PR #1 and live at `https://ops.trinity.plumbing/api/mcp`).

## Goal

Dave asks ChatGPT things like "what's on this week?", "what have we done for the Smiths?" or "what's still unpaid?". ChatGPT answers from Trinity's synced copy of HouseCall Pro (HCP), the same data the dashboard, the mobile app and `/trinity` in Slack use.

## Decisions

| Decision | Choice |
|---|---|
| Read vs write | **Read-only.** No writes to HCP or Supabase anywhere in this code. |
| Connector | **A second, separate ChatGPT plugin**, not more tools on the price book connector. It has its own URL and is published and signed into separately. |
| Who may use it | **Anyone who can sign in to the Trinity app**, the same as the price book. The owner chose this knowing the results include customer names, addresses and phone numbers. |
| Auth | Same as the price book: Supabase Auth is the OAuth 2.1 server, and this app only checks the tokens. |
| Data source | **The Supabase mirror, through the existing query functions.** No live HCP calls, no new tables, no new query logic. Data can be up to about 15 minutes behind HCP (the cron sync interval). |
| Scope | Customer lookup and job history, single job details, schedule, money summary |
| Kill switch | `MCP_JOBS_ENABLED`, off unless exactly `"true"`, following `slackAlertsEnabled()` |

## Architecture

```
ChatGPT ──POST /api/mcp/jobs (Bearer)──▶ route.ts
                                           │  MCP_JOBS_ENABLED?  no → 503
                                           ▼
                              handleMcpRequest (shared, now parameterized)
                                           │  verifyMcpToken (unchanged)
                                           ▼
                              lib/mcp/jobs/server.ts  (5 tools)
                                           ▼
             EXISTING query layer, unchanged:
             mobile/customers.ts · mobile/jobDetail.ts · mobile/money.ts
             mobile/mirrorFreshness.ts · dashboard/queries.ts
                                           ▼
                              Supabase (service role, server-only)
```

The price book connector keeps its URL, tools, name and metadata. The only change to its code is that the shared handler and auth helpers take the resource path and display name as arguments instead of hard-coding them.

### Units

| File | Change | Purpose |
|---|---|---|
| `src/lib/mcp/auth.ts` | Modify | `protectedResourceMetadata(origin, supabaseUrl, resource)` and `wwwAuthenticate(origin, invalidToken, resource)` take a `resource: { path, metadataPath, name }` instead of using the `MCP_PATH` / `RESOURCE_METADATA_PATH` constants directly. Export a `PRICEBOOK_RESOURCE` and a `JOBS_RESOURCE` describing the two connectors. `verifyMcpToken` is unchanged. |
| `src/lib/mcp/handler.ts` | Modify | `handleMcpRequest(req, { verify, resource, createServer })`. `createServer` returns the `McpServer` for that connector. Token check, 401 response and stateless transport are unchanged. |
| `src/app/api/mcp/route.ts` | Modify | Pass `PRICEBOOK_RESOURCE` and `() => createPricebookMcpServer(load)`. No behavior change. |
| `src/app/.well-known/oauth-protected-resource/route.ts` | Modify | Pass `PRICEBOOK_RESOURCE`. The JSON it returns must stay exactly the same. |
| `src/lib/mcp/jobs/server.ts` | New | `createJobsMcpServer(deps)` registers the 5 tools. `deps` holds the query functions, so tests can stub them without mocking Supabase. |
| `src/app/api/mcp/jobs/route.ts` | New | Node runtime, `maxDuration = 60`. If `MCP_JOBS_ENABLED !== "true"`, return 503 before any auth or query work. Otherwise `handleMcpRequest` with `JOBS_RESOURCE`. GET and DELETE return 405, as on `/api/mcp`. |
| `src/app/.well-known/oauth-protected-resource/api/mcp/jobs/route.ts` | New | RFC 9728 path-specific metadata: `resource` = `<origin>/api/mcp/jobs`, same `authorization_servers`, `scopes_supported` and `bearer_methods_supported` as the price book, `resource_name` = "Trinity Plumbing jobs & customers (read-only)". The 401 from `/api/mcp/jobs` points here in its `WWW-Authenticate` header. |
| `src/middleware.ts` | **No change** | Its matcher doesn't cover `/api/mcp/*` or `/.well-known/*`. A test pins this. |

### `JOBS_RESOURCE`

```ts
{
  path: "/api/mcp/jobs",
  metadataPath: "/.well-known/oauth-protected-resource/api/mcp/jobs",
  name: "Trinity Plumbing jobs & customers (read-only)",
}
```

## Tools

Every tool is annotated `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`, the same as the price book tools. Every tool returns JSON text with a `dataAsOf` field: the result of `mirrorSyncedAt()` for the resources that tool reads, or `null` if no sync time can be established. Tool descriptions tell ChatGPT that the data comes from a copy of HouseCall Pro and may be up to about 15 minutes behind.

| Tool | Input | Wraps | Returns | `dataAsOf` resources |
|---|---|---|---|---|
| `find_customer` | `query`: 1–100 chars, a name or phone number | `searchCustomers(query)` | Up to 25 matches: `id`, `name`, `phone`, `address` | customers |
| `get_customer_history` | `customerId`: string | `getCustomerDetail(id)` | Contact details, `lifetime` (dollars and cents), and every job: `id`, date, service, status, amount | customers, jobs |
| `get_job` | `jobId`: string | `getJobDetail(id)` | Customer, phone, address, scheduled start and end, technician, service, status, amount, invoice (id, status, amount), notes (content, author, date) | jobs, invoices |
| `get_schedule` | `startDate?`: `YYYY-MM-DD` Eastern, default today. `days?`: 1–14, default 7. `technician?`: text | `getScheduleDays(anchor, days)` | One entry per day (`date`, label such as "Tue Nov 17", `jobs`). Each job: `id`, time, customer, phone, address, service, technician, status, zone. If `technician` is given, only jobs whose technician name contains it (case-insensitive). | jobs, customers |
| `get_money_summary` | none | `listOpenEstimates()`, `listUnpaidInvoices()`, `getDashboardSnapshot()` | Open estimates and unpaid or overdue invoices, each as returned by those functions, plus `revenueBookedThisWeek` and `revenueScheduledNextWeek` | estimates, invoices, jobs |

Rules that apply to every tool:

- **Money is shown as dollars plus the cents value** (`"$1,234.50"` and `123450`), using `formatMoney` from `src/lib/mcp/pricebook.ts`, the same formatter the price book tools use. A missing amount shows as `"n/a"` with `null` cents.
- **Day labels** ("Tue Nov 17") come from `dayLabelFromKey` in `src/lib/slack/format.ts`, so they match `/trinity` and the digests.
- **`get_schedule` adds no date arithmetic.** It turns `startDate` into an anchor inside that Eastern day using the helpers in `src/lib/dashboard/week.ts`, and `getScheduleDays` does the DST-safe bucketing it already does for `/trinity` and the dashboard. `lat` and `lng` are left out of the result.
- **A customer or job that doesn't exist** returns a normal (non-error) result saying it wasn't found, so ChatGPT can try `find_customer` again.
- `technicianId` is still absent from `TodayScheduleRow` (`docs/PHASE-1.x-BACKLOG.md`), so the technician filter matches on display name, with the same same-name caveat as the mobile Schedule tab.

## Error handling

| Failure | Behavior |
|---|---|
| `MCP_JOBS_ENABLED` not `"true"` | 503 with a short JSON message, before the token check. No query runs. |
| Missing, bad, expired or non-OAuth token | 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp/jobs"`. ChatGPT runs sign-in again. |
| Bad tool input (for example `days: 30`) | The MCP SDK's validation error. No query runs. |
| A query throws | Tool result with `isError: true` and a short message, for example "Couldn't read the schedule just now. Try again in a minute." **Never the raw error**, which can contain customer rows. The error is logged server-side without the token. |
| GET or DELETE | 405 |

## Testing (vitest, matching the existing `__tests__` layout)

- **`src/lib/mcp/jobs/__tests__/server.test.ts`:** each tool against stubbed query functions. Checks the returned shape, money formatting, `dataAsOf`, the not-found result, the technician filter, `days` bounds, the default `startDate`, and that a throwing query returns `isError: true` without the thrown message.
- **`src/app/api/mcp/jobs/__tests__/route.test.ts`:** 503 when the switch is unset or set to anything other than `"true"`; 401 and the correct metadata link without a token; `tools/list` returns the 5 tools with a valid token; one `tools/call` round trip; 405 on GET.
- **`src/lib/mcp/__tests__/auth.test.ts`:** extend so metadata and `WWW-Authenticate` are built for both resources.
- **Price book regression:** the existing `/api/mcp` route tests keep passing unchanged, and a new test pins the root `/.well-known/oauth-protected-resource` JSON to its exact current value.
- **New metadata route:** the JSON shape and `resource` value.
- **`src/__tests__/middleware.test.ts`:** no change needed. Its existing "leaves the ChatGPT connector routes outside the gate" test already fails if any matcher entry starts with `/api/mcp` or `/.well-known`, which covers both new paths.

## Environment variables

| Variable | Purpose |
|---|---|
| `MCP_JOBS_ENABLED` | Kill switch. The jobs connector answers only when this is exactly `"true"`. |

No other new variables. It uses the existing Supabase variables.

## Rollout

1. Deploy with `MCP_JOBS_ENABLED` unset. Check that `/api/mcp/jobs` returns 503, that the price book connector still works in ChatGPT ("run the price book audit"), and that `/.well-known/oauth-protected-resource` is unchanged.
2. Set `MCP_JOBS_ENABLED=true` in Vercel and redeploy. Check that `/api/mcp/jobs` returns 401 without a token and that `/.well-known/oauth-protected-resource/api/mcp/jobs` names `/api/mcp/jobs`.
3. **ChatGPT (Dave, as workspace admin):** Plugins → Add custom MCP server → URL `https://ops.trinity.plumbing/api/mcp/jobs`, authentication **OAuth** → publish to the workspace. Sign in with the Trinity app login and approve.
4. Ask "what's on this week?" and compare with `/trinity week`. Ask for one customer's history and compare with that customer in the mobile app. Ask "what's unpaid?" and compare with `/trinity money`.

Rollback: unset `MCP_JOBS_ENABLED` and redeploy. There is no database change to undo.

## Accepted risks

- **Customer data is open to every Trinity app login.** This was the owner's choice (2026-11-17). It's read-only, so the worst case is disclosure, not damage. Limiting it to named users later means checking the token's `sub` against an allowlist in the jobs route.
- **A token from one Trinity connector also works on the other.** Supabase issues every token with `aud: authenticated`, not the MCP resource, so the two connectors are separate in ChatGPT but not as a security boundary. That's acceptable while both have the same audience. If access ever differs, add a Supabase access-token hook that stamps the resource into the token, and check it in each route.
- **Data can be up to about 15 minutes behind HCP.** Every result carries `dataAsOf`.
- **`getScheduleDays` reads every job** before filtering, so `get_schedule` may take a few seconds. That's well inside `maxDuration = 60`. Pushing the date range into the query is still deferred, as in the 2026-08-08 spec.
- **Supabase's OAuth 2.1 server is beta**, as for the price book connector.
- **Free text reaches ChatGPT.** Job notes and the service field (which can fall back to a customer-typed job description) are passed through as-is, so a crafted note could try to instruct ChatGPT. The connector is read-only, but Dave's workspace may have other connectors that can act, so treat tool output as data, not instructions.

## Out of scope

- Any write to HCP, including the price changes discussed on 2026-11-15. HCP's API can update material prices (`PUT /api/price_book/materials`) but not services. That's a separate design.
- Declined calls, nearby-work lookup, job photos or attachments, and leads
- Changes to the price book tools, the cron sync, Slack or notifications
- Optimizing the query layer
