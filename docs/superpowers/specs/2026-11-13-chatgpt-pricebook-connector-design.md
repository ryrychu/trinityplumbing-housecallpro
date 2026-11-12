# ChatGPT Price Book Connector: Design

**Date:** 2026-11-13
**Status:** Approved by Ryan on 2026-11-13. Diagram: `General Conversation/drafts/chatgpt-connector-design.html`.
**Source:** Weekly Dev Call, 2026-11-07. Dave asked for ChatGPT to be linked to HouseCall Pro so it can review the price book and service descriptions, after customers said some prices were wrong or out of date.

## Goal

Dave asks ChatGPT, in his ChatGPT workspace, things like "which prices look outdated?" ChatGPT answers from the live HouseCall Pro (HCP) price book.

## Decisions

| Decision | Choice |
|---|---|
| Read vs write | **Read-only.** There are no price book write methods anywhere in this code. Dave or Ella make fixes in HCP by hand. |
| Client | A ChatGPT custom MCP server ("plugin"), published to Dave's ChatGPT Business workspace |
| Auth | OAuth 2.1, with **Supabase Auth acting as the authorization server**. ChatGPT supports only OAuth or no auth; it can't send fixed API-key headers ([OpenAI auth docs](https://developers.openai.com/plugins/build/auth)). |
| Who may use it | Anyone who can sign in to the Trinity app. The price book holds no customer data. |
| Data source | **Live HCP API on every call, with a 2-minute in-memory cache.** No new tables and no sync. |
| Scope | Price book only. Customer, schedule and money tools are out of scope. They could be added to this connector later. |

The 2026-08-08 spec (`2026-08-08-slack-commands-mcp-design.md`) ruled out an open MCP endpoint and deferred hand-writing an OAuth server. Supabase's OAuth 2.1 server (beta) fills that gap. Supabase runs `/authorize`, `/token`, PKCE, refresh, and dynamic client registration. We build three things: the consent page, the protected-resource metadata, and the token check.

## Architecture

```
ChatGPT ──POST /api/mcp (Bearer)──▶ route.ts ──▶ verifyMcpToken (Supabase getClaims)
                                       │
                                       ▼
                               lib/mcp/server.ts  (4 tools)
                                       ▼
                               lib/mcp/pricebook.ts  (normalize + audit, cache)
                                       ▼
                               HousecallPricebookClient  (read-only)
                                       ▼
                               HCP /api/price_book/*
```

### Units

| File | Purpose |
|---|---|
| `src/lib/housecall/pricebook.ts` | `HousecallPricebookClient`. GET-only methods: `listServices`, `listMaterialCategories(parentUuid?)`, `listMaterials(categoryUuid)`. Each pages through results up to a page cap. Accepts list data under either `data` or the resource key, because the OpenAPI file is inconsistent about which one HCP uses. |
| `src/lib/mcp/pricebook.ts` | Turns raw HCP data into `PricebookItem` rows: `kind`, `uuid`, `name`, `category`, `description`, `priceCents`, `costCents`, `unit`, `partNumber`, `updatedAt`, `taxable`. `loadPricebook()` walks the material-category tree, at most 5 requests at a time and at most 300 categories, and caches the result for 2 minutes. Also contains the pure functions `searchPricebook()` and `auditPricebook()`. |
| `src/lib/mcp/server.ts` | `createPricebookMcpServer(loader)` registers the 4 tools. Every tool is annotated `readOnlyHint: true`. |
| `src/lib/mcp/auth.ts` | `verifyMcpToken(authorizationHeader)` returns `{ userId, clientId }` or `null`. It uses `supabase.auth.getClaims(token)` and requires `role === "authenticated"`, a `client_id` claim (so only OAuth-issued tokens pass, not browser session tokens), and `is_anonymous !== true`. |
| `src/app/api/mcp/route.ts` | Next.js route (Node runtime). Runs the token check, then calls MCP `WebStandardStreamableHTTPServerTransport` in stateless JSON mode. On a 401 it returns `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`. |
| `src/app/.well-known/oauth-protected-resource/route.ts` | RFC 9728 metadata: `resource` = `<origin>/api/mcp`, `authorization_servers` = [`<SUPABASE_URL>/auth/v1`], `scopes_supported`, `bearer_methods_supported: ["header"]` |
| `src/app/oauth/consent/page.tsx` + `actions.ts` | Server-rendered consent screen. If the user is signed out, it redirects to `/app/login?next=/oauth/consent?authorization_id=…`. It shows the client name, the read-only wording, and Approve or Deny buttons. Server actions call `supabase.auth.oauth.approveAuthorization` or `denyAuthorization` and redirect to `redirect_url`. If the user already consented (the details response has no `authorization_id`), it redirects straight to `redirect_url`. |
| `src/middleware.ts` | Lets `/api/mcp` and `/.well-known/*` through. These routes run their own checks; the middleware would otherwise 401 them for having no cookie session. `/oauth/consent` stays behind the login redirect, which is what we want. |

