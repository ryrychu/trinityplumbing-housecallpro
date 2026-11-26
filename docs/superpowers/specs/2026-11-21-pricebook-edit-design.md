# Trinity Price Book Editor (ChatGPT write access): Design

**Date:** 2026-11-21
**Status:** Approved by Ryan on 2026-11-21, section by section.
**Builds on:**
- The read-only price book connector (`2026-11-13-chatgpt-pricebook-connector-design.md`, PR #1). It stays unchanged.
- The Trinity Tasks connector and the Slack checklist pattern (`2026-11-21-fieldy-checklist-design.md`, PR #6).

## Goal

Dave and Ella can change the Housecall Pro (HCP) price book by asking ChatGPT, for example "raise all Navien parts 8%", "fix the description on the PEX fittings" or "add the new Rheem model". Every change is shown before it's made, logged with who made it, and can be undone.

From the Nov 14 dev call: let ChatGPT "directly edit prices and descriptions in Housecall Pro", with "a priority on updating prices first". Billing out jobs and marking them paid can build on this later.

## The constraint that shapes this

HCP's public API (`housecall.v1.yaml` in this repo, checked 2026-11-21):
- **Materials:** `GET/POST /api/price_book/materials` and `PUT/DELETE /api/price_book/materials/{uuid}`. The update fields are `name`, `description`, `price`, `cost`, `unit_of_measure`, `part_number`, `flat_rate_enabled` and `taxable`. Money is integer cents.
- **Material categories:** GET, POST, PUT and DELETE.
- **Services:** `GET /api/price_book/services` **only**. There is no endpoint to create or update a service.

So materials are edited directly. Service changes are drafted and posted to a Slack checklist, and Dave or Ella apply them in HCP by hand.

## Decisions

| Decision | Choice |
|---|---|
| Services | Drafted by ChatGPT, posted to a Slack checklist, applied by hand, and the tick is checked against HCP |
| Who may edit | **Dave and Ella.** Allow-listed Supabase user IDs in `MCP_PRICEBOOK_EDITORS`. Everyone else keeps the read-only connector. |
| Connector | **A separate plugin, "Trinity Price Book Editor"**, at `/api/mcp/pricebook-edit`. The read connector at `/api/mcp` doesn't change. |
| Material abilities | Update (price, cost, description, name, part number, unit, taxable), bulk changes, add new, undo. **No delete.** |
| Safety | Preview, then apply, with a stored `previewId`. Guardrails run at preview time. Every change is logged with its before and after values. |
| Service list | A private Slack channel (`SLACK_PRICEBOOK_CHANNEL_ID`), ticked by Dave or Ella (`SLACK_PRICEBOOK_ALLOWED_USERS`) |
| Kill switch | `MCP_PRICEBOOK_EDIT_ENABLED`, off unless exactly `"true"` |

## Architecture

```
ChatGPT (Dave / Ella) ──POST /api/mcp/pricebook-edit (Supabase OAuth)──▶ route.ts
                                         │ MCP_PRICEBOOK_EDIT_ENABLED? caller in MCP_PRICEBOOK_EDITORS?
                                         ▼
                           lib/mcp/pricebookEdit/server.ts  (tools)
               ┌──────────────┬──────────────┬───────────────┬──────────────────┐
               ▼              ▼              ▼               ▼                  ▼
   lib/mcp/pricebook.ts  pricebook/edit/  pricebook/edit/  pricebook/edit/   pricebook/edit/
   loadPricebook,        changes.ts       apply.ts,        store.ts          serviceChecklist.ts
   searchPricebook       (preview +       undo.ts          (Supabase:        (Slack message,
   (existing, read)      guardrails)          │            changes,          ticks)
                                              ▼            previews)               │
                              housecall/pricebookWrite.ts                          ▼
                              (PUT/POST materials, GET one)          lib/slack/web.ts + /api/slack/interact
                                                                     (router: fieldy_cb → Fieldy, pb_cb → price book)
```

## Components

### `lib/housecall/pricebookWrite.ts` (new)

`HousecallPricebookWriter` uses the same `HOUSECALL_API_KEY` and base URL as the read client. It offers:
- `getMaterial(uuid, categoryUuid)`: the OpenAPI file has no single-material GET (`/materials/{uuid}` supports only PUT and DELETE). So this lists `GET /api/price_book/materials?material_category_uuid=…` and picks the uuid, which returns null when the material is gone. The change log stores each material's `material_category_uuid` in `after`/`before` metadata so undo and the changed-since check know where to look.
- `updateMaterial(uuid, fields)`: `PUT /api/price_book/materials/{uuid}`.
- `createMaterial(categoryUuid, fields)`: `POST /api/price_book/materials?material_category_uuid=…`.

Errors carry the HTTP status and path only, never the body. The existing `HousecallPricebookClient` stays GET-only, and its "never writes" test keeps passing.

### `lib/pricebook/edit/changes.ts` (new, pure)

`buildPreview(request, pricebook)` turns a request into a list of planned changes plus warnings and blocks.

Requests come in two shapes:
- **Per item:** `{ uuid, price?, cost?, description?, name?, partNumber?, unit?, taxable? }`
- **By rule:** `{ match: { query?, category?, kind: "material" }, pricePercent?, costPercent?, round?: "cent" | "dollar" | "99" }`

Money is given in dollars (`"$145.00"` or `145`) and stored as integer cents. A percentage result is rounded as the request asks; the default is to the cent.

Blocks (each stops the request):
- price below cost, unless `allowBelowCost: true`;
- a price of zero or less;
- more than 50 items;
- an unknown uuid;
- a service uuid sent to a material tool.

Warnings (shown in the preview; the request is allowed):
- the price moves more than 25% either way;
- the description is missing or under 20 characters;
- the name duplicates another item of the same kind;
- nothing actually changes.

### `lib/pricebook/edit/store.ts` (new) and migration `0009_pricebook_changes.sql`

**`pricebook_changes`:**
- `id`, `batch_id`
- `kind`: `material_update` | `material_create` | `service_request` | `undo`
- `item_uuid`, `item_name`, `item_kind` (`material` | `service`)
- `before` and `after`: jsonb holding only the fields that changed; `before` is null for a create
- `status`:
  - materials: `applied` | `failed` | `undone`
  - services: `pending` | `done` | `dismissed`
- `requested_by_user_id`, `requested_by_email`
- `resolved_by` (a Slack or Supabase user), `error_code`
- `slack_channel_id`, `slack_message_ts` (service batches)
- `created_at`, `resolved_at`

**`pricebook_previews`:**
- `id` (uuid), `created_by_user_id`
- `payload` (jsonb: the planned changes)
- `expires_at` (15 minutes after creation)
- `applied_at`

Both tables have RLS enabled with no policies, so only the service role can touch them.

### `lib/pricebook/edit/apply.ts` and `undo.ts` (new)

**Apply** (`applyPreview(previewId, caller)`):
- Rejected when the preview is expired, already applied, or made by a different editor.
- The preview is claimed atomically: `applied_at` is set only where it is still null.
- Changes are applied one at a time, and each is logged as soon as HCP accepts it.
- A failed item is logged `failed`, with its status code, and the rest continue.
- The result is `{ applied, failed, batchId }`.
- Afterwards the read connector's price book cache is cleared.

**Undo** (`undoChange(id | batchId, caller)`):
- Goes back up to 30 days.
- For each `applied` `material_update`, it reads the material's current values. If they no longer match the logged `after`, it stops for that item and reports the current values. Otherwise it writes `before` back, marks the original `undone`, and logs an `undo` row.
- A `material_create` can't be undone, because delete is off. Undo says so and offers to rename the item or change its price.
- A `pending` `service_request` is marked `dismissed` and struck through in Slack.

### `lib/pricebook/edit/serviceChecklist.ts` (new)

`requestServiceChanges(items, caller)` validates with the same rules, merges into an existing `pending` request for the same service, writes the rows, and posts or updates one Slack message per batch.

**The message:**
- Heading: "Price book: N service changes to make in HCP · asked by <name>, <time>".
- One checkbox per service, labelled like `Drain cleaning: $175.00 → $195.00`. A description change goes in the option's description line, trimmed to fit.
- A thread reply with the full new descriptions, for copy and paste.
- Footer: `X of N done`.
- Action IDs are `pb_cb:<batchId>:<chunk>`, and option values are change IDs.

**A tick:**
- Only `SLACK_PRICEBOOK_ALLOWED_USERS` can tick. Anyone else snaps back with a private note.
- One tap makes one change, using the same stale-message rule as the Fieldy checklist.
- A tick marks the row `done` and re-renders.
- The app then reads the service from HCP. If the price, name or description doesn't match the request, it posts a thread reply such as "HCP still shows $175.00 for Drain cleaning." The tick stays.

### `/api/slack/interact` (modify)

It routes each action by its prefix: `fieldy_cb:` goes to the existing Fieldy handler, and `pb_cb:` goes to the price book handler. Each prefix has its own kill switch and allow-list. Fieldy behaviour and its tests stay unchanged.

### `lib/mcp/pricebookEdit/` and `/api/mcp/pricebook-edit` (new)

These mirror the Trinity Tasks connector: an `McpResource`, a metadata route, `serveMcp` with `createServer(caller)`, a 503 when switched off, and a 401 challenge. Any caller not in `MCP_PRICEBOOK_EDITORS` (or when it's unset) gets on every tool: "The price book editor is only available to Dave and Ella."

| Tool | Hints | What it does |
|---|---|---|
| `find_items` | read-only | Searches services and materials, returning uuid, kind, category, price, cost and description |
| `list_categories` | read-only | The material category tree with uuids |
| `recent_changes` | read-only | Recent changes (who, when, old → new) and pending service changes |
| `check_write_access` | write, idempotent | Saves one material back unchanged; reports whether the HCP key can write |
| `preview_material_changes` | read-only | Builds the preview and returns old → new values, warnings, blocks and a `previewId` |
| `apply_material_changes` | write | Applies a `previewId` |
| `add_material` | write | Validates, creates the material, logs it (preview-style checks inline) |
| `request_service_changes` | write | Logs the changes and posts the Slack checklist |
| `undo_change` | write | Undoes a change or a batch |

The server instructions tell ChatGPT:
- always preview before applying;
- show Dave or Ella the full old → new list and every warning;
- never apply a preview they haven't seen;
- route service changes to `request_service_changes`, explaining that HCP's API can't change services directly;
- never invent uuids.

## Error handling

| Failure | Result |
|---|---|
| HCP rejects the key (401/403) | `check_write_access` and apply report "the HCP API key can't write. Make a key with write access in HCP." Nothing is logged as applied. |
| HCP fails partway through a batch | Applied items stay applied and logged. The result lists failed items with their status codes. |
| The preview expired or was already applied | Refused; ChatGPT is told to preview again |
| An item changed between preview and apply | Apply checks the current values first. If they differ from the preview's "old" values, that item is skipped and reported. |
| A Slack post fails | The service rows are still saved. `recent_changes` shows them, and a retry re-posts. |
| A non-editor calls a tool or taps a box | Refused before any work, or snapped back with a private note |

## Testing

vitest with fake HCP, Slack and store:
- the guardrails (each block and each warning, rounding, dollar parsing);
- preview and apply (exact list, expiry, single use, editor binding, changed-since skip, partial failure);
- undo (stops when the item changed since, creates can't be undone, dismissing a service);
- the service checklist (post, merge, tick, snap-back, the HCP check reply);
- the interact router (Fieldy taps unchanged);
- the connector's access (kill switch, 401, non-editor refused on every tool);
- the write client's request shapes and errors.

## Rollout

1. Merge the PR, run migration `0009` in `wrvaenkyrfvbooogqhev` (it's additive), then deploy.
2. Set in Vercel Production, then redeploy:
   - `MCP_PRICEBOOK_EDIT_ENABLED=true`
   - `MCP_PRICEBOOK_EDITORS` (Dave's and Ella's Supabase user IDs, comma-separated)
   - `SLACK_PRICEBOOK_CHANNEL_ID`
   - `SLACK_PRICEBOOK_ALLOWED_USERS` (their Slack member IDs)
3. Create a private `#pricebook-changes` channel, `/invite` the bot, and add Dave and Ella. The Interactivity URL is already set from the Fieldy rollout.
4. Add the ChatGPT workspace plugin "Trinity Price Book Editor" at `https://ops.trinity.plumbing/api/mcp/pricebook-edit` with OAuth. Dave and Ella connect it.
5. Run `check_write_access`. If it fails, Dave makes an HCP API key with write access and Ryan updates `HOUSECALL_API_KEY`.
6. Test:
   - change one part's price and undo it;
   - preview a bulk +1% on a small category and apply it;
   - request one service change and tick it in Slack.

## Out of scope

- Deleting materials or categories.
- Creating or renaming categories.
- Editing services through the API (it doesn't exist).
- Price forms.
- Writing to jobs or invoices (billing out jobs and marking them paid is a later project).
- Access for anyone beyond Dave and Ella.
