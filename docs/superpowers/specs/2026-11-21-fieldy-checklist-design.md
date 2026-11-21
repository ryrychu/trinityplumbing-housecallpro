# Fieldy Checklist in Slack, run through ChatGPT: Design

**Date:** 2026-11-21
**Status:** Approved by Ryan on 2026-11-21, section by section.
**Builds on:**
- The Fieldy morning post (PR #3, `src/lib/fieldy/`), which this replaces.
- The ChatGPT connectors (PRs #1, #4, #5). The auth, the handler and the layout here follow the jobs connector (`2026-11-17-chatgpt-jobs-connector-design.md`).

## Goal

Dave's Fieldy pendant turns what he says into tasks. Every morning he gets one Slack checklist of his open tasks, grouped by job or errand. During the day he can talk to ChatGPT to do any of these:
- rebuild the checklist
- tick items off ("done with the Troy order")
- untick an item
- add new tasks

He can also tick items straight in Slack. Every tick also marks the task completed in Fieldy, so the Fieldy app, the checklist and the next morning's "finished yesterday" line all agree.

From the Nov 14 dev call: "once you send the recordings through chat, ChatGPT arranges that, then sends it through Slack… whenever you finish a task, it checks everything that you've done on Slack."

## Decisions

| Decision | Choice |
|---|---|
| What builds the checklist | **Both.** An automatic morning post, and Dave can ask ChatGPT to rebuild it during the day. |
| Morning grouping | **OpenAI API**, server-side, with a structured JSON response. If OpenAI fails, it falls back to rules-based grouping and still posts. |
| Write-back | **Yes.** Ticking marks the Fieldy task `completed`, unticking puts it back to `approved`, and adding creates a Fieldy task. This is the first time the app writes to Fieldy. |
| Ticking in Slack | **Yes**, through Block Kit checkboxes and a new Slack interactivity endpoint. |
| Adding tasks | **ChatGPT only.** Slack gets no add button. |
| Who may use it | **Dave only.** The connector checks his Supabase user ID (`MCP_TASKS_OWNER_USER_ID`). Slack ticks check his Slack user ID (`SLACK_FIELDY_ALLOWED_USERS`). |
| Source of truth | **Fieldy** for the tasks and whether they're done. **Supabase** for the day's grouping and the Slack message ID. **Slack** only displays what Supabase holds. |
| What reaches Slack | Task titles only, in the private channel `SLACK_FIELDY_CHANNEL_ID`. Recording summaries are never posted or stored. |
| Kill switches | `SLACK_FIELDY_ENABLED` (the morning post, the preview and Slack ticks) and `MCP_TASKS_ENABLED` (the connector). Each is off unless exactly `"true"`. |

## Architecture

```
            ┌──────────── ChatGPT (Dave) ────────────┐
            │  POST /api/mcp/tasks  (Supabase OAuth)  │
            └───────────────────┬────────────────────┘
 Slack checkbox tap             │                 /api/cron/sync (every 15 min)
 POST /api/slack/interact       │                  ├─ morning pass (7–11am ET, once a day)
   (signed, Dave only)          │                  └─ sync-with-Fieldy pass
            │                   ▼                         │
            └──────────▶ lib/tasks/checklist.ts ◀────────┘
                         (the one shared service)
             ┌────────────┬───────────┼────────────┬────────────┐
             ▼            ▼           ▼            ▼            ▼
      lib/fieldy/   lib/tasks/   lib/tasks/   lib/tasks/   lib/slack/web.ts
      client.ts     store.ts     organize.ts  render.ts    chat.postMessage
      (GET/POST/    (Supabase    (OpenAI +    (Block Kit)  chat.update
       PATCH)        tables)      rules)
```

Every change goes through `checklist.ts`, whether it comes from ChatGPT, a Slack tap or the cron. A tick from Slack and a tick from ChatGPT run the same code.

## Components

### `lib/fieldy/client.ts` (extend)

This keeps the existing `listTasks` and its error codes. It adds these calls, all checked against the OpenAPI spec embedded at https://api.fieldy.ai/docs (fetched 2026-11-21):

- `updateTask(id, { status, completionDate? })` → `PATCH /tasks/{id}`. The response is `{ success, task }`, and `success: false` throws `FieldyApiError("update_failed")`.
- `createTask({ title, date })` → `POST /tasks`. Both `title` and `date` (ISO 8601) are required by Fieldy.
- `listConversations(startTime, endTime)` → `GET /conversations?startTime&endTime&pageSize=20`. Only `id`, `title`, `summary`, `startTime` and `locked` are kept. `content`, quotes, speakers and location are dropped as they're read. Locked items are skipped.

The rate limit is 100 requests per 60 seconds per key. The busiest path, the morning pass, makes 4 reads. Each tick makes 1 PATCH.

The module header changes from "read-only" to a list of the three writes this app makes.

### `lib/tasks/store.ts` (new): Supabase tables

Migration `0008_task_checklists.sql`:

- `task_checklists`
  - `id`
  - `day` (date, Eastern, **unique**)
  - `channel_id`
  - `message_ts` (null until posted)
  - `built_by` (`morning_ai` | `morning_rules` | `chatgpt`)
  - `version` (int, bumped on every change)
  - `rendered_version` (int, the version last shown in Slack)
  - `created_at`, `updated_at`
- `task_checklist_items`
  - `id`
  - `checklist_id` (references `task_checklists`)
  - `position`
  - `group_name`
  - `text` (at most 75 characters)
  - `fieldy_task_id`
  - `done_at` (null when open)
  - `done_via` (`chatgpt` | `slack` | `fieldy`, or null)
  - unique on (`checklist_id`, `fieldy_task_id`)

RLS is enabled with no policies, like `declined_calls`: only the service role touches these tables. Every write that changes the checklist bumps `version` in the same statement.

### `lib/tasks/organize.ts` (new): grouping

- **`validateGrouping(groups, openTasks)`** is shared by the morning pass and ChatGPT's `post_checklist`:
  - drops unknown or duplicate task IDs
  - adds any open task that was left out under the group "Other"
  - cuts text to 75 characters with "…"
  - falls back to the Fieldy title if the text is empty
  - drops empty groups
  - caps the checklist at 40 items, reporting the rest as an overflow count

  The result can never lose or invent a task.
- **`groupWithOpenAI(tasks, summaries)`** calls the OpenAI Responses API with a JSON-schema structured output of `{ groups: [{ name, items: [{ taskId, text }] }] }`.
  - Settings: `OPENAI_API_KEY`, and `OPENAI_MODEL` for the model.
  - The default model is the smallest current OpenAI model that supports Structured Outputs. The implementation plan confirms that name against OpenAI's model list before coding it.
  - It times out after 30 seconds. Any error, timeout, refusal or schema mismatch returns null, never throws, and logs only the error code.
- **`groupByRules(tasks, now)`** groups into Overdue, Due today, No date and Later, oldest first within each group. It reuses the date logic from the current `report.ts`.

### `lib/tasks/render.ts` (new): the Slack message

Block Kit, rebuilt in full from the database on every change:
- Header: "Dave's checklist, Mon Nov 23".
- Each group gets a bold `section` label, then one or more `actions` blocks of `checkboxes`. Slack allows at most 10 options per element, so bigger groups are split.
  - The option `value` is the item ID.
  - The `action_id` is `fieldy_cb:<checklistId>:<chunk>`.
  - Ticked items are listed in `initial_options`, and their text is `~struck~`.
- Footer `context`: "4 of 11 done · Finished yesterday: 3". It adds "· +N more in Fieldy" when there's overflow, and "· Grouped by date; AI grouping didn't run" when the morning pass used rules.
- A plain `text` fallback goes with it for notifications.
- The whole message must stay under Slack's 50-block limit. That's guaranteed by the 40-item cap with 10 options per block, and tested.

### `lib/tasks/checklist.ts` (new): the service

Every operation takes injected dependencies (Fieldy, store, Slack, clock, organizer) for tests.

- `buildChecklist(day, groups, builtBy)` creates today's row or replaces its items.
  - Items that were already ticked keep `done_at`.
  - An item ticked earlier today is no longer an open task in Fieldy, so a new grouping won't include it. It stays on the checklist, in its previous group. A rebuild never removes something Dave already finished today.
  - If there's no `message_ts`, it posts; otherwise it calls `chat.update`.
- `markDone(taskIds, via)`:
  1. Fieldy `PATCH` to `completed`, with `completionDate` set to now.
  2. Update the items.
  3. Bump the version.
  4. Render.

  Fieldy is written first, and if that fails nothing else changes. A task already marked done is skipped, so running it twice changes nothing.
- `markNotDone(taskIds, via)` is the same, but the Fieldy status goes back to `approved` and `done_at` is cleared.
- `addTask(title, date?, group?)` calls Fieldy `POST` (the date defaults to today, Eastern), adds the item to today's checklist (group "Added" by default), and renders.
- `render(checklistId)`:
  1. Read the checklist and its version.
  2. Build the blocks.
  3. `chat.update`.
  4. Set `rendered_version`.

  If the version changed while Slack was being updated, it renders once more. A single pass per call, no loop beyond that.
- `syncWithFieldy(now)`:
  - Ticks items on today's checklist whose task Fieldy shows as `completed` (`done_via = fieldy`).
  - Re-renders any checklist whose `rendered_version < version`.

  It costs one Fieldy GET per run, and only when today's checklist exists.

### `lib/mcp/tasks/` + `/api/mcp/tasks` (new): the "Trinity Tasks" connector

This is built the same way as the jobs connector: its own `McpResource`, its own protected-resource metadata route, `serveMcp`, a 503 when `MCP_TASKS_ENABLED` isn't set, and a 401 challenge when there's no token. After the token is checked, if `userId !== MCP_TASKS_OWNER_USER_ID` (or that setting isn't set), every tool returns "Trinity Tasks is only available to Dave's login."

| Tool | Hints | What it does |
|---|---|---|
| `get_my_tasks` | read-only | Open tasks (new + approved) and tasks completed in the last 2 days. Each has its Fieldy ID, due date, and whether it's on today's checklist and ticked. |
| `get_recent_recordings` | read-only | Titles and summaries from the last `hours` (default 24, max 72), at most 20. Never transcripts. |
| `post_checklist` | write | `groups` → `validateGrouping` → `buildChecklist(…, "chatgpt")`. Returns the final grouping, including anything moved to "Other". |
| `mark_done` | write, idempotent | `taskIds` → `markDone(…, "chatgpt")` |
| `mark_not_done` | write, idempotent | `taskIds` → `markNotDone(…, "chatgpt")` |
| `add_task` | write | `title`, `dueDate?`, `group?` → `addTask` |

The write tools say `readOnlyHint: false, destructiveHint: false`, so ChatGPT asks Dave to confirm before running them.

The server instructions tell ChatGPT to:
- look up tasks before ticking
- confirm with Dave when more than one task could match
- never tick on a guess
- base Slack text on the task titles, shortening them without adding details

Tool errors are fixed messages, using `describeFieldyError` for Fieldy failures. Task text never goes into logs.

### `/api/slack/interact` (new): Slack checkboxes

- It isn't behind the middleware session gate, the same as `/api/slack/command`, and the middleware test is extended to cover it. The signature check is the whole of the authentication. It uses `verifySlackSignature` and `SLACK_SIGNING_SECRET`, with the same order of checks as the command route: the kill switch (`SLACK_FIELDY_ENABLED`) first, then the secret, then the raw body, then the signature.
- It parses the `block_actions` payload. For each `fieldy_cb` action, it compares `selected_options` with that chunk's items in the database to get the newly ticked and newly unticked items.
- It replies `200` right away and does the work in `waitUntil` (from `@vercel/functions`, as the command route does), because Slack needs an answer within 3 seconds.
- If the user isn't in `SLACK_FIELDY_ALLOWED_USERS`, it re-renders the message (so the box snaps back) and sends a private reply through `response_url`: "Only Dave can check these off."
- If Fieldy fails, it re-renders and sends a private reply with `describeFieldyError`.

### `lib/slack/web.ts` (extend)

`postMessage` gets an optional `blocks` argument and returns `ts`. A new `updateMessage(token, channel, ts, text, blocks)` calls `chat.update`. Both need the `chat:write` scope, which the bot already has.

### Cron (`/api/cron/sync`)

The Fieldy step changes from `runFieldyDailyPass` to two passes:
- **The morning checklist pass**, still between 7 and 11am ET and once a day, using claim kind `fieldy_checklist`:
  1. If today's checklist already exists, it skips.
  2. Read the tasks and the last 24 hours of summaries. If Fieldy fails, it throws before claiming, so the next run retries.
  3. Group with OpenAI, falling back to rules if that returns null.
  4. Validate, claim, then `buildChecklist`.
- **`syncWithFieldy`**.

The old raw post's formatter goes away. Its date grouping lives on in `groupByRules`.

`/trinity fieldy preview` returns the plain-text form of what the morning pass would build (the same OpenAI grouping or rules fallback), shown only to the person who asked. It never posts or writes anything.

## Error handling summary

| Failure | Result |
|---|---|
| Fieldy down or key revoked during the morning pass | No post. It retries at the next 15-minute run until 11am. |
| OpenAI down, slow, no key, or a bad answer | It posts with rules grouping and a footer note. |
| Fieldy fails on a tick, untick or add | Nothing changes. Slack snaps back and the error is shown privately, or ChatGPT gets the error. |
| Slack `chat.update` fails | The database still holds the change, and `syncWithFieldy` re-renders on the next run. |
| A tick and a ChatGPT change land at the same moment | Both are saved. The version check makes sure the last render shows both. |
| Someone other than Dave ticks a box | The box snaps back, with a private "Only Dave can check these off." |

## Testing

vitest with fake Fieldy, Slack, OpenAI and store, following the jobs connector tests.

- **`validateGrouping`:** unknown or duplicate IDs, left-out tasks going to Other, cutting at 75 characters, empty text, the 40-item cap and overflow.
- **`render`:** the 10-options split, the 50-block limit at 40 items, strikethrough and `initial_options` on ticked items, the footer variants.
- **`checklist`:**
  - ticking writes Fieldy before the database
  - when Fieldy fails, nothing changes
  - ticking twice changes nothing
  - untick and add
  - a re-render when the version moves during an update
  - `syncWithFieldy` ticking items and re-rendering when Slack is behind
- **Morning pass:** posts once a day, skips when today's checklist exists, falls back to rules when OpenAI returns null, retries when Fieldy fails before the claim.
- **Connector:** the kill switch, a 401 without a token, the not-Dave message, each tool calling the service correctly.
- **Interact route:** bad and old signatures, the kill switch, the not-Dave snap-back, tick and untick worked out from `selected_options`, the middleware exclusion.
- **Fieldy client:** PATCH and POST request shapes, `success: false`, the conversation fields that are dropped.

## Rollout

0. **Test Dave's Fieldy key with the code already live.** In Vercel Production, set `FIELDY_API_KEY`, `SLACK_FIELDY_CHANNEL_ID` and `SLACK_FIELDY_ENABLED=true`. Redeploy, then run `/trinity fieldy preview`. As of 2026-11-21, none of the three is set in Production.
1. Merge, then run migration `0008`.
2. In Vercel Production, set `OPENAI_API_KEY`, `MCP_TASKS_ENABLED=true`, `MCP_TASKS_OWNER_USER_ID` (Dave's Supabase user ID) and `SLACK_FIELDY_ALLOWED_USERS` (Dave's Slack member ID). Confirm `SLACK_SIGNING_SECRET` is set. Redeploy.
3. Slack app → Interactivity & Shortcuts → Request URL `https://ops.trinity.plumbing/api/slack/interact`.
4. Publish a ChatGPT workspace plugin "Trinity Tasks" at `https://ops.trinity.plumbing/api/mcp/tasks` with OAuth. Dave connects it with his ops login.
5. Check it live with Dave:
   - "organize my Fieldy tasks" produces a Slack post
   - a tick in Slack and a "done" in ChatGPT both show up in Fieldy
   - an added task appears in Fieldy and on the checklist
   - the next morning's post arrives once

## Out of scope

- Adding tasks from Slack.
- Editing task titles or due dates.
- Deleting tasks.
- Anyone besides Dave using the connector.
- Posting recordings or summaries to Slack.
- Checklists for other people.