### Tools

| Tool | Input | Returns |
|---|---|---|
| `pricebook_audit_report` | `staleMonths?` (default 12) | Problems grouped by rule: `zero_price`, `below_cost`, `missing_description`, `short_description` (<20 chars), `duplicate_name` (case-insensitive and trimmed, within the same kind), `stale` (only when HCP returns `updated_at`; otherwise the report says that check wasn't available). Includes counts. |
| `search_pricebook` | `query`, `kind?` | Up to 50 matches on name, description, category and part number |
| `list_services` | none | All services |
| `list_materials` | `category?` | Materials, optionally filtered by category name (case-insensitive substring) |

Money is shown as dollars (`$123.45`) plus the cents value. HCP documents price fields as integers, which follows its cents convention used elsewhere in this repo (`total_amount // cents`). **Check this against live data during setup.**

## Error handling

- A missing, bad, expired or non-OAuth token gets a 401 with the `WWW-Authenticate` header, and ChatGPT runs sign-in again.
- An HCP API failure is returned as a tool result with `isError: true` and a short message such as "HouseCall Pro price book request failed (status 429)". No response body, stack trace or API key is included.
- Paging is capped at 40 pages per list and 300 categories. If a cap is hit, the result says it was truncated.
- `/api/mcp` accepts only POST. GET and DELETE return 405, which is correct for stateless mode.

## Testing (vitest)

- `pricebook.ts` (lib/mcp): normalization (cents, missing fields, both envelope shapes), each audit rule, search, the category-walk cap, and the cache.
- `housecall/pricebook.ts`: builds the correct GET URLs and query parameters, pages until the last page, and exposes no write methods (checked by asserting `fetch` is only ever called with GET).
- `auth.ts`: missing header, non-Bearer header, `getClaims` error, missing `client_id`, anonymous user, and the valid case.
- `api/mcp/route.ts`: 401 plus header when there's no token; `tools/list` returns the 4 tools when the token is valid; a `tools/call` round trip with a stubbed loader; 405 on GET.
- `.well-known` route: the metadata shape.
- Consent actions: approve and deny redirect to `redirect_url`; errors show a message.
- Middleware: the new paths are allowed through, and `/oauth/consent` still redirects to login when signed out.

## Setup (manual, after deploy)

1. In Supabase, go to Authentication → OAuth Server. Enable it, enable dynamic client registration, and set the authorization path to `/oauth/consent`. Check that the Site URL is the Trinity app domain.
2. In Supabase, go to Signing keys and make sure an asymmetric key (ES256 or RS256) is active. `getClaims` then verifies locally against JWKS, and the `openid` scope works.
3. Open `<SUPABASE_URL>/.well-known/oauth-authorization-server/auth/v1` and confirm `registration_endpoint` is present. Note whether `offline_access` is in `scopes_supported`. OpenAI warns that ChatGPT may need users to sign in again when refresh isn't available.
4. Deploy.
5. Dave, as workspace admin: Plugins → Add custom MCP server → URL `https://<app>/api/mcp` → OAuth → publish. Then sign in and Approve.
6. Check that prices are in cents by comparing one service's price against what the HCP UI shows.

## Out of scope

- Writes to HCP
- Customer, schedule and money tools
- Price forms (`/api/price_book/price_forms`), which aren't needed to review prices and descriptions
- Any change to the cron sync, Slack or notifications

## Known risks

- Supabase's OAuth 2.1 server is beta.
- Access tokens carry `aud: authenticated`, not the MCP resource. The `client_id` check limits access to OAuth-issued tokens; a Supabase access-token hook could add a resource audience later if needed.
- The ChatGPT workspace login problem from the call has to be fixed before Dave can publish the connector.
