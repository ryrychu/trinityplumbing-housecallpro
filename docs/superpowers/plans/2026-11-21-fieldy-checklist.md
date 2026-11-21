# Fieldy Checklist in Slack via ChatGPT: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each morning, Dave's open Fieldy tasks get posted to Slack as one grouped checklist. Ticking an item (in Slack or by telling ChatGPT) marks the task completed in Fieldy. ChatGPT can also rebuild the checklist and add tasks.

**Architecture:** One shared service, `src/lib/tasks/checklist.ts`, owns every change: build, tick, untick, add, sync with Fieldy. The day's grouping and the Slack message ID live in two new Supabase tables. The Slack message is always rebuilt in full from those tables. Three entry points call the service:
- the 15-minute cron (morning post plus sync)
- a new Dave-only ChatGPT MCP connector at `/api/mcp/tasks`
- a new Slack interactivity endpoint at `/api/slack/interact`

**Tech Stack:**
- Next.js 14 App Router
- TypeScript (strict)
- Supabase (service role)
- `@modelcontextprotocol/sdk` 1.32 with `zod`
- Slack Web API (`chat.postMessage`, `chat.update`) and Block Kit checkboxes
- Fieldy Public API v2
- OpenAI Responses API with JSON-schema structured output, called with plain `fetch` (no new dependency)
- `@vercel/functions` `waitUntil`
- vitest

**Spec:** `docs/superpowers/specs/2026-11-21-fieldy-checklist-design.md`

## Global Constraints

- **Kill switches:** `SLACK_FIELDY_ENABLED` and `MCP_TASKS_ENABLED`. Each is off unless exactly `"true"`.
- **Dave only:**
  - The connector checks `MCP_TASKS_OWNER_USER_ID` (a Supabase user ID).
  - Slack ticks check `SLACK_FIELDY_ALLOWED_USERS` (comma-separated Slack member IDs).
  - Anyone else gets `"Trinity Tasks is only available to Dave's login."` (connector) or `"Only Dave can check these off."` (Slack).
- **Never log** task titles, recording summaries, the Fieldy key, the OpenAI key, the Slack token, or any `response_url`. Log only error codes and messages built from them.
- **What Slack gets:** task titles only, in the channel `SLACK_FIELDY_CHANNEL_ID`. Recording summaries are never posted or stored.
- **Fieldy rules:**
  - Fieldy is written **before** the database on every tick, untick or add. If Fieldy fails, that task's change doesn't happen.
  - Statuses: done = `completed` with `completionDate` set to now (ISO). Undone = `approved`.
- **Slack limits:**
  - Checkbox option text: 75 characters at most.
  - Options per checkboxes element: 10 at most.
  - Blocks per message: 50 at most.
  - The checklist itself holds at most 40 items in at most 12 groups.
- **Morning window:** 7–11am Eastern, once per Eastern day, claim kind `"fieldy_checklist"`.
- **OpenAI:** default model `gpt-6-luna` (checked 2026-11-21 at https://developers.openai.com/api/docs/models/compare, listed for `v1/responses` with Structured Outputs). Override with `OPENAI_MODEL`. Timeout 30 seconds. Send `store: false`. Any failure returns `null` and the post falls back to rules grouping.
- **No new npm dependencies.**
- **Iteration:** the tsconfig has no `target`, so never use `for…of` or spread over a `Map` or `Set`. Use `Array.from(...)`. The repo already fixed one bug of this kind (commit `ab337b1`).
- **Copy rules:**
  - Footer: `"4 of 11 done · Finished yesterday: 3"`, plus `" · +N more in Fieldy"` and `" · Grouped by date; AI grouping didn't run"` when they apply.
  - Heading: `"Dave's checklist, <dayLabelFromKey(day)>"`.
- **Run tests with** `npx vitest run <path>`. Typecheck with `npx tsc --noEmit`.

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/fieldy/client.ts` | modify | Add `updateTask`, `createTask` and `listConversations`, plus a shared `request()` |
| `src/lib/fieldy/report.ts` | modify | Export `uniqueById`; delete `formatFieldyPost` and its helpers |
| `src/lib/fieldy/fieldy.ts` | modify | The preview uses the checklist plan; delete `runFieldyDailyPass`; `describeFieldyError` learns write ops |
| `supabase/migrations/0008_task_checklists.sql` | create | Two tables and four SQL functions |
| `src/lib/tasks/store.ts` | create | The `ChecklistStore` interface and its Supabase implementation |
| `src/lib/tasks/organize.ts` | create | `validateGrouping`, `groupByRules`, `fitText` |
| `src/lib/tasks/openai.ts` | create | `groupWithOpenAI` |
| `src/lib/tasks/render.ts` | create | The Block Kit checklist, the plain-text preview, action IDs |
| `src/lib/slack/web.ts` | modify | `postMessage` takes `blocks` and returns `ts`; add `updateMessage` |
| `src/lib/slack/respond.ts` | modify | Add `postEphemeralNote` (`replace_original: false`) |
| `src/lib/tasks/checklist.ts` | create | The shared service |
| `src/lib/tasks/deps.ts` | create | The live Fieldy, Slack, store and OpenAI wiring, plus the config check |
| `src/lib/tasks/morning.ts` | create | `planChecklist`, `runChecklistMorningPass` |
| `src/lib/tasks/cron.ts` | create | `runFieldyChecklistPasses` (the morning pass and the sync, switch-gated) |
| `src/lib/notifications/dedupe.ts` | modify | Add the `"fieldy_checklist"` kind |
| `src/app/api/cron/sync/route.ts` | modify | Call `runFieldyChecklistPasses` |
| `src/lib/mcp/auth.ts` | modify | Add `TASKS_RESOURCE` |
| `src/lib/mcp/handler.ts` | modify | `createServer(caller)` |
| `src/lib/mcp/tasks/server.ts` | create | The Trinity Tasks MCP tools |
| `src/lib/mcp/tasks/deps.ts` | create | `liveTasksDeps`, `mcpTasksEnabled` |
| `src/app/api/mcp/tasks/route.ts` | create | The connector endpoint |
| `src/app/.well-known/oauth-protected-resource/api/mcp/tasks/route.ts` | create | RFC 9728 metadata |
| `src/lib/tasks/interact.ts` | create | `handleChecklistTap` |
| `src/app/api/slack/interact/route.ts` | create | The Slack interactivity endpoint |
| `src/lib/tasks/__tests__/fakes.ts` | create | An in-memory store and fake Fieldy and Slack, shared by the tests |
| `docs/SLACK-ROLLOUT.md` | modify | Rollout steps for the Fieldy checklist |

---

### Task 1: Fieldy client writes and conversation summaries

**Files:**
- Modify: `src/lib/fieldy/client.ts`
- Modify: `src/lib/fieldy/fieldy.ts` (only `FIXES` and `describeFieldyError`)
- Test: `src/lib/fieldy/__tests__/client.test.ts` (append), `src/lib/fieldy/__tests__/fieldy.test.ts` (append to the `describeFieldyError` block)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type TaskUpdate = { status: "completed"; completionDate: string } | { status: "approved" }`
  - `type ConversationSummary = { id: string; title: string | null; summary: string | null; startTime: string }`
  - `updateTask(id: string, update: TaskUpdate): Promise<FieldyTask>`
  - `createTask(input: { title: string; date: string }): Promise<FieldyTask>`
  - `listConversations(startIso: string, endIso: string): Promise<ConversationSummary[]>`
  - `toConversation(raw: unknown): ConversationSummary | null`
  - `CONVERSATION_MAX = 20`
  - `FieldyApiError` gains a `readonly op: string`. Its constructor is `(code, op = "GET /tasks")`, so the existing message stays `"[fieldy] GET /tasks failed: <code>"`.

- [ ] **Step 1: Write the failing tests.** Append to `src/lib/fieldy/__tests__/client.test.ts`, and add `updateTask, createTask, listConversations, CONVERSATION_MAX` to its import from `"../client"`:

```ts
describe("updateTask", () => {
  it("PATCHes /tasks/{id} with the new status and completion date", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ success: true, task: { id: "t 1", title: "Call back", status: "completed", completionDate: "2026-11-23T15:00:00.000Z" } })
    );

    const task = await updateTask("t 1", { status: "completed", completionDate: "2026-11-23T15:00:00.000Z" });

    expect(task).toMatchObject({ id: "t 1", status: "completed", completionDate: "2026-11-23T15:00:00.000Z" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${FIELDY_API_BASE}/tasks/t%201`);
    expect(init.method).toBe("PATCH");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ status: "completed", completionDate: "2026-11-23T15:00:00.000Z" });
  });

  it("throws update_failed when Fieldy answers success: false", async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: false, task: null }));
    await expect(updateTask("t1", { status: "approved" })).rejects.toMatchObject({ code: "update_failed", op: "PATCH /tasks/{id}" });
  });

  it("names the PATCH in the error message, never the body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("task t1 'Call Mrs. Smith' not found", { status: 404 }));
    const err = await updateTask("t1", { status: "approved" }).catch((e) => e);
    expect(err).toBeInstanceOf(FieldyApiError);
    expect(err.message).toBe("[fieldy] PATCH /tasks/{id} failed: http_404");
  });

  it("refuses without a key and makes no request", async () => {
    delete process.env.FIELDY_API_KEY;
    await expect(updateTask("t1", { status: "approved" })).rejects.toMatchObject({ code: "key_not_set" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createTask", () => {
  it("POSTs the title and due date and returns the new task", async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: "t9", title: "Call the Navien rep", status: "new", date: "2026-11-23T17:00:00.000Z" }));

    const task = await createTask({ title: "Call the Navien rep", date: "2026-11-23T17:00:00.000Z" });

    expect(task).toEqual({ id: "t9", title: "Call the Navien rep", status: "new", date: "2026-11-23T17:00:00.000Z", completionDate: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${FIELDY_API_BASE}/tasks`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ title: "Call the Navien rep", date: "2026-11-23T17:00:00.000Z" });
  });

  it("throws bad_response when the reply isn't a task", async () => {
    fetchMock.mockResolvedValueOnce(ok({ ok: true }));
    await expect(createTask({ title: "x", date: "2026-11-23T17:00:00.000Z" })).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("listConversations", () => {
  it("asks for the time range and keeps only id, title, summary and startTime", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        items: [
          {
            id: "c1",
            title: "Troy boiler walkthrough",
            summary: "Talked through the Navien install.",
            content: "FULL TRANSCRIPT",
            quotes: [{ text: "q", context: null }],
            speakers: ["Dave"],
            location: { address: "1 Main St" },
            startTime: "2026-11-22T15:00:00.000Z",
            locked: false,
          },
          { id: "c2", title: null, summary: null, startTime: "2026-11-22T16:00:00.000Z", locked: true },
        ],
        nextCursor: null,
      })
    );

    const convs = await listConversations("2026-11-22T13:00:00.000Z", "2026-11-23T13:00:00.000Z");

    expect(convs).toEqual([
      { id: "c1", title: "Troy boiler walkthrough", summary: "Talked through the Navien install.", startTime: "2026-11-22T15:00:00.000Z" },
    ]);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/api/public/v2/conversations");
    expect(url.searchParams.get("startTime")).toBe("2026-11-22T13:00:00.000Z");
    expect(url.searchParams.get("endTime")).toBe("2026-11-23T13:00:00.000Z");
    expect(url.searchParams.get("pageSize")).toBe(String(CONVERSATION_MAX));
  });

  it("follows nextCursor and stops at CONVERSATION_MAX", async () => {
    const page = (from: number, n: number, next: string | null) =>
      ok({
        items: Array.from({ length: n }, (_, i) => ({ id: `c${from + i}`, title: "t", summary: "s", startTime: "2026-11-22T15:00:00.000Z" })),
        nextCursor: next,
      });
    fetchMock.mockResolvedValueOnce(page(0, 15, "p2")).mockResolvedValueOnce(page(15, 15, "p3"));

    const convs = await listConversations("a", "b");

    expect(convs).toHaveLength(CONVERSATION_MAX);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("cursor")).toBe("p2");
  });
});
```

Then append inside the existing `describe("describeFieldyError", …)` in `src/lib/fieldy/__tests__/fieldy.test.ts`:

```ts
  it("says 'update' for a failed write and explains update_failed", () => {
    const text = describeFieldyError(new FieldyApiError("update_failed", "PATCH /tasks/{id}"));
    expect(text).toMatch(/^Couldn't update Fieldy: update_failed\./);
    expect(text).toMatch(/deleted/);
  });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run src/lib/fieldy/__tests__/client.test.ts src/lib/fieldy/__tests__/fieldy.test.ts`
Expected: FAIL, with `updateTask`, `createTask` and `listConversations` not exported and the describeFieldyError assertion mismatching.

- [ ] **Step 3: Implement.** In `src/lib/fieldy/client.ts`:

(a) Replace the header comment block (everything above `export const FIELDY_API_BASE`) with:

```ts
// Fieldy Public API: Dave's tasks and conversation summaries.
//
// Everything this app does in Fieldy, and nothing else:
//   - reads tasks                    GET   /tasks?status=<status>
//   - reads conversation summaries   GET   /conversations?startTime&endTime
//   - marks a task done or open      PATCH /tasks/{id}  { status, completionDate? }
//   - creates a task                 POST  /tasks       { title, date }
// It never deletes anything and never reads transcripts.
//
// Checked 2026-11-21 against the OpenAPI spec embedded in https://api.fieldy.ai/docs:
//   - Auth:       Authorization: Bearer sk-fieldy-…  (Fieldy app → Settings → Developer Settings)
//   - GET /tasks: `status` is required, ONE of new | approved | completed | rejected | skipped | cancelled | expired.
//                 200 body { items: [{ id, title, status, date?, memoryId?, completionDate?, cancellationDate? }] }
//   - PATCH /tasks/{id}: body { title?, date?, status?, completionDate?, cancellationDate? }; 200 { success, task|null }
//   - POST /tasks: body { title, date } (both required; date is ISO 8601); 200 is the task
//   - GET /conversations: startTime and endTime required (ISO 8601), pageSize 1–50, cursor/nextCursor paging.
//                 Items carry content, quotes, speakers and location too; this module drops them on read.
//                 `locked: true` items are redacted by the free plan and are skipped.
//   - Rate limit: 100 requests per 60 seconds per key; 429 beyond that.
//
// Errors carry a short code ("http_401", "timeout" …) and the operation, never
// the response body or the key: bodies can hold task text with customer details.
```

(b) Below `const MAX_PAGES = 10;` add:

```ts
/** Conversations read per call, at most. */
export const CONVERSATION_MAX = 20;
```

(c) Below the `FieldyTask` type add:

```ts
/** A conversation as this app keeps it: no transcript, quotes, speakers or location. */
export type ConversationSummary = { id: string; title: string | null; summary: string | null; startTime: string };

/** The two changes this app makes to a task. */
export type TaskUpdate = { status: "completed"; completionDate: string } | { status: "approved" };
```

(d) Replace the `FieldyApiError` class with:

```ts
export class FieldyApiError extends Error {
  constructor(
    readonly code: string,
    readonly op: string = "GET /tasks"
  ) {
    super(`[fieldy] ${op} failed: ${code}`);
    this.name = "FieldyApiError";
  }
}
```

(e) Replace the whole `getPage` function with these three functions:

```ts
function requireKey(op: string): string {
  const key = fieldyApiKey();
  if (!key) throw new FieldyApiError("key_not_set", op);
  return key;
}

type Method = "GET" | "POST" | "PATCH";

async function request(
  key: string,
  method: Method,
  path: string,
  op: string,
  opts: { query?: URLSearchParams; body?: Record<string, unknown> } = {}
): Promise<Record<string, unknown>> {
  const url = `${FIELDY_API_BASE}${path}${opts.query ? `?${opts.query}` : ""}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  if (opts.body) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // The underlying message is dropped on purpose; see the module note.
    throw new FieldyApiError(err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network", op);
  }

  if (!res.ok) throw new FieldyApiError(`http_${res.status}`, op);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new FieldyApiError("bad_response", op);
  }
  if (!body || typeof body !== "object") throw new FieldyApiError("bad_response", op);
  return body as Record<string, unknown>;
}

async function getPage(key: string, status: FieldyTaskStatus, cursor: string | null): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ status });
  if (cursor) query.set("cursor", cursor);
  const body = await request(key, "GET", "/tasks", "GET /tasks", { query });
  if (!Array.isArray(body.items)) throw new FieldyApiError("bad_response");
  return body;
}
```

(f) In `listTasks`, replace its first two lines with `const key = requireKey("GET /tasks");`.

(g) Append at the end of the file:

```ts
/** Marks a task done (`completed` + completionDate) or open again (`approved`). */
export async function updateTask(id: string, update: TaskUpdate): Promise<FieldyTask> {
  const op = "PATCH /tasks/{id}";
  const key = requireKey(op);
  const body = await request(key, "PATCH", `/tasks/${encodeURIComponent(id)}`, op, { body: update });
  if (body.success !== true) throw new FieldyApiError("update_failed", op);
  const task = toTask(body.task);
  if (!task) throw new FieldyApiError("bad_response", op);
  return task;
}

/** A new task. Fieldy requires both fields; `date` is the ISO 8601 due date. */
export async function createTask(input: { title: string; date: string }): Promise<FieldyTask> {
  const op = "POST /tasks";
  const key = requireKey(op);
  const task = toTask(await request(key, "POST", "/tasks", op, { body: input }));
  if (!task) throw new FieldyApiError("bad_response", op);
  return task;
}

/** One raw conversation, cut down to what the checklist needs; null if locked or malformed. */
export function toConversation(raw: unknown): ConversationSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.locked === true) return null;
  const id = str(r.id);
  const startTime = str(r.startTime);
  if (!id || !startTime) return null;
  return { id, title: str(r.title), summary: str(r.summary), startTime };
}

/** Conversations that started in the range, at most CONVERSATION_MAX. */
export async function listConversations(startIso: string, endIso: string): Promise<ConversationSummary[]> {
  const op = "GET /conversations";
  const key = requireKey(op);
  const out: ConversationSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ startTime: startIso, endTime: endIso, pageSize: String(CONVERSATION_MAX) });
    if (cursor) query.set("cursor", cursor);
    const body = await request(key, "GET", "/conversations", op, { query });
    if (!Array.isArray(body.items)) throw new FieldyApiError("bad_response", op);
    for (const raw of body.items as unknown[]) {
      const c = toConversation(raw);
      if (c) out.push(c);
      if (out.length >= CONVERSATION_MAX) return out;
    }
    cursor = nextCursorOf(body);
    if (!cursor) return out;
  }
  throw new FieldyApiError("too_many_pages", op);
}
```

(h) In `src/lib/fieldy/fieldy.ts`, add two entries to `FIXES`:

```ts
  http_404: "Fieldy doesn't have that task any more. It may have been deleted in the Fieldy app.",
  update_failed: "Fieldy didn't accept the change. The task may have been deleted in the Fieldy app.",
```

Then change the last line of `describeFieldyError` to:

```ts
  const verb = err.op.startsWith("GET") ? "read" : "update";
  return `Couldn't ${verb} Fieldy: ${err.code}. ${fix}`;
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run src/lib/fieldy`
Expected: PASS, including every pre-existing `listTasks` and `describeFieldyError` test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fieldy
git commit -m "feat(fieldy): task updates, task creation and conversation summaries in the client"
```

---

### Task 2: Supabase tables and the checklist store

**Files:**
- Create: `supabase/migrations/0008_task_checklists.sql`
- Create: `src/lib/tasks/store.ts`
- Create: `src/lib/tasks/__tests__/fakes.ts` (the shared test doubles; later tasks import it)
- Test: `src/lib/tasks/__tests__/store.test.ts`

**Interfaces:**
- Produces, from `store.ts`:

```ts
export type BuiltBy = "morning_ai" | "morning_rules" | "chatgpt";
export type DoneVia = "chatgpt" | "slack" | "fieldy";
export type ChecklistRow = { id: number; day: string; channelId: string; messageTs: string | null; builtBy: BuiltBy; version: number; renderedVersion: number; overflow: number; finishedYesterday: number };
export type ItemRow = { checklistId: number; position: number; groupName: string; text: string; fieldyTaskId: string; doneAt: string | null; doneVia: DoneVia | null };
export type NewItem = Omit<ItemRow, "checklistId">;
export interface ChecklistStore { getByDay; getById; create; updateMeta; setMessageTs; listItems; replaceItems; appendItem; setDone; touch; markRendered; listBehind }   // full signatures in Step 4
export function supabaseChecklistStore(db: SupabaseClient): ChecklistStore;
```

- Produces, from `__tests__/fakes.ts`: `NOW`, `TODAY`, `task()`, `memoryStore()`, `fakeFieldy()`, `fakeSlack()`, `makeDeps()`. Tasks 6, 7, 8 and 9 use them. `makeDeps` depends on the `ChecklistDeps` type from Task 6, so in this task the file is created **without `makeDeps`**. Task 6 Step 1 adds it.

- [ ] **Step 1: Write the migration** `supabase/migrations/0008_task_checklists.sql`:

```sql
-- supabase/migrations/0008_task_checklists.sql
--
-- Dave's daily Fieldy checklist in Slack. One row per Eastern day in
-- task_checklists, one row per task on it in task_checklist_items. Fieldy is
-- the source of truth for the tasks and whether they're done; these tables
-- hold the day's grouping and which Slack message shows it. Only task titles
-- and ids are stored, never recordings or summaries.
--
-- version goes up on every change; rendered_version is the version last shown
-- in Slack. behind (rendered_version < version) is what the 15-minute sync
-- uses to re-render a message whose last Slack update failed.
create table task_checklists (
  id                 bigint generated always as identity primary key,
  day                date not null unique,               -- Eastern calendar day
  channel_id         text not null,
  message_ts         text,                                -- null until posted
  built_by           text not null check (built_by in ('morning_ai', 'morning_rules', 'chatgpt')),
  version            int not null default 1,
  rendered_version   int not null default 0,
  behind             boolean generated always as (rendered_version < version) stored,
  overflow           int not null default 0,              -- open tasks past the 40-item cap
  finished_yesterday int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table task_checklist_items (
  id             bigint generated always as identity primary key,
  checklist_id   bigint not null references task_checklists (id) on delete cascade,
  position       int not null,
  group_name     text not null check (char_length(group_name) between 1 and 60),
  text           text not null check (char_length(text) between 1 and 75),
  fieldy_task_id text not null,
  done_at        timestamptz,
  done_via       text check (done_via in ('chatgpt', 'slack', 'fieldy')),
  unique (checklist_id, fieldy_task_id)
);

create index task_checklist_items_checklist_idx on task_checklist_items (checklist_id, position);
create index task_checklists_behind_idx on task_checklists (day) where behind;

-- Only the server touches these, through the service-role key (which bypasses
-- RLS). RLS with no policies keeps the browser's anon key out.
alter table task_checklists enable row level security;
alter table task_checklist_items enable row level security;

-- Bump the version; returns the new one.
create function task_checklist_touch(p_id bigint) returns int
language sql as $$
  update task_checklists set version = version + 1, updated_at = now()
  where id = p_id
  returning version;
$$;

-- Record what Slack is showing. greatest() so a slow, older render finishing
-- last can't make a newer one look unrendered.
create function task_checklist_rendered(p_id bigint, p_version int) returns void
language sql as $$
  update task_checklists set rendered_version = greatest(rendered_version, p_version)
  where id = p_id;
$$;

-- Swap a checklist's items in one transaction, so a render running at the
-- same moment never sees an empty list.
create function task_checklist_replace_items(p_id bigint, p_items jsonb) returns void
language plpgsql as $$
begin
  delete from task_checklist_items where checklist_id = p_id;
  insert into task_checklist_items (checklist_id, position, group_name, text, fieldy_task_id, done_at, done_via)
  select p_id,
         (i ->> 'position')::int,
         i ->> 'group_name',
         i ->> 'text',
         i ->> 'fieldy_task_id',
         (i ->> 'done_at')::timestamptz,
         i ->> 'done_via'
  from jsonb_array_elements(p_items) as i;
end;
$$;

-- Add one item at the end. A task already on the checklist is left alone.
create function task_checklist_append_item(p_id bigint, p_group text, p_text text, p_task_id text) returns void
language sql as $$
  insert into task_checklist_items (checklist_id, position, group_name, text, fieldy_task_id)
  select p_id, coalesce(max(position), 0) + 1, p_group, p_text, p_task_id
  from task_checklist_items
  where checklist_id = p_id
  on conflict (checklist_id, fieldy_task_id) do nothing;
$$;

revoke execute on function task_checklist_touch(bigint) from public, anon, authenticated;
revoke execute on function task_checklist_rendered(bigint, int) from public, anon, authenticated;
revoke execute on function task_checklist_replace_items(bigint, jsonb) from public, anon, authenticated;
revoke execute on function task_checklist_append_item(bigint, text, text, text) from public, anon, authenticated;
```

- [ ] **Step 2: Write the failing store test** `src/lib/tasks/__tests__/store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseChecklistStore } from "../store";

type Op = [string, unknown[]];
type Call = { table?: string; fn?: string; args?: unknown; ops: Op[] };

// A chainable stand-in for the Supabase query builder. Every method records
// itself and returns the chain; awaiting the chain resolves to `result`.
function fakeDb(result: { data?: unknown; error?: { message: string } | null } = {}) {
  const calls: Call[] = [];
  const chain = (call: Call): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null });
          }
          return (...args: unknown[]) => {
            call.ops.push([prop, args]);
            return chain(call);
          };
        },
      }
    );
  const db = {
    from(table: string) {
      const c: Call = { table, ops: [] };
      calls.push(c);
      return chain(c);
    },
    rpc(fn: string, args: unknown) {
      const c: Call = { fn, args, ops: [] };
      calls.push(c);
      return chain(c);
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const ROW = {
  id: 7,
  day: "2026-11-23",
  channel_id: "C1",
  message_ts: "171.1",
  built_by: "morning_ai",
  version: 3,
  rendered_version: 2,
  overflow: 0,
  finished_yesterday: 4,
};

describe("supabaseChecklistStore", () => {
  it("reads a day's checklist and maps it to camelCase", async () => {
    const { db, calls } = fakeDb({ data: ROW });
    const row = await supabaseChecklistStore(db).getByDay("2026-11-23");
    expect(row).toEqual({
      id: 7,
      day: "2026-11-23",
      channelId: "C1",
      messageTs: "171.1",
      builtBy: "morning_ai",
      version: 3,
      renderedVersion: 2,
      overflow: 0,
      finishedYesterday: 4,
    });
    expect(calls[0].table).toBe("task_checklists");
    expect(calls[0].ops).toContainEqual(["eq", ["day", "2026-11-23"]]);
  });

  it("returns null when there's no checklist that day", async () => {
    const { db } = fakeDb({ data: null });
    expect(await supabaseChecklistStore(db).getByDay("2026-11-23")).toBeNull();
  });

  it("bumps the version through task_checklist_touch and returns it", async () => {
    const { db, calls } = fakeDb({ data: 4 });
    expect(await supabaseChecklistStore(db).touch(7)).toBe(4);
    expect(calls[0]).toMatchObject({ fn: "task_checklist_touch", args: { p_id: 7 } });
  });

  it("replaces items in one call with snake_case rows", async () => {
    const { db, calls } = fakeDb();
    await supabaseChecklistStore(db).replaceItems(7, [
      { position: 1, groupName: "Troy job", text: "Order the boiler", fieldyTaskId: "t1", doneAt: null, doneVia: null },
    ]);
    expect(calls[0]).toMatchObject({
      fn: "task_checklist_replace_items",
      args: {
        p_id: 7,
        p_items: [{ position: 1, group_name: "Troy job", text: "Order the boiler", fieldy_task_id: "t1", done_at: null, done_via: null }],
      },
    });
  });

  it("makes no query when there is nothing to tick", async () => {
    const { db, calls } = fakeDb();
    await supabaseChecklistStore(db).setDone(7, [], "2026-11-23T13:00:00.000Z", "slack");
    expect(calls).toHaveLength(0);
  });

  it("ticks the given tasks on one checklist", async () => {
    const { db, calls } = fakeDb();
    await supabaseChecklistStore(db).setDone(7, ["t1", "t2"], "2026-11-23T13:00:00.000Z", "slack");
    expect(calls[0].table).toBe("task_checklist_items");
    expect(calls[0].ops).toEqual([
      ["update", [{ done_at: "2026-11-23T13:00:00.000Z", done_via: "slack" }]],
      ["eq", ["checklist_id", 7]],
      ["in", ["fieldy_task_id", ["t1", "t2"]]],
    ]);
  });

  it("lists checklists Slack is behind on, from a given day", async () => {
    const { db, calls } = fakeDb({ data: [ROW] });
    const rows = await supabaseChecklistStore(db).listBehind("2026-11-22");
    expect(rows.map((r) => r.id)).toEqual([7]);
    expect(calls[0].ops).toContainEqual(["eq", ["behind", true]]);
    expect(calls[0].ops).toContainEqual(["gte", ["day", "2026-11-22"]]);
  });

  it("throws with the operation name on a database error", async () => {
    const { db } = fakeDb({ error: { message: "permission denied" } });
    await expect(supabaseChecklistStore(db).listItems(7)).rejects.toThrow("[tasks] listItems failed: permission denied");
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run src/lib/tasks/__tests__/store.test.ts`
Expected: FAIL, because `../store` doesn't exist.

- [ ] **Step 4: Implement** `src/lib/tasks/store.ts`:

```ts
// Where Dave's daily checklist lives between changes: the grouping, which
// Slack message shows it, and which items are ticked. Tables: migration 0008.
// Server-only, through the service-role client.
import type { SupabaseClient } from "@supabase/supabase-js";

export type BuiltBy = "morning_ai" | "morning_rules" | "chatgpt";
export type DoneVia = "chatgpt" | "slack" | "fieldy";

export type ChecklistRow = {
  id: number;
  /** Eastern calendar day, YYYY-MM-DD. */
  day: string;
  channelId: string;
  messageTs: string | null;
  builtBy: BuiltBy;
  version: number;
  renderedVersion: number;
  overflow: number;
  finishedYesterday: number;
};

export type ItemRow = {
  checklistId: number;
  position: number;
  groupName: string;
  text: string;
  fieldyTaskId: string;
  doneAt: string | null;
  doneVia: DoneVia | null;
};

export type NewItem = Omit<ItemRow, "checklistId">;

export interface ChecklistStore {
  getByDay(day: string): Promise<ChecklistRow | null>;
  getById(id: number): Promise<ChecklistRow | null>;
  /** The day's checklist, created if missing. Safe to call twice for the same day. */
  create(input: { day: string; channelId: string; builtBy: BuiltBy }): Promise<ChecklistRow>;
  updateMeta(id: number, meta: { builtBy: BuiltBy; overflow: number; finishedYesterday: number }): Promise<void>;
  setMessageTs(id: number, ts: string): Promise<void>;
  /** Items in position order. */
  listItems(id: number): Promise<ItemRow[]>;
  replaceItems(id: number, items: NewItem[]): Promise<void>;
  /** Adds at the end; does nothing if the task is already on this checklist. */
  appendItem(id: number, item: { groupName: string; text: string; fieldyTaskId: string }): Promise<void>;
  setDone(id: number, fieldyTaskIds: string[], doneAt: string | null, via: DoneVia | null): Promise<void>;
  /** version + 1; returns the new version. */
  touch(id: number): Promise<number>;
  markRendered(id: number, version: number): Promise<void>;
  /** Checklists from `sinceDay` on whose Slack message is behind the database (or was never posted). */
  listBehind(sinceDay: string): Promise<ChecklistRow[]>;
}

const CHECKLIST_COLS = "id, day, channel_id, message_ts, built_by, version, rendered_version, overflow, finished_yesterday";
const ITEM_COLS = "checklist_id, position, group_name, text, fieldy_task_id, done_at, done_via";

type Err = { message: string } | null;

function check(op: string, error: Err): void {
  // Supabase puts row data in `details`, not `message`; only the message is used.
  if (error) throw new Error(`[tasks] ${op} failed: ${error.message}`);
}

function toChecklist(r: Record<string, unknown>): ChecklistRow {
  return {
    id: Number(r.id),
    day: String(r.day),
    channelId: String(r.channel_id),
    messageTs: (r.message_ts as string | null) ?? null,
    builtBy: r.built_by as BuiltBy,
    version: Number(r.version),
    renderedVersion: Number(r.rendered_version),
    overflow: Number(r.overflow),
    finishedYesterday: Number(r.finished_yesterday),
  };
}

function toItem(r: Record<string, unknown>): ItemRow {
  return {
    checklistId: Number(r.checklist_id),
    position: Number(r.position),
    groupName: String(r.group_name),
    text: String(r.text),
    fieldyTaskId: String(r.fieldy_task_id),
    doneAt: (r.done_at as string | null) ?? null,
    doneVia: (r.done_via as DoneVia | null) ?? null,
  };
}

export function supabaseChecklistStore(db: SupabaseClient): ChecklistStore {
  async function getByDay(day: string): Promise<ChecklistRow | null> {
    const { data, error } = await db.from("task_checklists").select(CHECKLIST_COLS).eq("day", day).maybeSingle();
    check("getByDay", error);
    return data ? toChecklist(data as Record<string, unknown>) : null;
  }

  return {
    getByDay,

    async getById(id) {
      const { data, error } = await db.from("task_checklists").select(CHECKLIST_COLS).eq("id", id).maybeSingle();
      check("getById", error);
      return data ? toChecklist(data as Record<string, unknown>) : null;
    },

    async create({ day, channelId, builtBy }) {
      const { error } = await db
        .from("task_checklists")
        .upsert({ day, channel_id: channelId, built_by: builtBy }, { onConflict: "day", ignoreDuplicates: true });
      check("create", error);
      const row = await getByDay(day);
      if (!row) throw new Error("[tasks] create failed: row missing after insert");
      return row;
    },

    async updateMeta(id, meta) {
      const { error } = await db
        .from("task_checklists")
        .update({
          built_by: meta.builtBy,
          overflow: meta.overflow,
          finished_yesterday: meta.finishedYesterday,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      check("updateMeta", error);
    },

    async setMessageTs(id, ts) {
      const { error } = await db.from("task_checklists").update({ message_ts: ts }).eq("id", id);
      check("setMessageTs", error);
    },

    async listItems(id) {
      const { data, error } = await db.from("task_checklist_items").select(ITEM_COLS).eq("checklist_id", id).order("position");
      check("listItems", error);
      return ((data ?? []) as Record<string, unknown>[]).map(toItem);
    },

    async replaceItems(id, items) {
      const { error } = await db.rpc("task_checklist_replace_items", {
        p_id: id,
        p_items: items.map((i) => ({
          position: i.position,
          group_name: i.groupName,
          text: i.text,
          fieldy_task_id: i.fieldyTaskId,
          done_at: i.doneAt,
          done_via: i.doneVia,
        })),
      });
      check("replaceItems", error);
    },

    async appendItem(id, item) {
      const { error } = await db.rpc("task_checklist_append_item", {
        p_id: id,
        p_group: item.groupName,
        p_text: item.text,
        p_task_id: item.fieldyTaskId,
      });
      check("appendItem", error);
    },

    async setDone(id, fieldyTaskIds, doneAt, via) {
      if (fieldyTaskIds.length === 0) return;
      const { error } = await db
        .from("task_checklist_items")
        .update({ done_at: doneAt, done_via: via })
        .eq("checklist_id", id)
        .in("fieldy_task_id", fieldyTaskIds);
      check("setDone", error);
    },

    async touch(id) {
      const { data, error } = await db.rpc("task_checklist_touch", { p_id: id });
      check("touch", error);
      if (typeof data !== "number") throw new Error("[tasks] touch failed: checklist not found");
      return data;
    },

    async markRendered(id, version) {
      const { error } = await db.rpc("task_checklist_rendered", { p_id: id, p_version: version });
      check("markRendered", error);
    },

    async listBehind(sinceDay) {
      const { data, error } = await db.from("task_checklists").select(CHECKLIST_COLS).eq("behind", true).gte("day", sinceDay);
      check("listBehind", error);
      return ((data ?? []) as Record<string, unknown>[]).map(toChecklist);
    },
  };
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `npx vitest run src/lib/tasks/__tests__/store.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Create the shared test doubles** `src/lib/tasks/__tests__/fakes.ts`. `makeDeps` is added in Task 6.

```ts
// Test doubles shared by the checklist, morning, connector and Slack-tap tests.
import { FieldyApiError, type ConversationSummary, type FieldyTask, type TaskUpdate } from "@/lib/fieldy/client";
import type { ChecklistRow, ChecklistStore, ItemRow } from "../store";

// 8:00 AM Eastern, Mon Nov 23 2026.
export const NOW = new Date("2026-11-23T13:00:00.000Z");
export const TODAY = "2026-11-23";

export function task(id: string, title: string, extra: Partial<FieldyTask> = {}): FieldyTask {
  return { id, title, status: "approved", date: null, completionDate: null, ...extra };
}

/** ChecklistStore in memory, with the same version rules as migration 0008. */
export function memoryStore() {
  let nextId = 1;
  const lists = new Map<number, ChecklistRow>();
  const items = new Map<number, ItemRow[]>();

  const store: ChecklistStore = {
    async getByDay(day) {
      const row = Array.from(lists.values()).find((l) => l.day === day);
      return row ? { ...row } : null;
    },
    async getById(id) {
      const row = lists.get(id);
      return row ? { ...row } : null;
    },
    async create({ day, channelId, builtBy }) {
      const existing = await store.getByDay(day);
      if (existing) return existing;
      const row: ChecklistRow = {
        id: nextId++,
        day,
        channelId,
        messageTs: null,
        builtBy,
        version: 1,
        renderedVersion: 0,
        overflow: 0,
        finishedYesterday: 0,
      };
      lists.set(row.id, row);
      items.set(row.id, []);
      return { ...row };
    },
    async updateMeta(id, meta) {
      Object.assign(lists.get(id)!, meta);
    },
    async setMessageTs(id, ts) {
      lists.get(id)!.messageTs = ts;
    },
    async listItems(id) {
      return (items.get(id) ?? []).map((i) => ({ ...i })).sort((a, b) => a.position - b.position);
    },
    async replaceItems(id, next) {
      items.set(
        id,
        next.map((i) => ({ ...i, checklistId: id }))
      );
    },
    async appendItem(id, item) {
      const list = items.get(id)!;
      if (list.some((i) => i.fieldyTaskId === item.fieldyTaskId)) return;
      const position = list.reduce((max, i) => Math.max(max, i.position), 0) + 1;
      list.push({ checklistId: id, position, ...item, doneAt: null, doneVia: null });
    },
    async setDone(id, ids, doneAt, via) {
      for (const i of items.get(id) ?? []) {
        if (ids.includes(i.fieldyTaskId)) {
          i.doneAt = doneAt;
          i.doneVia = via;
        }
      }
    },
    async touch(id) {
      const row = lists.get(id)!;
      row.version += 1;
      return row.version;
    },
    async markRendered(id, version) {
      const row = lists.get(id)!;
      row.renderedVersion = Math.max(row.renderedVersion, version);
    },
    async listBehind(sinceDay) {
      return Array.from(lists.values())
        .filter((l) => l.day >= sinceDay && l.renderedVersion < l.version)
        .map((l) => ({ ...l }));
    },
  };

  return { store, lists, items };
}

/** Fieldy with tasks in memory. Records every write. */
export function fakeFieldy(initial: FieldyTask[] = []) {
  const state = new Map(initial.map((t) => [t.id, { ...t }]));
  const updates: Array<[string, TaskUpdate]> = [];
  const created: Array<{ title: string; date: string }> = [];
  let recordings: ConversationSummary[] = [];
  let updateCalls = 0;
  let failAt: { n: number; err: Error } | null = null;
  let nextId = 100;

  const port = {
    async tasks(): Promise<FieldyTask[]> {
      return Array.from(state.values())
        .filter((t) => ["new", "approved", "completed"].includes(t.status))
        .map((t) => ({ ...t }));
    },
    async completed(): Promise<FieldyTask[]> {
      return Array.from(state.values())
        .filter((t) => t.status === "completed")
        .map((t) => ({ ...t }));
    },
    async update(id: string, update: TaskUpdate): Promise<FieldyTask> {
      updateCalls += 1;
      if (failAt && failAt.n === updateCalls) throw failAt.err;
      const t = state.get(id);
      if (!t) throw new FieldyApiError("http_404", "PATCH /tasks/{id}");
      updates.push([id, update]);
      t.status = update.status;
      t.completionDate = update.status === "completed" ? update.completionDate : null;
      return { ...t };
    },
    async create(input: { title: string; date: string }): Promise<FieldyTask> {
      const t: FieldyTask = { id: `t${nextId++}`, title: input.title, status: "new", date: input.date, completionDate: null };
      state.set(t.id, t);
      created.push(input);
      return { ...t };
    },
    async conversations(): Promise<ConversationSummary[]> {
      return recordings;
    },
  };

  return {
    port,
    state,
    updates,
    created,
    setRecordings(r: ConversationSummary[]) {
      recordings = r;
    },
    /** The nth update call (1-based, counted from now on) throws `err`. */
    failUpdateAt(n: number, err: Error) {
      failAt = { n: updateCalls + n, err };
    },
  };
}

/** Slack that records posts and updates. `onUpdate` runs inside each update, before it returns. */
export function fakeSlack(opts: { onUpdate?: () => Promise<void> } = {}) {
  const posts: Array<{ channel: string; text: string; blocks: unknown[] }> = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  let n = 0;
  const port = {
    async post(channel: string, text: string, blocks: unknown[]): Promise<string> {
      posts.push({ channel, text, blocks });
      n += 1;
      return `171.${n}`;
    },
    async update(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void> {
      updates.push({ channel, ts, text, blocks });
      if (opts.onUpdate) await opts.onUpdate();
    },
  };
  return {
    port,
    posts,
    updates,
    /** The blocks Slack is showing now. */
    lastBlocks(): unknown[] {
      const all = [...posts, ...updates];
      return all.length ? all[all.length - 1].blocks : [];
    },
  };
}
```

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add supabase/migrations/0008_task_checklists.sql src/lib/tasks/store.ts src/lib/tasks/__tests__/store.test.ts src/lib/tasks/__tests__/fakes.ts
git commit -m "feat(tasks): checklist tables and store"
```

---

### Task 3: Grouping (validation and rules fallback)

**Files:**
- Create: `src/lib/tasks/organize.ts`
- Modify: `src/lib/fieldy/report.ts` (export `uniqueById`; nothing else changes in this task)
- Test: `src/lib/tasks/__tests__/organize.test.ts`

**Interfaces:**
- Consumes: `pendingTasks` and `dayKeyOf` from `@/lib/fieldy/report`; `localDateKey` from `@/lib/notifications/schedule`; `FieldyTask` and `ConversationSummary` from Task 1.
- Produces:

```ts
export const ITEM_TEXT_MAX = 75, GROUP_NAME_MAX = 60, MAX_ITEMS = 40, MAX_GROUPS = 12, OTHER_GROUP = "Other";
export type ProposedGroup = { name: string; items: { taskId: string; text?: string }[] };
export type ChecklistGroup = { name: string; items: { taskId: string; text: string }[] };
export type Grouping = { groups: ChecklistGroup[]; overflow: number; movedToOther: string[]; dropped: string[] };
export type Organizer = (open: FieldyTask[], recordings: ConversationSummary[]) => Promise<ProposedGroup[] | null>;
export function fitText(value: string, max?: number): string;
export function validateGrouping(proposed: ProposedGroup[], open: FieldyTask[]): Grouping;
export function groupByRules(open: FieldyTask[], now: Date): ProposedGroup[];
// report.ts:
export function uniqueById(tasks: FieldyTask[]): FieldyTask[];
```

- [ ] **Step 1: Write the failing test** `src/lib/tasks/__tests__/organize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MAX_GROUPS, MAX_ITEMS, OTHER_GROUP, fitText, groupByRules, validateGrouping } from "../organize";
import { NOW, task } from "./fakes";

const OPEN = [
  task("t1", "Order Navien NPE-240A for the Troy job", { date: "2026-11-20" }),
  task("t2", "Call back Mrs. Smith about the water heater quote", { date: "2026-11-23" }),
  task("t3", "Send Dylan the van inventory list"),
];

describe("fitText", () => {
  it("flattens whitespace and cuts long text with an ellipsis", () => {
    expect(fitText("  a\n  b  ")).toBe("a b");
    const long = "x".repeat(100);
    expect(fitText(long)).toHaveLength(75);
    expect(fitText(long).endsWith("…")).toBe(true);
  });
});

describe("validateGrouping", () => {
  it("keeps the proposed groups and text for known tasks", () => {
    const g = validateGrouping(
      [
        { name: "Troy job", items: [{ taskId: "t1", text: "Order the Navien" }] },
        { name: "Calls", items: [{ taskId: "t2", text: "Call Mrs. Smith" }, { taskId: "t3", text: "Dylan: van list" }] },
      ],
      OPEN
    );
    expect(g.groups).toEqual([
      { name: "Troy job", items: [{ taskId: "t1", text: "Order the Navien" }] },
      { name: "Calls", items: [{ taskId: "t2", text: "Call Mrs. Smith" }, { taskId: "t3", text: "Dylan: van list" }] },
    ]);
    expect(g).toMatchObject({ overflow: 0, movedToOther: [], dropped: [] });
  });

  it("drops unknown and repeated ids and never invents a task", () => {
    const g = validateGrouping([{ name: "A", items: [{ taskId: "t1" }, { taskId: "nope" }, { taskId: "t1" }] }], OPEN);
    expect(g.dropped).toEqual(["nope", "t1"]);
    expect(g.groups.flatMap((x) => x.items.map((i) => i.taskId)).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("puts open tasks the grouping left out under Other, last", () => {
    const g = validateGrouping([{ name: "Troy job", items: [{ taskId: "t1" }] }], OPEN);
    expect(g.groups.map((x) => x.name)).toEqual(["Troy job", OTHER_GROUP]);
    expect(g.movedToOther).toEqual(["t2", "t3"]);
  });

  it("uses the Fieldy title when the text is empty", () => {
    const g = validateGrouping([{ name: "A", items: [{ taskId: "t3", text: "   " }] }], [OPEN[2]]);
    expect(g.groups[0].items[0].text).toBe("Send Dylan the van inventory list");
  });

  it("merges groups with the same name, ignoring case", () => {
    const g = validateGrouping([{ name: "Calls", items: [{ taskId: "t2" }] }, { name: "calls", items: [{ taskId: "t3" }] }], OPEN.slice(1));
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0].items.map((i) => i.taskId)).toEqual(["t2", "t3"]);
  });

  it("folds groups past the cap into Other", () => {
    const many = Array.from({ length: 15 }, (_, i) => task(`g${i}`, `Task ${i}`));
    const g = validateGrouping(
      many.map((t) => ({ name: `Group ${t.id}`, items: [{ taskId: t.id }] })),
      many
    );
    expect(g.groups).toHaveLength(MAX_GROUPS);
    expect(g.groups[MAX_GROUPS - 1].name).toBe(OTHER_GROUP);
    expect(g.groups[MAX_GROUPS - 1].items).toHaveLength(15 - (MAX_GROUPS - 1));
  });

  it("caps the checklist at MAX_ITEMS and counts the rest as overflow", () => {
    const many = Array.from({ length: 45 }, (_, i) => task(`m${i}`, `Task ${i}`));
    const g = validateGrouping([{ name: "All", items: many.map((t) => ({ taskId: t.id })) }], many);
    expect(g.groups[0].items).toHaveLength(MAX_ITEMS);
    expect(g.overflow).toBe(5);
  });
});

describe("groupByRules", () => {
  it("groups into Overdue, Due today, No date and Later, skipping empty groups", () => {
    const later = task("t4", "Winterize the Delmar cabin", { date: "2026-12-01" });
    const groups = groupByRules([...OPEN, later], NOW);
    expect(groups.map((g) => g.name)).toEqual(["Overdue", "Due today", "No date", "Later"]);
    expect(groups[0].items).toEqual([{ taskId: "t1", text: "Order Navien NPE-240A for the Troy job" }]);
    expect(groupByRules([OPEN[2]], NOW).map((g) => g.name)).toEqual(["No date"]);
  });

  it("ignores tasks that aren't open", () => {
    expect(groupByRules([task("x", "Done", { status: "completed" })], NOW)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/tasks/__tests__/organize.test.ts`
Expected: FAIL, because `../organize` doesn't exist.

- [ ] **Step 3: Implement.** In `src/lib/fieldy/report.ts`, change `function uniqueById(` to `export function uniqueById(`.

Create `src/lib/tasks/organize.ts`:

```ts
// Turning Dave's open Fieldy tasks into checklist groups. validateGrouping is
// the one gate every grouping passes through (OpenAI's, ChatGPT's, the rules
// fallback), so whatever proposed it, no open task is lost and none is invented.
import type { ConversationSummary, FieldyTask } from "@/lib/fieldy/client";
import { dayKeyOf, pendingTasks } from "@/lib/fieldy/report";
import { localDateKey } from "@/lib/notifications/schedule";

/** Slack's limit for a checkbox label. */
export const ITEM_TEXT_MAX = 75;
export const GROUP_NAME_MAX = 60;
/** With MAX_GROUPS this keeps the message far inside Slack's 50 blocks. */
export const MAX_ITEMS = 40;
export const MAX_GROUPS = 12;
export const OTHER_GROUP = "Other";

export type ProposedGroup = { name: string; items: { taskId: string; text?: string }[] };
export type ChecklistGroup = { name: string; items: { taskId: string; text: string }[] };
export type Grouping = {
  groups: ChecklistGroup[];
  /** Open tasks past MAX_ITEMS, not on the checklist. */
  overflow: number;
  /** Open tasks the proposal left out, added under Other. */
  movedToOther: string[];
  /** Ids in the proposal that aren't open tasks, or appeared twice. */
  dropped: string[];
};

/** Proposes a grouping, or null when it couldn't (the caller falls back to rules). */
export type Organizer = (open: FieldyTask[], recordings: ConversationSummary[]) => Promise<ProposedGroup[] | null>;

export function fitText(value: string, max = ITEM_TEXT_MAX): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function validateGrouping(proposed: ProposedGroup[], open: FieldyTask[]): Grouping {
  const ordered = pendingTasks(open);
  const byId = new Map(ordered.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const dropped: string[] = [];
  const groups: ChecklistGroup[] = [];
  const byName = new Map<string, ChecklistGroup>();

  const groupFor = (rawName: string): ChecklistGroup => {
    const name = fitText(rawName, GROUP_NAME_MAX) || OTHER_GROUP;
    const key = name.toLowerCase();
    let g = byName.get(key);
    if (!g) {
      g = { name, items: [] };
      byName.set(key, g);
      groups.push(g);
    }
    return g;
  };

  for (const pg of proposed) {
    for (const item of pg.items) {
      const t = byId.get(item.taskId);
      if (!t || seen.has(item.taskId)) {
        dropped.push(item.taskId);
        continue;
      }
      seen.add(item.taskId);
      groupFor(pg.name).items.push({ taskId: t.id, text: fitText(item.text ?? "") || fitText(t.title) });
    }
  }

  const otherKey = OTHER_GROUP.toLowerCase();
  const other: ChecklistGroup = byName.get(otherKey) ?? { name: OTHER_GROUP, items: [] };
  let named = groups.filter((g) => g.name.toLowerCase() !== otherKey);
  if (named.length > MAX_GROUPS - 1) {
    for (const g of named.slice(MAX_GROUPS - 1)) other.items.push(...g.items);
    named = named.slice(0, MAX_GROUPS - 1);
  }

  const movedToOther: string[] = [];
  for (const t of ordered) {
    if (seen.has(t.id)) continue;
    other.items.push({ taskId: t.id, text: fitText(t.title) });
    movedToOther.push(t.id);
  }

  const all = other.items.length > 0 ? [...named, other] : named;
  let budget = MAX_ITEMS;
  let overflow = 0;
  const capped: ChecklistGroup[] = [];
  for (const g of all) {
    const take = g.items.slice(0, Math.max(0, budget));
    overflow += g.items.length - take.length;
    budget -= take.length;
    if (take.length > 0) capped.push({ name: g.name, items: take });
  }

  return { groups: capped, overflow, movedToOther, dropped };
}

/** The fallback when OpenAI can't group: by due date, oldest first within each group. */
export function groupByRules(open: FieldyTask[], now: Date): ProposedGroup[] {
  const today = localDateKey(now);
  const overdue: ProposedGroup = { name: "Overdue", items: [] };
  const dueToday: ProposedGroup = { name: "Due today", items: [] };
  const noDate: ProposedGroup = { name: "No date", items: [] };
  const later: ProposedGroup = { name: "Later", items: [] };
  for (const t of pendingTasks(open)) {
    const due = dayKeyOf(t.date);
    const bucket = due === null ? noDate : due < today ? overdue : due === today ? dueToday : later;
    bucket.items.push({ taskId: t.id, text: t.title });
  }
  return [overdue, dueToday, noDate, later].filter((g) => g.items.length > 0);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run src/lib/tasks/__tests__/organize.test.ts src/lib/fieldy/__tests__/report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tasks/organize.ts src/lib/tasks/__tests__/organize.test.ts src/lib/fieldy/report.ts
git commit -m "feat(tasks): grouping validation and the by-date fallback"
```

---

### Task 4: OpenAI grouping

**Files:**
- Create: `src/lib/tasks/openai.ts`
- Test: `src/lib/tasks/__tests__/openai.test.ts`

**Interfaces:**
- Consumes: `ProposedGroup` (Task 3), `dayKeyOf`, `FieldyTask`, `ConversationSummary`.
- Produces:
  - `OPENAI_RESPONSES_URL`
  - `DEFAULT_OPENAI_MODEL = "gpt-6-luna"`
  - `GROUPING_INSTRUCTIONS`
  - `GROUPING_SCHEMA`
  - `outputText(data: unknown): string | null`
  - `groupWithOpenAI(open: FieldyTask[], recordings: ConversationSummary[], opts?: { apiKey?: string | null; model?: string }): Promise<ProposedGroup[] | null>`. Its shape fits the `Organizer` type.

- [ ] **Step 1: Write the failing test** `src/lib/tasks/__tests__/openai.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_OPENAI_MODEL, OPENAI_RESPONSES_URL, groupWithOpenAI, outputText } from "../openai";
import { task } from "./fakes";

const fetchMock = vi.fn();
const OPEN = [task("t1", "Order the Navien", { date: "2026-11-20" }), task("t2", "Call Mrs. Smith")];
const RECORDINGS = [{ id: "c1", title: "Troy walkthrough", summary: "Boiler swap.", startTime: "2026-11-22T15:00:00.000Z" }];

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function message(text: string) {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("groupWithOpenAI", () => {
  it("asks for structured output with the default model and returns the groups", async () => {
    const groups = [{ name: "Troy job", items: [{ taskId: "t1", text: "Order the Navien" }] }];
    fetchMock.mockResolvedValueOnce(reply(message(JSON.stringify({ groups }))));

    expect(await groupWithOpenAI(OPEN, RECORDINGS, { apiKey: "sk-test" })).toEqual(groups);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENAI_RESPONSES_URL);
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: DEFAULT_OPENAI_MODEL, store: false });
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "checklist", strict: true });
    expect(JSON.parse(body.input)).toEqual({
      tasks: [
        { id: "t1", title: "Order the Navien", due: "2026-11-20" },
        { id: "t2", title: "Call Mrs. Smith", due: null },
      ],
      recordings: [{ startTime: "2026-11-22T15:00:00.000Z", title: "Troy walkthrough", summary: "Boiler swap." }],
    });
  });

  it("uses OPENAI_MODEL and OPENAI_API_KEY from the environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    vi.stubEnv("OPENAI_MODEL", "some-other-model");
    fetchMock.mockResolvedValueOnce(reply(message(JSON.stringify({ groups: [] }))));
    await groupWithOpenAI(OPEN, []);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-env");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("some-other-model");
  });

  it("returns null without a key and makes no request", async () => {
    expect(await groupWithOpenAI(OPEN, [], { apiKey: null })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] for no open tasks without asking", async () => {
    expect(await groupWithOpenAI([], [], { apiKey: "sk-test" })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTTP error", () => reply({ error: { message: "nope" } }, 500)],
    ["a refusal", () => reply({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })],
    ["an incomplete response", () => reply({ status: "incomplete", output: [] })],
    ["text that isn't JSON", () => reply(message("not json"))],
    ["JSON in the wrong shape", () => reply(message(JSON.stringify({ groups: [{ name: 3 }] })))],
  ])("returns null on %s", async (_label, make) => {
    fetchMock.mockResolvedValueOnce(make());
    expect(await groupWithOpenAI(OPEN, [], { apiKey: "sk-test" })).toBeNull();
  });

  it("returns null on a timeout and logs only the code", async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(err);
    expect(await groupWithOpenAI(OPEN, [], { apiKey: "sk-test" })).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[tasks] AI grouping skipped: timeout");
  });
});

describe("outputText", () => {
  it("finds the first output_text in a completed message", () => {
    expect(outputText({ status: "completed", output: [{ type: "reasoning" }, ...message("hi").output] })).toBe("hi");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/tasks/__tests__/openai.test.ts`
Expected: FAIL, because `../openai` doesn't exist.

- [ ] **Step 3: Implement** `src/lib/tasks/openai.ts`:

```ts
// The morning checklist's grouping, from the OpenAI Responses API with a
// strict JSON schema. Sends task titles, due dates and the last day's
// recording titles and summaries; nothing else. store:false so OpenAI keeps no
// stored response (it may still hold API data up to 30 days for abuse checks).
//
// Never throws: any failure returns null and the caller groups by date instead,
// so an OpenAI outage still gets Dave his list. Logs only an error code.
//
// Model: gpt-6-luna, checked 2026-11-21 at
// https://developers.openai.com/api/docs/models/compare (v1/responses, Structured Outputs).
// OPENAI_MODEL overrides it without a code change.
import type { ConversationSummary, FieldyTask } from "@/lib/fieldy/client";
import { dayKeyOf } from "@/lib/fieldy/report";
import type { ProposedGroup } from "./organize";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
const TIMEOUT_MS = 30_000;

export const GROUPING_INSTRUCTIONS = [
  "You organize the to-do list of Dave, who owns a plumbing company.",
  "Put every task id you are given in exactly one group. Never invent ids.",
  "Group tasks that belong together: the same job, customer or address, or the same kind of errand (calls to return, parts to order, paperwork).",
  'Use at most 10 groups, with short names like "Troy boiler job" or "Calls to return".',
  "'text' is the task's title, shortened to 70 characters or fewer if needed. Never add names, numbers or details that aren't in the title.",
  "The recordings only help you see which tasks go together. Don't make tasks out of them.",
].join(" ");

export const GROUPING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "items"],
        properties: {
          name: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["taskId", "text"],
              properties: { taskId: { type: "string" }, text: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

function skip(code: string): null {
  console.warn(`[tasks] AI grouping skipped: ${code}`);
  return null;
}

/** The model's text from a completed Responses API reply; null on a refusal or anything unexpected. */
export function outputText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { status?: unknown; output?: unknown };
  if (d.status !== "completed" || !Array.isArray(d.output)) return null;
  for (const item of d.output as Array<{ type?: unknown; content?: unknown }>) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<{ type?: unknown; text?: unknown }>) {
      if (part?.type === "refusal") return null;
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return null;
}

function toGroups(value: unknown): ProposedGroup[] | null {
  if (!value || typeof value !== "object") return null;
  const groups = (value as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return null;
  const out: ProposedGroup[] = [];
  for (const g of groups as Array<{ name?: unknown; items?: unknown }>) {
    if (!g || typeof g.name !== "string" || !Array.isArray(g.items)) return null;
    const items: ProposedGroup["items"] = [];
    for (const i of g.items as Array<{ taskId?: unknown; text?: unknown }>) {
      if (!i || typeof i.taskId !== "string" || typeof i.text !== "string") return null;
      items.push({ taskId: i.taskId, text: i.text });
    }
    out.push({ name: g.name, items });
  }
  return out;
}

export async function groupWithOpenAI(
  open: FieldyTask[],
  recordings: ConversationSummary[],
  opts: { apiKey?: string | null; model?: string } = {}
): Promise<ProposedGroup[] | null> {
  const apiKey = opts.apiKey === undefined ? process.env.OPENAI_API_KEY || null : opts.apiKey;
  if (!apiKey) return skip("key_not_set");
  if (open.length === 0) return [];
  const model = opts.model ?? (process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL);

  const input = JSON.stringify({
    tasks: open.map((t) => ({ id: t.id, title: t.title, due: dayKeyOf(t.date) })),
    recordings: recordings.map((r) => ({ startTime: r.startTime, title: r.title, summary: r.summary })),
  });

  let res: Response;
  try {
    res = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        instructions: GROUPING_INSTRUCTIONS,
        input,
        store: false,
        text: { format: { type: "json_schema", name: "checklist", strict: true, schema: GROUPING_SCHEMA } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return skip(err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!res.ok) return skip(`http_${res.status}`);

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return skip("bad_response");
  }
  const text = outputText(data);
  if (text === null) return skip("no_output");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return skip("bad_json");
  }
  return toGroups(parsed) ?? skip("schema_mismatch");
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run src/lib/tasks/__tests__/openai.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tasks/openai.ts src/lib/tasks/__tests__/openai.test.ts
git commit -m "feat(tasks): OpenAI grouping with structured output, null on any failure"
```

---

### Task 5: Slack message rendering and the Slack calls

**Files:**
- Create: `src/lib/tasks/render.ts`
- Modify: `src/lib/slack/web.ts`, `src/lib/slack/respond.ts`
- Test: `src/lib/tasks/__tests__/render.test.ts`, plus appends to `src/lib/slack/__tests__/web.test.ts` and `src/lib/slack/__tests__/respond.test.ts`

**Interfaces:**
- Consumes: `ChecklistRow`, `ItemRow` and `BuiltBy` (Task 2); `Grouping` (Task 3); `dayLabelFromKey` from `@/lib/slack/format`.
- Produces:
  - `render.ts`:
    - `OPTION_TEXT_MAX`, `OPTIONS_PER_ELEMENT`, `ACTION_PREFIX = "fieldy_cb"`
    - `escapeMrkdwn(s)`, `optionLabel(raw, done)`
    - `layoutChecklist(items): GroupLayout[]`
    - `actionId(checklistId, chunk)`, `parseActionId(id): { checklistId; chunk } | null`
    - `heading(day)`, `footerLine(...)`
    - `renderChecklistMessage(cl, items): { text: string; blocks: SlackBlock[] }`
    - `renderChecklistPreview(day, grouping, builtBy, finishedYesterday): string`
  - `web.ts`:
    - `postMessage(token, channel, text, blocks?): Promise<string>` (returns `ts`, `""` if Slack sent none)
    - `updateMessage(token, channel, ts, text, blocks): Promise<void>`
  - `respond.ts`: `postEphemeralNote(responseUrl, text): Promise<boolean>`

- [ ] **Step 1: Write the failing tests.** First check what `dayLabelFromKey("2026-11-23")` returns: open `src/lib/slack/format.ts` and read `dayLabel`. The tests below assume `"Mon Nov 23"`. If it returns something else, replace `Mon Nov 23` in the four expected strings below with its real output.

Create `src/lib/tasks/__tests__/render.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { OPTION_TEXT_MAX, actionId, layoutChecklist, optionLabel, parseActionId, renderChecklistMessage, renderChecklistPreview } from "../render";
import type { ChecklistRow, ItemRow } from "../store";

const CL: ChecklistRow = {
  id: 7,
  day: "2026-11-23",
  channelId: "C1",
  messageTs: "171.1",
  builtBy: "morning_ai",
  version: 2,
  renderedVersion: 1,
  overflow: 0,
  finishedYesterday: 3,
};

function item(n: number, group: string, done = false): ItemRow {
  return {
    checklistId: 7,
    position: n,
    groupName: group,
    text: `Task ${n}`,
    fieldyTaskId: `t${n}`,
    doneAt: done ? "2026-11-23T14:00:00.000Z" : null,
    doneVia: done ? "slack" : null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = { type: string; text?: { text: string }; elements?: Array<Record<string, any>> };

describe("renderChecklistMessage", () => {
  it("has a heading, a label and checkboxes per group, and a footer", () => {
    const msg = renderChecklistMessage(CL, [item(1, "Troy job"), item(2, "Calls", true), item(3, "Calls")]);
    const blocks = msg.blocks as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["header", "section", "actions", "section", "actions", "context"]);
    expect(blocks[0].text!.text).toBe("Dave's checklist, Mon Nov 23");
    expect(blocks[1].text!.text).toBe("*Troy job*");
    const calls = blocks[4].elements![0];
    expect(calls).toMatchObject({ type: "checkboxes", action_id: "fieldy_cb:7:1" });
    expect(calls.options.map((o: { value: string }) => o.value)).toEqual(["t2", "t3"]);
    expect(calls.options[0].text.text).toBe("~Task 2~");
    expect(calls.initial_options).toEqual([calls.options[0]]);
    expect(blocks[2].elements![0].initial_options).toBeUndefined();
    expect(blocks[5].elements![0].text).toBe("1 of 3 done · Finished yesterday: 3");
    expect(msg.text).toBe("Dave's checklist, Mon Nov 23: 1 of 3 done");
  });

  it("splits a group into checkboxes of at most 10 and stays under 50 blocks at the caps", () => {
    const items = Array.from({ length: 40 }, (_, i) => item(i + 1, i < 25 ? "Big" : `G${i % 11}`));
    const blocks = renderChecklistMessage(CL, items).blocks as Block[];
    expect(blocks.length).toBeLessThanOrEqual(50);
    const big = blocks[2].elements!;
    expect(big.map((e) => e.options.length)).toEqual([10, 10, 5]);
    const ids = blocks.flatMap((b) => (b.type === "actions" ? b.elements!.map((e) => e.action_id) : []));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("adds the overflow and the no-AI notes to the footer", () => {
    const blocks = renderChecklistMessage({ ...CL, overflow: 4, builtBy: "morning_rules" }, [item(1, "A")]).blocks as Block[];
    expect(blocks[blocks.length - 1].elements![0].text).toBe(
      "0 of 1 done · Finished yesterday: 3 · +4 more in Fieldy · Grouped by date; AI grouping didn't run"
    );
  });

  it("says so when there are no tasks", () => {
    const blocks = renderChecklistMessage(CL, []).blocks as Block[];
    expect(blocks[1].text!.text).toBe("No open Fieldy tasks.");
  });
});

describe("optionLabel", () => {
  it("escapes Slack control characters so a title can't ping anyone", () => {
    expect(optionLabel("<!channel> & co", false)).toBe("&lt;!channel&gt; &amp; co");
  });

  it("keeps the label within Slack's limit even after escaping and strikethrough", () => {
    const label = optionLabel("&".repeat(70), true);
    expect(label.length).toBeLessThanOrEqual(OPTION_TEXT_MAX);
    expect(label.startsWith("~")).toBe(true);
    expect(label.endsWith("~")).toBe(true);
  });
});

describe("action ids and layout", () => {
  it("round-trips an action id and rejects others", () => {
    expect(parseActionId(actionId(7, 3))).toEqual({ checklistId: 7, chunk: 3 });
    expect(parseActionId("other:7:3")).toBeNull();
  });

  it("keeps groups in first-appearance order by position", () => {
    const layout = layoutChecklist([item(3, "B"), item(1, "A"), item(2, "B")]);
    expect(layout.map((g) => g.name)).toEqual(["A", "B"]);
    expect(layout[1].chunks[0].items.map((i) => i.fieldyTaskId)).toEqual(["t2", "t3"]);
  });
});

describe("renderChecklistPreview", () => {
  it("is plain mrkdwn with the same footer", () => {
    const text = renderChecklistPreview(
      "2026-11-23",
      { groups: [{ name: "Troy job", items: [{ taskId: "t1", text: "Order the Navien" }] }], overflow: 0, movedToOther: [], dropped: [] },
      "morning_ai",
      2
    );
    expect(text).toBe(
      ["*Preview: Dave's checklist, Mon Nov 23*", "*Troy job*", "• Order the Navien", "_0 of 1 done · Finished yesterday: 2_"].join("\n")
    );
  });
});
```

Append to `src/lib/slack/__tests__/web.test.ts`, and add `updateMessage` to its import from `"../web"`:

```ts
describe("postMessage with blocks", () => {
  it("sends the blocks and returns the message ts", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, ts: "171.5" }));
    const ts = await postMessage(TOKEN, "C1", "fallback", [{ type: "divider" }]);
    expect(ts).toBe("171.5");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ channel: "C1", text: "fallback", blocks: [{ type: "divider" }] });
  });
});

describe("updateMessage", () => {
  it("calls chat.update with the channel, ts, text and blocks", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await updateMessage(TOKEN, "C1", "171.5", "fallback", [{ type: "divider" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(init.body)).toEqual({ channel: "C1", ts: "171.5", text: "fallback", blocks: [{ type: "divider" }] });
  });

  it("throws on a Slack error", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "message_not_found" }));
    await expect(updateMessage(TOKEN, "C1", "1", "t", [])).rejects.toThrow(/message_not_found/);
  });
});
```

Append to `src/lib/slack/__tests__/respond.test.ts`. Open that file first and use the same fetch-mock variable it already uses; it's called `fetchMock` below. Add `postEphemeralNote` to its import from `"../respond"`.

```ts
describe("postEphemeralNote", () => {
  it("posts an ephemeral reply that leaves the original message alone", async () => {
    fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    expect(await postEphemeralNote("https://hooks.slack.com/actions/x", "Only Dave can check these off.")).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      response_type: "ephemeral",
      replace_original: false,
      text: "Only Dave can check these off.",
    });
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run src/lib/tasks/__tests__/render.test.ts src/lib/slack/__tests__/web.test.ts src/lib/slack/__tests__/respond.test.ts`
Expected: FAIL, with the missing module and exports.

- [ ] **Step 3: Implement.** Create `src/lib/tasks/render.ts`:

```ts
// Dave's checklist as a Slack message, rebuilt in full from the database on
// every change (never patched in place), so whatever Slack shows is exactly
// what the tables hold.
//
// Slack limits this respects: a checkbox label is at most 75 characters, a
// checkboxes element holds at most 10 options, an actions block at most 25
// elements, a message at most 50 blocks. validateGrouping caps a checklist at
// 40 items in 12 groups: 1 header + 12 × (label + actions) + 1 footer = 26 blocks.
import { dayLabelFromKey } from "@/lib/slack/format";
import type { Grouping } from "./organize";
import type { BuiltBy, ChecklistRow, ItemRow } from "./store";

export const OPTION_TEXT_MAX = 75;
export const OPTIONS_PER_ELEMENT = 10;
export const ACTION_PREFIX = "fieldy_cb";

export type SlackBlock = Record<string, unknown>;
export type ChecklistMessage = { text: string; blocks: SlackBlock[] };
export type GroupLayout = { name: string; chunks: { index: number; items: ItemRow[] }[] };

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A checkbox label: escaped, struck through when done, within OPTION_TEXT_MAX after both. */
export function optionLabel(raw: string, done: boolean): string {
  let t = raw;
  for (;;) {
    const escaped = escapeMrkdwn(t);
    const label = done ? `~${escaped}~` : escaped;
    if (label.length <= OPTION_TEXT_MAX || t.length <= 1) return label;
    t = `${t.slice(0, Math.max(1, t.length - 2)).trimEnd()}…`;
  }
}

/** Groups in the order their first item appears, each split into chunks of OPTIONS_PER_ELEMENT. Chunk indexes run across the whole message. */
export function layoutChecklist(items: ItemRow[]): GroupLayout[] {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const groups: { name: string; items: ItemRow[] }[] = [];
  for (const it of sorted) {
    let g = groups.find((x) => x.name === it.groupName);
    if (!g) {
      g = { name: it.groupName, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }
  let index = 0;
  return groups.map((g) => {
    const chunks: GroupLayout["chunks"] = [];
    for (let i = 0; i < g.items.length; i += OPTIONS_PER_ELEMENT) {
      chunks.push({ index: index++, items: g.items.slice(i, i + OPTIONS_PER_ELEMENT) });
    }
    return { name: g.name, chunks };
  });
}

export function actionId(checklistId: number, chunk: number): string {
  return `${ACTION_PREFIX}:${checklistId}:${chunk}`;
}

export function parseActionId(id: string): { checklistId: number; chunk: number } | null {
  const m = /^fieldy_cb:(\d+):(\d+)$/.exec(id);
  return m ? { checklistId: Number(m[1]), chunk: Number(m[2]) } : null;
}

export function heading(day: string): string {
  return `Dave's checklist, ${dayLabelFromKey(day)}`;
}

export function footerLine(c: { done: number; total: number; finishedYesterday: number; overflow: number; builtBy: BuiltBy }): string {
  const parts = [`${c.done} of ${c.total} done`, `Finished yesterday: ${c.finishedYesterday}`];
  if (c.overflow > 0) parts.push(`+${c.overflow} more in Fieldy`);
  if (c.builtBy === "morning_rules") parts.push("Grouped by date; AI grouping didn't run");
  return parts.join(" · ");
}

function option(item: ItemRow) {
  return { text: { type: "mrkdwn", text: optionLabel(item.text, item.doneAt !== null) }, value: item.fieldyTaskId };
}

export function renderChecklistMessage(cl: ChecklistRow, items: ItemRow[]): ChecklistMessage {
  const done = items.filter((i) => i.doneAt !== null).length;
  const blocks: SlackBlock[] = [{ type: "header", text: { type: "plain_text", text: heading(cl.day) } }];
  const layout = layoutChecklist(items);
  if (layout.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "No open Fieldy tasks." } });
  }
  for (const g of layout) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${escapeMrkdwn(g.name)}*` } });
    blocks.push({
      type: "actions",
      elements: g.chunks.map((c) => {
        const options = c.items.map(option);
        const initial = options.filter((_, i) => c.items[i].doneAt !== null);
        return {
          type: "checkboxes",
          action_id: actionId(cl.id, c.index),
          options,
          // Slack rejects an empty initial_options, so leave it out when nothing is ticked.
          ...(initial.length > 0 ? { initial_options: initial } : {}),
        };
      }),
    });
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: footerLine({ done, total: items.length, finishedYesterday: cl.finishedYesterday, overflow: cl.overflow, builtBy: cl.builtBy }),
      },
    ],
  });
  return { text: `${heading(cl.day)}: ${done} of ${items.length} done`, blocks };
}

/** `/trinity fieldy preview`: the checklist the morning pass would build, as text. */
export function renderChecklistPreview(day: string, grouping: Grouping, builtBy: BuiltBy, finishedYesterday: number): string {
  const lines = [`*Preview: ${heading(day)}*`];
  if (grouping.groups.length === 0) lines.push("No open Fieldy tasks.");
  for (const g of grouping.groups) {
    lines.push(`*${escapeMrkdwn(g.name)}*`);
    for (const i of g.items) lines.push(`• ${escapeMrkdwn(i.text)}`);
  }
  const total = grouping.groups.reduce((n, g) => n + g.items.length, 0);
  lines.push(`_${footerLine({ done: 0, total, finishedYesterday, overflow: grouping.overflow, builtBy })}_`);
  return lines.join("\n");
}
```

In `src/lib/slack/web.ts`:
- Change the first line of the header comment to `// The Slack Web API calls the bot token is used for: reading #declined-calls (conversations.history), posting (chat.postMessage) and editing the Fieldy checklist (chat.update).`
- Add `ts?: string;` to `type SlackResponse`.
- Replace `postMessage` with:

```ts
/** Posts a message; returns its ts ("" if Slack sent none). */
export async function postMessage(token: string, channel: string, text: string, blocks?: unknown[]): Promise<string> {
  const data = await call("chat.postMessage", token, {
    json: { channel, text, unfurl_links: false, unfurl_media: false, ...(blocks ? { blocks } : {}) },
  });
  return data.ts ?? "";
}

/** Replaces a message the bot posted. Same chat:write scope as postMessage. */
export async function updateMessage(token: string, channel: string, ts: string, text: string, blocks: unknown[]): Promise<void> {
  await call("chat.update", token, { json: { channel, ts, text, blocks } });
}
```

In `src/lib/slack/respond.ts`, replace the whole `postToResponseUrl` function with these three:

```ts
async function send(responseUrl: string, text: string, replaceOriginal: boolean): Promise<boolean> {
  try {
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Ephemeral: these replies can carry customer details, and only the
        // person who asked needs to see them.
        response_type: "ephemeral",
        replace_original: replaceOriginal,
        text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[slack] response_url post failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // Log the message only, never the raw error object: some failure paths
    // embed the request, and response_url is bearer-equivalent.
    console.error("[slack] response_url post threw:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** A slash-command answer. Replaces the "Working on it…" acknowledgement. */
export async function postToResponseUrl(responseUrl: string, text: string): Promise<boolean> {
  return send(responseUrl, text, true);
}

/**
 * A private note after a button or checkbox tap. replace_original stays false:
 * for a block action, response_url points at the message that was tapped, and
 * true would replace Dave's checklist with this note.
 */
export async function postEphemeralNote(responseUrl: string, text: string): Promise<boolean> {
  return send(responseUrl, text, false);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run src/lib/tasks/__tests__/render.test.ts src/lib/slack`
Expected: PASS, including every pre-existing `postMessage` and `postToResponseUrl` test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tasks/render.ts src/lib/tasks/__tests__/render.test.ts src/lib/slack
git commit -m "feat(slack): checklist Block Kit, chat.update and ephemeral notes after a tap"
```

---

### Task 6: The checklist service

**Files:**
- Create: `src/lib/tasks/checklist.ts`
- Modify: `src/lib/tasks/__tests__/fakes.ts` (add `makeDeps`)
- Test: `src/lib/tasks/__tests__/checklist.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 5.
- Produces:

```ts
export interface FieldyPort {
  tasks(): Promise<FieldyTask[]>;            // new + approved + completed (may repeat a task across statuses)
  completed(): Promise<FieldyTask[]>;
  update(id: string, update: TaskUpdate): Promise<FieldyTask>;
  create(input: { title: string; date: string }): Promise<FieldyTask>;
  conversations(startIso: string, endIso: string): Promise<ConversationSummary[]>;
}
export interface SlackPort {
  post(channel: string, text: string, blocks: unknown[]): Promise<string>;
  update(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void>;
}
export interface ChecklistDeps { fieldy: FieldyPort; store: ChecklistStore; slack: SlackPort; channelId: string; now(): Date }
export type ChangeResult = { changed: string[]; unchanged: string[]; notOnChecklist: string[] };
export const ADDED_GROUP = "Added";
export function dueDateIso(dayKey: string): string;                                   // `${dayKey}T17:00:00.000Z`
export async function buildChecklist(deps, grouping: Grouping, builtBy: BuiltBy, finishedYesterday: number): Promise<number>;
export async function renderChecklist(deps, checklistId: number): Promise<void>;
export async function markDone(deps, checklistId: number | null, taskIds: string[], via: DoneVia): Promise<ChangeResult>;
export async function markNotDone(deps, checklistId: number | null, taskIds: string[], via: DoneVia): Promise<ChangeResult>;
export async function addTask(deps, input: { title: string; dueDay?: string; group?: string }): Promise<{ task: FieldyTask; checklistId: number | null }>;
export async function syncWithFieldy(deps): Promise<{ ticked: number; rerendered: number }>;
```

- [ ] **Step 1: Add `makeDeps` to `src/lib/tasks/__tests__/fakes.ts`.** Add `import type { ChecklistDeps } from "../checklist";` to the imports and append:

```ts
/** A full set of fakes wired as ChecklistDeps, clock fixed at NOW unless given. */
export function makeDeps(opts: { tasks?: FieldyTask[]; now?: Date; onUpdate?: () => Promise<void> } = {}) {
  const mem = memoryStore();
  const fieldy = fakeFieldy(opts.tasks ?? []);
  const slack = fakeSlack({ onUpdate: opts.onUpdate });
  const deps: ChecklistDeps = {
    fieldy: fieldy.port,
    store: mem.store,
    slack: slack.port,
    channelId: "C_FIELDY",
    now: () => opts.now ?? NOW,
  };
  return { deps, fieldy, slack, ...mem };
}
```

- [ ] **Step 2: Write the failing test** `src/lib/tasks/__tests__/checklist.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FieldyApiError } from "@/lib/fieldy/client";
import { ADDED_GROUP, addTask, buildChecklist, markDone, markNotDone, renderChecklist, syncWithFieldy } from "../checklist";
import { validateGrouping } from "../organize";
import { NOW, TODAY, makeDeps, task } from "./fakes";

const TASKS = [task("t1", "Order the Navien"), task("t2", "Call Mrs. Smith"), task("t3", "Van inventory list")];
const GROUPING = validateGrouping(
  [
    { name: "Troy job", items: [{ taskId: "t1" }] },
    { name: "Calls", items: [{ taskId: "t2" }, { taskId: "t3" }] },
  ],
  TASKS
);

async function built() {
  const ctx = makeDeps({ tasks: TASKS });
  const id = await buildChecklist(ctx.deps, GROUPING, "morning_ai", 2);
  return { ...ctx, id };
}

describe("buildChecklist", () => {
  it("posts a new message for today and records it as rendered", async () => {
    const { slack, lists, items, id } = await built();
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0].channel).toBe("C_FIELDY");
    const row = lists.get(id)!;
    expect(row).toMatchObject({ day: TODAY, messageTs: "171.1", builtBy: "morning_ai", finishedYesterday: 2 });
    expect(row.renderedVersion).toBe(row.version);
    expect(items.get(id)!.map((i) => [i.position, i.groupName, i.fieldyTaskId])).toEqual([
      [1, "Troy job", "t1"],
      [2, "Calls", "t2"],
      [3, "Calls", "t3"],
    ]);
  });

  it("rebuilds the same day in place and keeps what Dave already ticked", async () => {
    const { deps, slack, items, id } = await built();
    await markDone(deps, id, ["t1"], "slack");

    // t1 is now completed in Fieldy, so a fresh grouping no longer includes it.
    const regrouped = validateGrouping([{ name: "Everything", items: [{ taskId: "t2" }, { taskId: "t3" }] }], TASKS.slice(1));
    const again = await buildChecklist(deps, regrouped, "chatgpt", 2);

    expect(again).toBe(id);
    expect(slack.posts).toHaveLength(1);
    const rows = items.get(id)!;
    expect(rows.map((i) => [i.groupName, i.fieldyTaskId, i.doneAt !== null])).toEqual([
      ["Everything", "t2", false],
      ["Everything", "t3", false],
      ["Troy job", "t1", true],
    ]);
  });
});

describe("markDone / markNotDone", () => {
  it("marks the task completed in Fieldy, ticks it, and re-renders", async () => {
    const { deps, fieldy, slack, items, id } = await built();
    const r = await markDone(deps, id, ["t2"], "chatgpt");
    expect(r).toEqual({ changed: ["t2"], unchanged: [], notOnChecklist: [] });
    expect(fieldy.updates).toEqual([["t2", { status: "completed", completionDate: NOW.toISOString() }]]);
    expect(items.get(id)!.find((i) => i.fieldyTaskId === "t2")).toMatchObject({ doneAt: NOW.toISOString(), doneVia: "chatgpt" });
    expect(slack.updates).toHaveLength(1);
  });

  it("changes nothing when Fieldy fails", async () => {
    const { deps, fieldy, slack, items, id } = await built();
    fieldy.failUpdateAt(1, new FieldyApiError("http_503", "PATCH /tasks/{id}"));
    await expect(markDone(deps, id, ["t2"], "slack")).rejects.toMatchObject({ code: "http_503" });
    expect(items.get(id)!.every((i) => i.doneAt === null)).toBe(true);
    expect(slack.updates).toHaveLength(0);
  });

  it("keeps the ones Fieldy accepted when a later one fails, then throws", async () => {
    const { deps, fieldy, items, id } = await built();
    fieldy.failUpdateAt(2, new FieldyApiError("http_503", "PATCH /tasks/{id}"));
    await expect(markDone(deps, id, ["t2", "t3"], "slack")).rejects.toMatchObject({ code: "http_503" });
    const done = items.get(id)!.filter((i) => i.doneAt !== null).map((i) => i.fieldyTaskId);
    expect(done).toEqual(["t2"]);
  });

  it("is a no-op the second time", async () => {
    const { deps, fieldy, id } = await built();
    await markDone(deps, id, ["t2"], "slack");
    const r = await markDone(deps, id, ["t2"], "chatgpt");
    expect(r).toEqual({ changed: [], unchanged: ["t2"], notOnChecklist: [] });
    expect(fieldy.updates).toHaveLength(1);
  });

  it("puts a task back to approved and unticks it", async () => {
    const { deps, fieldy, items, id } = await built();
    await markDone(deps, id, ["t2"], "slack");
    await markNotDone(deps, id, ["t2"], "chatgpt");
    expect(fieldy.updates[1]).toEqual(["t2", { status: "approved" }]);
    expect(items.get(id)!.find((i) => i.fieldyTaskId === "t2")).toMatchObject({ doneAt: null, doneVia: null });
  });

  it("still marks Fieldy when there's no checklist today", async () => {
    const { deps, fieldy, slack } = makeDeps({ tasks: TASKS });
    const r = await markDone(deps, null, ["t1"], "chatgpt");
    expect(r).toEqual({ changed: [], unchanged: [], notOnChecklist: ["t1"] });
    expect(fieldy.updates).toHaveLength(1);
    expect(slack.posts).toHaveLength(0);
  });
});

describe("addTask", () => {
  it("creates the task in Fieldy, due today by default, and adds it under Added", async () => {
    const { deps, fieldy, items, id } = await built();
    const r = await addTask(deps, { title: "  Call the Navien rep " });
    expect(fieldy.created).toEqual([{ title: "Call the Navien rep", date: `${TODAY}T17:00:00.000Z` }]);
    expect(r.checklistId).toBe(id);
    expect(items.get(id)!.slice(-1)[0]).toMatchObject({ groupName: ADDED_GROUP, text: "Call the Navien rep", position: 4 });
  });

  it("uses the given due day and group", async () => {
    const { deps, fieldy, items, id } = await built();
    await addTask(deps, { title: "Pick up flux", dueDay: "2026-11-25", group: "Errands" });
    expect(fieldy.created[0].date).toBe("2026-11-25T17:00:00.000Z");
    expect(items.get(id)!.slice(-1)[0].groupName).toBe("Errands");
  });

  it("only creates in Fieldy when there's no checklist today", async () => {
    const { deps, slack } = makeDeps();
    const r = await addTask(deps, { title: "Pick up flux" });
    expect(r.checklistId).toBeNull();
    expect(slack.posts).toHaveLength(0);
  });
});

describe("renderChecklist", () => {
  it("renders once more if the checklist changed while Slack was updating", async () => {
    let touchedOnce = false;
    const ctx = makeDeps({
      tasks: TASKS,
      onUpdate: async () => {
        if (!touchedOnce) {
          touchedOnce = true;
          await ctx.deps.store.touch(1);
        }
      },
    });
    const id = await buildChecklist(ctx.deps, GROUPING, "morning_ai", 0); // first render posts; no update yet
    await ctx.deps.store.touch(id);
    await renderChecklist(ctx.deps, id);
    expect(ctx.slack.updates).toHaveLength(2);
    const row = ctx.lists.get(id)!;
    expect(row.renderedVersion).toBe(row.version);
  });
});

describe("syncWithFieldy", () => {
  it("ticks items Dave marked done in the Fieldy app", async () => {
    const { deps, fieldy, items, id } = await built();
    fieldy.state.get("t3")!.status = "completed";
    const r = await syncWithFieldy(deps);
    expect(r.ticked).toBe(1);
    expect(items.get(id)!.find((i) => i.fieldyTaskId === "t3")).toMatchObject({ doneVia: "fieldy" });
  });

  it("re-renders a checklist whose last Slack update didn't land", async () => {
    const { deps, slack, id } = await built();
    await deps.store.touch(id); // as if a change saved but chat.update failed
    const r = await syncWithFieldy(deps);
    expect(r.rerendered).toBe(1);
    expect(slack.updates).toHaveLength(1);
  });

  it("does nothing without a checklist", async () => {
    const { deps, slack } = makeDeps({ tasks: TASKS });
    expect(await syncWithFieldy(deps)).toEqual({ ticked: 0, rerendered: 0 });
    expect(slack.posts).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run src/lib/tasks/__tests__/checklist.test.ts`
Expected: FAIL, because `../checklist` doesn't exist.

- [ ] **Step 4: Implement** `src/lib/tasks/checklist.ts`:

```ts
// The one place Dave's checklist changes. ChatGPT (lib/mcp/tasks), Slack taps
// (lib/tasks/interact) and the cron (lib/tasks/morning, syncWithFieldy) all
// call these, so a tick from Slack and a tick from ChatGPT run the same code.
//
// Order on every change: Fieldy first, then the tables, then the version bump,
// then a full re-render of the Slack message from the tables. If Fieldy fails,
// that task's change doesn't happen.
import type { ConversationSummary, FieldyTask, TaskUpdate } from "@/lib/fieldy/client";
import { localDateKey } from "@/lib/notifications/schedule";
import { GROUP_NAME_MAX, fitText, type Grouping } from "./organize";
import { renderChecklistMessage } from "./render";
import type { BuiltBy, ChecklistStore, DoneVia, NewItem } from "./store";

export interface FieldyPort {
  /** new + approved + completed tasks; a task can appear twice if it changed between calls. */
  tasks(): Promise<FieldyTask[]>;
  completed(): Promise<FieldyTask[]>;
  update(id: string, update: TaskUpdate): Promise<FieldyTask>;
  create(input: { title: string; date: string }): Promise<FieldyTask>;
  conversations(startIso: string, endIso: string): Promise<ConversationSummary[]>;
}

export interface SlackPort {
  post(channel: string, text: string, blocks: unknown[]): Promise<string>;
  update(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void>;
}

export interface ChecklistDeps {
  fieldy: FieldyPort;
  store: ChecklistStore;
  slack: SlackPort;
  channelId: string;
  now(): Date;
}

export type ChangeResult = {
  /** Changed in Fieldy and on the checklist. */
  changed: string[];
  /** Already in the asked-for state on the checklist; Fieldy not called. */
  unchanged: string[];
  /** Changed in Fieldy; not on this checklist (or there is none). */
  notOnChecklist: string[];
};

export const ADDED_GROUP = "Added";

/** A due date Fieldy accepts that stays on the same Eastern day in both EST and EDT (noon or 1pm). */
export function dueDateIso(dayKey: string): string {
  return `${dayKey}T17:00:00.000Z`;
}

/** Rebuilds the Slack message from the tables. If the checklist changed meanwhile, renders once more. */
export async function renderChecklist(deps: ChecklistDeps, checklistId: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cl = await deps.store.getById(checklistId);
    if (!cl) return;
    const msg = renderChecklistMessage(cl, await deps.store.listItems(checklistId));
    if (cl.messageTs) {
      await deps.slack.update(cl.channelId, cl.messageTs, msg.text, msg.blocks);
    } else {
      const ts = await deps.slack.post(cl.channelId, msg.text, msg.blocks);
      if (!ts) throw new Error("[tasks] Slack returned no message ts");
      await deps.store.setMessageTs(checklistId, ts);
    }
    await deps.store.markRendered(checklistId, cl.version);
    const after = await deps.store.getById(checklistId);
    if (!after || after.version === cl.version) return;
  }
}

/** Today's checklist from a validated grouping: created and posted, or rebuilt in place. Returns its id. */
export async function buildChecklist(
  deps: ChecklistDeps,
  grouping: Grouping,
  builtBy: BuiltBy,
  finishedYesterday: number
): Promise<number> {
  const day = localDateKey(deps.now());
  const cl = (await deps.store.getByDay(day)) ?? (await deps.store.create({ day, channelId: deps.channelId, builtBy }));
  const old = await deps.store.listItems(cl.id);
  const oldById = new Map(old.map((i) => [i.fieldyTaskId, i]));

  const order: string[] = [];
  const byGroup = new Map<string, NewItem[]>();
  const push = (group: string, item: Pick<NewItem, "text" | "fieldyTaskId" | "doneAt" | "doneVia">) => {
    if (!byGroup.has(group)) {
      byGroup.set(group, []);
      order.push(group);
    }
    byGroup.get(group)!.push({ ...item, groupName: group, position: 0 });
  };

  const placed = new Set<string>();
  for (const g of grouping.groups) {
    for (const it of g.items) {
      const prev = oldById.get(it.taskId);
      push(g.name, { text: it.text, fieldyTaskId: it.taskId, doneAt: prev?.doneAt ?? null, doneVia: prev?.doneVia ?? null });
      placed.add(it.taskId);
    }
  }
  // Ticked earlier today: completed in Fieldy now, so no longer in a fresh
  // grouping. A rebuild never removes something Dave already finished today.
  for (const prev of old) {
    if (prev.doneAt !== null && !placed.has(prev.fieldyTaskId)) {
      push(prev.groupName, { text: prev.text, fieldyTaskId: prev.fieldyTaskId, doneAt: prev.doneAt, doneVia: prev.doneVia });
    }
  }

  let position = 0;
  const items = order.flatMap((g) => byGroup.get(g)!.map((i) => ({ ...i, position: ++position })));
  await deps.store.replaceItems(cl.id, items);
  await deps.store.updateMeta(cl.id, { builtBy, overflow: grouping.overflow, finishedYesterday });
  await deps.store.touch(cl.id);
  await renderChecklist(deps, cl.id);
  return cl.id;
}

async function changeTasks(
  deps: ChecklistDeps,
  checklistId: number | null,
  taskIds: string[],
  to: "done" | "open",
  via: DoneVia
): Promise<ChangeResult> {
  const ids = Array.from(new Set(taskIds));
  const items = checklistId === null ? [] : await deps.store.listItems(checklistId);
  const byId = new Map(items.map((i) => [i.fieldyTaskId, i]));
  const nowIso = deps.now().toISOString();
  const result: ChangeResult = { changed: [], unchanged: [], notOnChecklist: [] };

  let failure: unknown = null;
  for (const id of ids) {
    const item = byId.get(id);
    if (item && (item.doneAt !== null) === (to === "done")) {
      result.unchanged.push(id);
      continue;
    }
    try {
      await deps.fieldy.update(id, to === "done" ? { status: "completed", completionDate: nowIso } : { status: "approved" });
    } catch (err) {
      failure = err;
      break;
    }
    (item ? result.changed : result.notOnChecklist).push(id);
  }

  if (checklistId !== null && result.changed.length > 0) {
    await deps.store.setDone(checklistId, result.changed, to === "done" ? nowIso : null, to === "done" ? via : null);
    await deps.store.touch(checklistId);
    await renderChecklist(deps, checklistId);
  }
  // Thrown after recording the ones Fieldy accepted, so the checklist matches Fieldy.
  if (failure) throw failure;
  return result;
}

export function markDone(deps: ChecklistDeps, checklistId: number | null, taskIds: string[], via: DoneVia): Promise<ChangeResult> {
  return changeTasks(deps, checklistId, taskIds, "done", via);
}

export function markNotDone(deps: ChecklistDeps, checklistId: number | null, taskIds: string[], via: DoneVia): Promise<ChangeResult> {
  return changeTasks(deps, checklistId, taskIds, "open", via);
}

/** A new Fieldy task, added to today's checklist if there is one. */
export async function addTask(
  deps: ChecklistDeps,
  input: { title: string; dueDay?: string; group?: string }
): Promise<{ task: FieldyTask; checklistId: number | null }> {
  const today = localDateKey(deps.now());
  const task = await deps.fieldy.create({ title: input.title.trim(), date: dueDateIso(input.dueDay ?? today) });
  const cl = await deps.store.getByDay(today);
  if (!cl) return { task, checklistId: null };
  await deps.store.appendItem(cl.id, {
    groupName: fitText(input.group ?? "", GROUP_NAME_MAX) || ADDED_GROUP,
    text: fitText(task.title),
    fieldyTaskId: task.id,
  });
  await deps.store.touch(cl.id);
  await renderChecklist(deps, cl.id);
  return { task, checklistId: cl.id };
}

/**
 * Every 15 minutes from the cron: tick items Dave marked done in the Fieldy
 * app itself, then re-render any recent checklist Slack is behind on (a failed
 * chat.update, or a first post that never landed).
 */
export async function syncWithFieldy(deps: ChecklistDeps): Promise<{ ticked: number; rerendered: number }> {
  const now = deps.now();
  let ticked = 0;
  const today = await deps.store.getByDay(localDateKey(now));
  if (today) {
    const open = (await deps.store.listItems(today.id)).filter((i) => i.doneAt === null);
    if (open.length > 0) {
      const completed = new Set((await deps.fieldy.completed()).map((t) => t.id));
      const ids = open.filter((i) => completed.has(i.fieldyTaskId)).map((i) => i.fieldyTaskId);
      if (ids.length > 0) {
        await deps.store.setDone(today.id, ids, now.toISOString(), "fieldy");
        await deps.store.touch(today.id);
        ticked = ids.length;
      }
    }
  }
  const yesterday = localDateKey(new Date(now.getTime() - 24 * 3_600_000));
  const behind = await deps.store.listBehind(yesterday);
  for (const cl of behind) await renderChecklist(deps, cl.id);
  return { ticked, rerendered: behind.length };
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run src/lib/tasks`
Expected: PASS.

How the `renderChecklist` test works:
- `buildChecklist` posts rather than updates, because there's no `messageTs` yet.
- The version didn't move during that post, so there's no second pass, and `slack.updates` is still empty.
- In the explicit `renderChecklist` call, `onUpdate` touches the version once during the update. That forces one extra pass, so 2 updates are expected.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tasks/checklist.ts src/lib/tasks/__tests__/checklist.test.ts src/lib/tasks/__tests__/fakes.ts
git commit -m "feat(tasks): checklist service: build, tick, untick, add, sync with Fieldy"
```

---

### Task 7: The morning pass, the preview and the cron

**Files:**
- Create: `src/lib/tasks/deps.ts`, `src/lib/tasks/morning.ts`, `src/lib/tasks/cron.ts`
- Modify: `src/lib/fieldy/fieldy.ts`, `src/lib/fieldy/report.ts`, `src/lib/notifications/dedupe.ts`, `src/app/api/cron/sync/route.ts`, `src/lib/slack/commands.ts` (one help line)
- Test: `src/lib/tasks/__tests__/morning.test.ts`; modify `src/lib/fieldy/__tests__/fieldy.test.ts`, `src/lib/fieldy/__tests__/report.test.ts` and `src/app/api/cron/sync/__tests__/route.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 6.
- Produces:
  - `deps.ts`:
    - `liveFieldyPort(): FieldyPort`
    - `liveChecklistDeps(supabase?: SupabaseClient, now?: () => Date): ChecklistDeps`
    - `liveOrganizer(): Organizer`
    - `checklistConfigMissing(): string | null`
  - `morning.ts`:
    - `type ChecklistPlan = { grouping: Grouping; builtBy: BuiltBy; finishedYesterday: number }`
    - `planChecklist(deps: Pick<ChecklistDeps, "fieldy" | "now">, organize: Organizer): Promise<ChecklistPlan>`
    - `runChecklistMorningPass(supabase: SupabaseClient, deps: ChecklistDeps, organize: Organizer): Promise<boolean>`
  - `cron.ts`: `runFieldyChecklistPasses(supabase: SupabaseClient, now: Date): Promise<void>`
  - `fieldy.ts`: `renderFieldy(cmd, now, plan?: () => Promise<ChecklistPlan>)`. `runFieldyDailyPass`, `FieldyReportDeps`, `defaultDeps` and `missingConfig` are **removed**.

- [ ] **Step 1: Write the failing morning test** `src/lib/tasks/__tests__/morning.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FieldyApiError } from "@/lib/fieldy/client";

const { claimMock } = vi.hoisted(() => ({ claimMock: vi.fn() }));
vi.mock("@/lib/notifications/dedupe", () => ({ claim: claimMock }));

import { planChecklist, runChecklistMorningPass } from "../morning";
import type { Organizer } from "../organize";
import { makeDeps, task } from "./fakes";

const SUPABASE = {} as SupabaseClient;
const AT_8AM = new Date("2026-11-23T13:00:00.000Z");
const AT_659AM = new Date("2026-11-23T11:59:00.000Z");
const TASKS = [
  task("t1", "Order the Navien"),
  task("t2", "Call Mrs. Smith"),
  task("y1", "Done yesterday", { status: "completed", completionDate: "2026-11-22T18:00:00.000Z" }),
];
const aiOrganizer: Organizer = async (open) => [{ name: "Today", items: open.map((t) => ({ taskId: t.id, text: t.title })) }];
const deadOrganizer: Organizer = async () => null;

beforeEach(() => {
  claimMock.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("planChecklist", () => {
  it("groups the open tasks and counts yesterday's finished ones", async () => {
    const { deps } = makeDeps({ tasks: TASKS, now: AT_8AM });
    const plan = await planChecklist(deps, aiOrganizer);
    expect(plan.builtBy).toBe("morning_ai");
    expect(plan.finishedYesterday).toBe(1);
    expect(plan.grouping.groups[0].items.map((i) => i.taskId)).toEqual(["t1", "t2"]);
  });

  it("falls back to rules when the organizer returns null", async () => {
    const { deps } = makeDeps({ tasks: TASKS, now: AT_8AM });
    const plan = await planChecklist(deps, deadOrganizer);
    expect(plan.builtBy).toBe("morning_rules");
    expect(plan.grouping.groups.map((g) => g.name)).toEqual(["No date"]);
  });

  it("still plans when recordings can't be read", async () => {
    const { deps } = makeDeps({ tasks: TASKS, now: AT_8AM });
    deps.fieldy.conversations = async () => {
      throw new FieldyApiError("http_500", "GET /conversations");
    };
    await expect(planChecklist(deps, aiOrganizer)).resolves.toMatchObject({ builtBy: "morning_ai" });
  });

  it("passes the last 24 hours of recordings to the organizer", async () => {
    const { deps, fieldy } = makeDeps({ tasks: TASKS, now: AT_8AM });
    const rec = [{ id: "c1", title: "Troy", summary: "s", startTime: "2026-11-23T12:00:00.000Z" }];
    fieldy.setRecordings(rec);
    const seen: unknown[] = [];
    await planChecklist(deps, async (_open, recordings) => {
      seen.push(recordings);
      return [];
    });
    expect(seen).toEqual([rec]);
  });
});

describe("runChecklistMorningPass", () => {
  it("posts once in the window and claims the day", async () => {
    const { deps, slack } = makeDeps({ tasks: TASKS, now: AT_8AM });
    expect(await runChecklistMorningPass(SUPABASE, deps, aiOrganizer)).toBe(true);
    expect(claimMock).toHaveBeenCalledWith(SUPABASE, "fieldy_checklist", "2026-11-23");
    expect(slack.posts).toHaveLength(1);

    expect(await runChecklistMorningPass(SUPABASE, deps, aiOrganizer)).toBe(false);
    expect(claimMock).toHaveBeenCalledTimes(1);
    expect(slack.posts).toHaveLength(1);
  });

  it("does nothing before 7am", async () => {
    const { deps, slack } = makeDeps({ tasks: TASKS, now: AT_659AM });
    expect(await runChecklistMorningPass(SUPABASE, deps, aiOrganizer)).toBe(false);
    expect(slack.posts).toHaveLength(0);
  });

  it("posts with the rules note when AI grouping fails", async () => {
    const { deps, slack } = makeDeps({ tasks: TASKS, now: AT_8AM });
    await runChecklistMorningPass(SUPABASE, deps, deadOrganizer);
    expect(JSON.stringify(slack.posts[0].blocks)).toContain("Grouped by date; AI grouping didn't run");
  });

  it("throws before claiming when Fieldy is down, so the next run retries", async () => {
    const { deps } = makeDeps({ now: AT_8AM });
    deps.fieldy.tasks = async () => {
      throw new FieldyApiError("http_503");
    };
    await expect(runChecklistMorningPass(SUPABASE, deps, aiOrganizer)).rejects.toMatchObject({ code: "http_503" });
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("doesn't post when another run already claimed the day", async () => {
    claimMock.mockResolvedValueOnce(false);
    const { deps, slack } = makeDeps({ tasks: TASKS, now: AT_8AM });
    expect(await runChecklistMorningPass(SUPABASE, deps, aiOrganizer)).toBe(false);
    expect(slack.posts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/tasks/__tests__/morning.test.ts`
Expected: FAIL, because `../morning` doesn't exist.

- [ ] **Step 3: Implement `deps.ts`, `morning.ts` and `cron.ts`.**

`src/lib/tasks/deps.ts`:

```ts
// The real Fieldy, Slack, Supabase and OpenAI behind the checklist service.
// Kept apart from checklist.ts so the service and its tests never import live wiring.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTask, fieldyApiKey, listConversations, listTasks, updateTask } from "@/lib/fieldy/client";
import { fieldyTaskSource } from "@/lib/fieldy/fieldy";
import { postMessage, updateMessage } from "@/lib/slack/web";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import type { ChecklistDeps, FieldyPort } from "./checklist";
import { groupWithOpenAI } from "./openai";
import type { Organizer } from "./organize";
import { supabaseChecklistStore } from "./store";

export function liveFieldyPort(): FieldyPort {
  return {
    tasks: () => fieldyTaskSource().tasks(),
    completed: () => listTasks("completed"),
    update: updateTask,
    create: createTask,
    conversations: listConversations,
  };
}

/** The first setting the checklist is missing, or null when it has them all. Names only, never values. */
export function checklistConfigMissing(): string | null {
  if (!fieldyApiKey()) return "FIELDY_API_KEY is not set";
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return "SLACK_BOT_TOKEN is not set";
  if (!token.startsWith("xoxb-")) return "SLACK_BOT_TOKEN is not a bot token (xoxb-…)";
  if (!process.env.SLACK_FIELDY_CHANNEL_ID) return "SLACK_FIELDY_CHANNEL_ID is not set";
  return null;
}

/** Reads the Slack settings when each call runs, so building deps never throws. */
export function liveChecklistDeps(supabase: SupabaseClient = getSupabaseServerClient(), now: () => Date = () => new Date()): ChecklistDeps {
  return {
    fieldy: liveFieldyPort(),
    store: supabaseChecklistStore(supabase),
    slack: {
      post: (channel, text, blocks) => postMessage(process.env.SLACK_BOT_TOKEN ?? "", channel, text, blocks),
      update: (channel, ts, text, blocks) => updateMessage(process.env.SLACK_BOT_TOKEN ?? "", channel, ts, text, blocks),
    },
    channelId: process.env.SLACK_FIELDY_CHANNEL_ID ?? "",
    now,
  };
}

export function liveOrganizer(): Organizer {
  return (open, recordings) => groupWithOpenAI(open, recordings);
}
```

`src/lib/tasks/morning.ts`:

```ts
// The automatic morning checklist: once per Eastern day, at the first cron run
// between 7 and 11am. Same order as the other morning posts: read Fieldy and
// group BEFORE claiming, so a Fieldy outage throws before the claim and the
// next 15-minute run tries again. Once claimed, a failed Slack post is picked
// up by syncWithFieldy (the checklist is saved but unrendered).
import type { SupabaseClient } from "@supabase/supabase-js";
import { completedTasks, pendingTasks, uniqueById } from "@/lib/fieldy/report";
import { claim } from "@/lib/notifications/dedupe";
import { isFieldyDailyDue, localDateKey } from "@/lib/notifications/schedule";
import { buildChecklist, type ChecklistDeps } from "./checklist";
import { groupByRules, validateGrouping, type Grouping, type Organizer } from "./organize";
import type { BuiltBy } from "./store";

export type ChecklistPlan = { grouping: Grouping; builtBy: BuiltBy; finishedYesterday: number };

const RECORDINGS_HOURS = 24;

/** Reads Fieldy (throws if it can't) and groups the open tasks: AI first, rules if that returns null. */
export async function planChecklist(deps: Pick<ChecklistDeps, "fieldy" | "now">, organize: Organizer): Promise<ChecklistPlan> {
  const now = deps.now();
  const all = uniqueById(await deps.fieldy.tasks());
  const open = pendingTasks(all);
  const finishedYesterday = completedTasks(all, now).length;

  // Recordings only help the grouping; without them it still works.
  const since = new Date(now.getTime() - RECORDINGS_HOURS * 3_600_000).toISOString();
  const recordings = await deps.fieldy.conversations(since, now.toISOString()).catch((err: unknown) => {
    console.warn(`[tasks] recordings skipped: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });

  const proposed = await organize(open, recordings);
  if (proposed) return { grouping: validateGrouping(proposed, open), builtBy: "morning_ai", finishedYesterday };
  return { grouping: validateGrouping(groupByRules(open, now), open), builtBy: "morning_rules", finishedYesterday };
}

export async function runChecklistMorningPass(supabase: SupabaseClient, deps: ChecklistDeps, organize: Organizer): Promise<boolean> {
  const now = deps.now();
  if (!isFieldyDailyDue(now)) return false;
  const day = localDateKey(now);
  // Dave may have built today's checklist in ChatGPT before 7.
  if (await deps.store.getByDay(day)) return false;

  const plan = await planChecklist(deps, organize);
  if (!(await claim(supabase, "fieldy_checklist", day))) return false;

  await buildChecklist(deps, plan.grouping, plan.builtBy, plan.finishedYesterday);
  return true;
}
```

`src/lib/tasks/cron.ts`:

```ts
// The Fieldy checklist's part of /api/cron/sync: the morning post and the
// sync with Fieldy. Gated by SLACK_FIELDY_ENABLED and the settings it needs.
// Each pass is caught separately and logged by message only (FieldyApiError
// and SlackApiError messages carry codes, never task text).
import type { SupabaseClient } from "@supabase/supabase-js";
import { fieldyEnabled } from "@/lib/fieldy/fieldy";
import { syncWithFieldy } from "./checklist";
import { checklistConfigMissing, liveChecklistDeps, liveOrganizer } from "./deps";
import { runChecklistMorningPass } from "./morning";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runFieldyChecklistPasses(supabase: SupabaseClient, now: Date): Promise<void> {
  if (!fieldyEnabled()) return;
  const missing = checklistConfigMissing();
  if (missing) {
    console.warn(`[fieldy] checklist skipped: ${missing}`);
    return;
  }
  const deps = liveChecklistDeps(supabase, () => now);
  try {
    await runChecklistMorningPass(supabase, deps, liveOrganizer());
  } catch (err) {
    console.error("[cron] fieldy checklist morning pass failed:", message(err));
  }
  try {
    await syncWithFieldy(deps);
  } catch (err) {
    console.error("[cron] fieldy checklist sync failed:", message(err));
  }
}
```

- [ ] **Step 4: Rewire `fieldy.ts`, `report.ts`, `dedupe.ts`, `commands.ts` and the cron route.**

`src/lib/fieldy/fieldy.ts`:
- Header comment: replace its first paragraph with `// Dave's Fieldy tasks in Slack: the switch, /trinity fieldy preview, and the Fieldy error text. The checklist itself lives in src/lib/tasks/.`
- Remove these imports: `SupabaseClient`, `claim`, `isFieldyDailyDue`, `postMessage`, `formatFieldyPost`.
- Keep `localDateKey`.
- Add these imports:

```ts
import { liveFieldyPort, liveOrganizer } from "@/lib/tasks/deps";
import { planChecklist, type ChecklistPlan } from "@/lib/tasks/morning";
import { renderChecklistPreview } from "@/lib/tasks/render";
```

- Replace `USAGE_TEXT` with:

```ts
export const USAGE_TEXT = [
  "*Dave's Fieldy checklist* posts each morning between 7 and 11.",
  "`/trinity fieldy preview` — today's checklist as it would be built now, shown only to you",
].join("\n");
```

- Replace `renderFieldy` with:

```ts
export async function renderFieldy(
  cmd: FieldyCommand,
  now: Date,
  plan: () => Promise<ChecklistPlan> = () => planChecklist({ fieldy: liveFieldyPort(), now: () => now }, liveOrganizer())
): Promise<string> {
  if (!fieldyEnabled()) return DISABLED_TEXT;
  if (cmd.kind === "fieldyUsage") return USAGE_TEXT;

  // Read-only: no claim, no post, nothing saved. The reply goes back through
  // the slash command's response_url, ephemeral.
  try {
    const p = await plan();
    return renderChecklistPreview(localDateKey(now), p.grouping, p.builtBy, p.finishedYesterday);
  } catch (err) {
    if (err instanceof FieldyApiError) return describeFieldyError(err);
    throw err;
  }
}
```

- Delete `missingConfig`, `FieldyReportDeps`, `defaultDeps` and `runFieldyDailyPass` entirely. Keep `fieldyEnabled`, `DISABLED_TEXT`, `parseFieldy`, `FETCH_STATUSES`, `TaskSource`, `fieldyTaskSource`, `FIXES` and `describeFieldyError`.
- `src/lib/tasks/deps.ts` imports `fieldyTaskSource` from this file, and this file imports `src/lib/tasks/deps.ts`. The cycle is safe because each only uses the other inside functions, but check that the Step 6 test run shows no `undefined is not a function`. If it does, move `FETCH_STATUSES`, `TaskSource` and `fieldyTaskSource` into `src/lib/fieldy/client.ts`, export them from there, re-export them from `fieldy.ts` (`export { fieldyTaskSource, type TaskSource } from "./client";`), and import them in `deps.ts` from `@/lib/fieldy/client`.

`src/lib/fieldy/report.ts`:
- Delete `LIST_MAX`, `TITLE_MAX`, `FOOTNOTE`, `cleanTitle`, `capped` and `formatFieldyPost`.
- Remove the now-unused `dayLabelFromKey` import.
- Change the header to `// Fieldy task helpers: which tasks are open, which were done yesterday, and their dates. Pure.`

`src/lib/notifications/dedupe.ts`: add `| "fieldy_checklist"` to `NotificationKind`, after `"fieldy_daily"`. Keep `"fieldy_daily"` because old rows use it.

`src/lib/slack/commands.ts`: change the help line `"`/trinity fieldy preview` — this morning's Fieldy task post, shown only to you"` to `"`/trinity fieldy preview` — today's Fieldy checklist, shown only to you"`. If `src/lib/slack/__tests__/commands.test.ts` asserts the old wording, update that string to match.

`src/app/api/cron/sync/route.ts`:
- Replace `import { runFieldyDailyPass } from "@/lib/fieldy/fieldy";` with `import { runFieldyChecklistPasses } from "@/lib/tasks/cron";`.
- Replace the Fieldy block inside `if (!force && slackAlertsEnabled())` (the comment starting `// Dave's Fieldy tasks, 7-11am.` and its try/catch) with:

```ts
    // Dave's Fieldy checklist: the 7-11am morning post and the 15-minute sync
    // with Fieldy. Its own switch (SLACK_FIELDY_ENABLED), checks and claim,
    // and it catches its own errors; this try is belt and braces.
    try {
      await runFieldyChecklistPasses(supabase, now);
    } catch (err) {
      console.error("[cron] fieldy checklist passes failed:", err instanceof Error ? err.message : String(err));
    }
```

- [ ] **Step 5: Update the existing tests.**

`src/app/api/cron/sync/__tests__/route.test.ts`:
- Rename the hoisted `runFieldyDailyPassMock` to `runFieldyChecklistPassesMock`, and replace every use of it with the new name.
- Replace `vi.mock("@/lib/fieldy/fieldy", () => ({ runFieldyDailyPass: runFieldyDailyPassMock, … }))` with `vi.mock("@/lib/tasks/cron", () => ({ runFieldyChecklistPasses: runFieldyChecklistPassesMock }));`.
- Rename the two tests to "runs the Fieldy checklist passes and still posts the digest when it throws" and "does not run the Fieldy checklist passes when Slack alerts are disabled". Their assertions stay as they are, including `toHaveBeenCalledWith(expect.anything(), new Date("2026-07-29T10:00:00Z"))`.

`src/lib/fieldy/__tests__/report.test.ts`: delete the whole `describe("formatFieldyPost", …)` block, and remove `formatFieldyPost`, `FOOTNOTE` and `LIST_MAX` from its import.

`src/lib/fieldy/__tests__/fieldy.test.ts`:
- Delete the whole `describe("runFieldyDailyPass", …)` and `describe("renderFieldy", …)` blocks.
- Remove the `FOOTNOTE` import, plus any `vi.mock` or hoisted mock that only those blocks used (`claimMock`, `postMessageMock`, the `@/lib/supabase/client` mock). Keep whatever `fieldyTaskSource`, `parseFieldy` and `describeFieldyError` still need.
- Add `import type { ChecklistPlan } from "@/lib/tasks/morning";` and append:

```ts
describe("renderFieldy", () => {
  const NOW = new Date("2026-11-23T13:00:00.000Z");
  const PLAN: ChecklistPlan = {
    grouping: { groups: [{ name: "Troy job", items: [{ taskId: "t1", text: "Order the Navien" }] }], overflow: 0, movedToOther: [], dropped: [] },
    builtBy: "morning_ai",
    finishedYesterday: 1,
  };

  beforeEach(() => {
    process.env.SLACK_FIELDY_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.SLACK_FIELDY_ENABLED;
  });

  it("is off unless SLACK_FIELDY_ENABLED is exactly 'true'", async () => {
    process.env.SLACK_FIELDY_ENABLED = "TRUE";
    expect(await renderFieldy({ kind: "fieldyPreview" }, NOW, async () => PLAN)).toBe(DISABLED_TEXT);
  });

  it("shows the checklist the morning pass would build", async () => {
    const text = await renderFieldy({ kind: "fieldyPreview" }, NOW, async () => PLAN);
    expect(text).toContain("*Preview: Dave's checklist,");
    expect(text).toContain("• Order the Navien");
    expect(text).toContain("Finished yesterday: 1");
  });

  it("explains a Fieldy failure instead of throwing", async () => {
    const text = await renderFieldy({ kind: "fieldyPreview" }, NOW, async () => {
      throw new FieldyApiError("http_401");
    });
    expect(text).toMatch(/^Couldn't read Fieldy: http_401\./);
  });

  it("shows usage for anything else", async () => {
    expect(await renderFieldy({ kind: "fieldyUsage" }, NOW, async () => PLAN)).toBe(USAGE_TEXT);
  });
});
```

Make sure `renderFieldy`, `DISABLED_TEXT`, `USAGE_TEXT` and `FieldyApiError` are imported in that file, and that `beforeEach` and `afterEach` come from `vitest`.

- [ ] **Step 6: Run the affected tests and the typecheck**

Run: `npx vitest run src/lib/tasks src/lib/fieldy src/lib/slack src/app/api/cron`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: no errors. Fix any leftover reference to `runFieldyDailyPass` or `formatFieldyPost` that the compiler reports, for example under `scripts/`.

- [ ] **Step 7: Commit**

```bash
git add -A src/lib/tasks src/lib/fieldy src/lib/notifications/dedupe.ts src/lib/slack src/app/api/cron
git commit -m "feat(tasks): morning checklist pass, preview and Fieldy sync in the cron; retire the raw post"
```

---

### Task 8: The Trinity Tasks ChatGPT connector

**Files:**
- Modify: `src/lib/mcp/auth.ts`, `src/lib/mcp/handler.ts`
- Create: `src/lib/mcp/tasks/server.ts`, `src/lib/mcp/tasks/deps.ts`, `src/app/api/mcp/tasks/route.ts`, `src/app/.well-known/oauth-protected-resource/api/mcp/tasks/route.ts`
- Test: `src/lib/mcp/tasks/__tests__/server.test.ts`, `src/app/api/mcp/tasks/__tests__/route.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 7; `serveMcp`, `methodNotAllowed` and `McpCaller` from `@/lib/mcp`.
- Produces:
  - `auth.ts`: `TASKS_RESOURCE: McpResource`
  - `handler.ts`: `ServeMcpDeps.createServer: (caller: McpCaller) => McpServer` (existing zero-argument callers still compile)
  - `server.ts`:
    - `interface TasksDeps { checklist: ChecklistDeps; ownerUserId: string | null; configMissing(): string | null }`
    - `createTasksMcpServer(deps: TasksDeps, callerUserId: string | null): McpServer`
    - `NOT_OWNER_TEXT`
    - `SERVER_INSTRUCTIONS`
  - `deps.ts`: `liveTasksDeps(): TasksDeps`, `mcpTasksEnabled(): boolean`

- [ ] **Step 1: Write the failing tests.** `src/lib/mcp/tasks/__tests__/server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NOT_OWNER_TEXT, createTasksMcpServer, type TasksDeps } from "../server";
import { buildChecklist } from "@/lib/tasks/checklist";
import { validateGrouping } from "@/lib/tasks/organize";
import { NOW, makeDeps, task } from "@/lib/tasks/__tests__/fakes";

const DAVE = "user-dave";
const TASKS = [
  task("t1", "Order the Navien", { date: "2026-11-20" }),
  task("t2", "Call Mrs. Smith"),
  task("d1", "Done this morning", { status: "completed", completionDate: "2026-11-23T12:00:00.000Z" }),
];

async function connect(caller: string | null, opts: { configMissing?: string | null } = {}) {
  const ctx = makeDeps({ tasks: TASKS });
  const deps: TasksDeps = { checklist: ctx.deps, ownerUserId: DAVE, configMissing: () => opts.configMissing ?? null };
  const server = createTasksMcpServer(deps, caller);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, ...ctx };
}

function text(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0].text;
}

describe("Trinity Tasks connector", () => {
  it("lists six tools; reads are read-only, writes are not destructive", async () => {
    const { client } = await connect(DAVE);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(Object.keys(byName).sort()).toEqual(
      ["add_task", "get_my_tasks", "get_recent_recordings", "mark_done", "mark_not_done", "post_checklist"]
    );
    expect(byName.get_my_tasks).toMatchObject({ readOnlyHint: true });
    expect(byName.mark_done).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(byName.post_checklist).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it.each([null, "someone-else"])("refuses every tool for caller %j", async (caller) => {
    const { client, fieldy } = await connect(caller);
    for (const name of ["get_my_tasks", "mark_done"]) {
      const res = await client.callTool({ name, arguments: name === "mark_done" ? { taskIds: ["t1"] } : {} });
      expect(res.isError).toBe(true);
      expect(text(res)).toBe(NOT_OWNER_TEXT);
    }
    expect(fieldy.updates).toHaveLength(0);
  });

  it("get_my_tasks lists open and recently completed tasks with checklist state", async () => {
    const { client, deps } = await connect(DAVE);
    await buildChecklist(deps, validateGrouping([{ name: "Troy", items: [{ taskId: "t1" }] }], TASKS.slice(0, 2)), "chatgpt", 0);
    const body = JSON.parse(text(await client.callTool({ name: "get_my_tasks", arguments: {} })));
    expect(body.today).toBe("2026-11-23");
    expect(body.checklist).toEqual({ posted: true, done: 0, total: 2 });
    expect(body.open).toEqual([
      { id: "t1", title: "Order the Navien", due: "2026-11-20", onChecklist: true, group: "Troy", ticked: false },
      { id: "t2", title: "Call Mrs. Smith", due: null, onChecklist: true, group: "Other", ticked: false },
    ]);
    expect(body.recentlyCompleted).toEqual([
      { id: "d1", title: "Done this morning", completedAt: "2026-11-23T12:00:00.000Z", onChecklist: false },
    ]);
  });

  it("post_checklist validates the grouping and posts it", async () => {
    const { client, slack } = await connect(DAVE);
    const body = JSON.parse(
      text(
        await client.callTool({
          name: "post_checklist",
          arguments: { groups: [{ name: "Troy", items: [{ taskId: "t1", text: "Order Navien" }, { taskId: "bogus" }] }] },
        })
      )
    );
    expect(body).toMatchObject({ posted: true, movedToOther: ["t2"], droppedIds: ["bogus"], notShownCount: 0 });
    expect(slack.posts).toHaveLength(1);
  });

  it("post_checklist says what's missing when Slack isn't set up", async () => {
    const { client, slack } = await connect(DAVE, { configMissing: "SLACK_FIELDY_CHANNEL_ID is not set" });
    const res = await client.callTool({ name: "post_checklist", arguments: { groups: [] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("SLACK_FIELDY_CHANNEL_ID is not set");
    expect(slack.posts).toHaveLength(0);
  });

  it("mark_done ticks today's checklist and marks Fieldy", async () => {
    const { client, deps, fieldy } = await connect(DAVE);
    await buildChecklist(deps, validateGrouping([], TASKS.slice(0, 2)), "chatgpt", 0);
    const body = JSON.parse(text(await client.callTool({ name: "mark_done", arguments: { taskIds: ["t2"] } })));
    expect(body).toMatchObject({ changed: ["t2"], unchanged: [], notOnChecklist: [] });
    expect(fieldy.updates).toEqual([["t2", { status: "completed", completionDate: NOW.toISOString() }]]);
  });

  it("mark_done explains a Fieldy failure and points back to get_my_tasks", async () => {
    const { client } = await connect(DAVE);
    const res = await client.callTool({ name: "mark_done", arguments: { taskIds: ["missing"] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^Couldn't update Fieldy: http_404\..*get_my_tasks/);
  });

  it("add_task creates the task and reports whether it's on the checklist", async () => {
    const { client, fieldy } = await connect(DAVE);
    const body = JSON.parse(text(await client.callTool({ name: "add_task", arguments: { title: "Call the Navien rep", dueDate: "2026-11-24" } })));
    expect(fieldy.created).toEqual([{ title: "Call the Navien rep", date: "2026-11-24T17:00:00.000Z" }]);
    expect(body).toMatchObject({ created: { title: "Call the Navien rep" }, onChecklist: false });
  });

  it("get_recent_recordings returns titles and summaries only", async () => {
    const { client, fieldy } = await connect(DAVE);
    fieldy.setRecordings([{ id: "c1", title: "Troy walkthrough", summary: "Boiler swap.", startTime: "2026-11-23T12:00:00.000Z" }]);
    const body = JSON.parse(text(await client.callTool({ name: "get_recent_recordings", arguments: { hours: 12 } })));
    expect(body.recordings).toEqual([{ title: "Troy walkthrough", summary: "Boiler swap.", startTime: "2026-11-23T12:00:00.000Z" }]);
  });
});
```

`src/app/api/mcp/tasks/__tests__/route.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { POST, GET, DELETE } from "../route";
import { GET as metadataGET } from "@/app/.well-known/oauth-protected-resource/api/mcp/tasks/route";
import { serveMcp } from "@/lib/mcp/handler";
import { TASKS_RESOURCE } from "@/lib/mcp/auth";
import { NOT_OWNER_TEXT, createTasksMcpServer } from "@/lib/mcp/tasks/server";
import { makeDeps } from "@/lib/tasks/__tests__/fakes";

afterEach(() => vi.unstubAllEnvs());

function rpc(body: unknown, auth?: string) {
  return new Request("https://ops.example.com/api/mcp/tasks", {
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

describe("/api/mcp/tasks", () => {
  it.each([undefined, "", "TRUE", "1"])("is off when MCP_TASKS_ENABLED is %j", async (value) => {
    if (value !== undefined) vi.stubEnv("MCP_TASKS_ENABLED", value);
    const res = await POST(rpc(LIST, "Bearer anything"));
    expect(res.status).toBe(503);
  });

  it("challenges with the tasks metadata URL when on", async () => {
    vi.stubEnv("MCP_TASKS_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const res = await POST(rpc(LIST));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/tasks"'
    );
  });

  it("serves its own protected-resource metadata", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    const res = metadataGET(new Request("https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/tasks"));
    expect(await res.json()).toMatchObject({ resource: "https://ops.example.com/api/mcp/tasks", resource_name: TASKS_RESOURCE.name });
  });

  it("passes the verified caller to the server, which refuses anyone but Dave", async () => {
    const verify = async () => ({ sub: "not-dave", role: "authenticated", client_id: "c1" });
    const res = await serveMcp(
      rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_my_tasks", arguments: {} } }, "Bearer ok"),
      {
        verify,
        resource: TASKS_RESOURCE,
        createServer: (caller) =>
          createTasksMcpServer({ checklist: makeDeps().deps, ownerUserId: "dave", configMissing: () => null }, caller.userId),
      }
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(NOT_OWNER_TEXT);
  });

  it("allows only POST", async () => {
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/lib/mcp/tasks src/app/api/mcp/tasks`
Expected: FAIL, with the modules missing.

- [ ] **Step 3: Implement.**

`src/lib/mcp/auth.ts`, after `JOBS_RESOURCE`:

```ts
export const TASKS_RESOURCE: McpResource = {
  path: "/api/mcp/tasks",
  metadataPath: "/.well-known/oauth-protected-resource/api/mcp/tasks",
  name: "Trinity Plumbing tasks (Dave only)",
};
```

`src/lib/mcp/handler.ts`:
- Add `type McpCaller` to the import from `"./auth"`.
- Change `createServer: () => McpServer;` to `createServer: (caller: McpCaller) => McpServer;`.
- In `serveMcp`, change `const server = deps.createServer();` to `const server = deps.createServer(caller);`.

`src/lib/mcp/tasks/server.ts`:

```ts
// The "Trinity Tasks" ChatGPT connector: Dave's Fieldy tasks and his daily
// Slack checklist. Dave only: every tool checks the caller against
// MCP_TASKS_OWNER_USER_ID first. The write tools go through
// src/lib/tasks/checklist.ts, the same code Slack taps and the cron use.
// Spec: docs/superpowers/specs/2026-11-21-fieldy-checklist-design.md
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FieldyApiError } from "@/lib/fieldy/client";
import { describeFieldyError } from "@/lib/fieldy/fieldy";
import { completedTasks, dayKeyOf, pendingTasks, uniqueById } from "@/lib/fieldy/report";
import { localDateKey } from "@/lib/notifications/schedule";
import { addTask, buildChecklist, markDone, markNotDone, type ChecklistDeps } from "@/lib/tasks/checklist";
import { validateGrouping } from "@/lib/tasks/organize";

export interface TasksDeps {
  checklist: ChecklistDeps;
  /** MCP_TASKS_OWNER_USER_ID; null means nobody may use the connector. */
  ownerUserId: string | null;
  /** The first missing Slack/Fieldy setting, or null. */
  configMissing(): string | null;
}

export const NOT_OWNER_TEXT = "Trinity Tasks is only available to Dave's login.";

export const SERVER_INSTRUCTIONS = [
  "Trinity Tasks manages Dave's Fieldy tasks and his daily Slack checklist. Dave wears a Fieldy pendant that turns what he says into tasks.",
  "To organize his day: call get_my_tasks, optionally get_recent_recordings to see which tasks belong to the same job, then post_checklist with the open tasks in groups (by job, customer, place, or kind of errand).",
  "Checklist text must come from the task title: shorten it, but never add names, numbers or details that aren't in the title.",
  "When Dave says he finished something, call get_my_tasks, find the matching task, and call mark_done with its id. If more than one task could match, or none clearly does, ask him which one first. Never mark a task done on a guess.",
  "Use mark_not_done to undo a mistake, and add_task when he asks to add something (ask for a due date only if he mentions one).",
  "Recording summaries are for your context only; don't copy them into the checklist.",
].join(" ");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const WRITE_IDEMPOTENT = { ...WRITE, idempotentHint: true } as const;
const RECENT_DONE_HOURS = 48;

type ToolResult = { isError?: boolean; content: { type: "text"; text: string }[] };

function json(body: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

function refuse(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

const TASK_ID = z.string().min(1).max(200);

export function createTasksMcpServer(deps: TasksDeps, callerUserId: string | null): McpServer {
  const server = new McpServer({ name: "trinity-tasks", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  const isOwner = deps.ownerUserId !== null && callerUserId === deps.ownerUserId;
  const c = deps.checklist;

  // Owner check, then the setup check for tools that touch Slack, then one
  // error wrapper. Fieldy errors get their fix text; anything else a fixed
  // sentence, with the real message in the server log only.
  async function run(tool: string, opts: { writes: boolean }, body: () => Promise<ToolResult>): Promise<ToolResult> {
    if (!isOwner) return refuse(NOT_OWNER_TEXT);
    if (opts.writes) {
      const missing = deps.configMissing();
      if (missing) return refuse(`The Slack checklist isn't set up yet: ${missing}.`);
    }
    try {
      return await body();
    } catch (err) {
      if (err instanceof FieldyApiError) {
        return refuse(opts.writes ? `${describeFieldyError(err)} Call get_my_tasks to see what changed.` : describeFieldyError(err));
      }
      console.error(`[mcp-tasks] ${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
      return refuse("Something went wrong on Trinity's side. Try again in a minute.");
    }
  }

  const todayChecklist = () => c.store.getByDay(localDateKey(c.now()));

  server.registerTool(
    "get_my_tasks",
    {
      title: "Get my Fieldy tasks",
      description:
        "Dave's open Fieldy tasks (new and approved) and the ones finished in the last 2 days. Each has its Fieldy id, due date, and whether it's on today's Slack checklist and ticked. Call this before post_checklist, mark_done or mark_not_done.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      run("get_my_tasks", { writes: false }, async () => {
        const now = c.now();
        const all = uniqueById(await c.fieldy.tasks());
        const cl = await todayChecklist();
        const items = cl ? await c.store.listItems(cl.id) : [];
        const onList = new Map(items.map((i) => [i.fieldyTaskId, i]));
        const since = now.getTime() - RECENT_DONE_HOURS * 3_600_000;
        return json({
          today: localDateKey(now),
          checklist: cl ? { posted: cl.messageTs !== null, done: items.filter((i) => i.doneAt !== null).length, total: items.length } : null,
          open: pendingTasks(all).map((t) => ({
            id: t.id,
            title: t.title,
            due: dayKeyOf(t.date),
            onChecklist: onList.has(t.id),
            group: onList.get(t.id)?.groupName ?? null,
            ticked: Boolean(onList.get(t.id)?.doneAt),
          })),
          recentlyCompleted: all
            .filter((t) => t.status === "completed" && t.completionDate && Date.parse(t.completionDate) >= since)
            .map((t) => ({ id: t.id, title: t.title, completedAt: t.completionDate, onChecklist: onList.has(t.id) })),
        });
      })
  );

  server.registerTool(
    "get_recent_recordings",
    {
      title: "Get recent recordings",
      description:
        "Titles and summaries of Dave's Fieldy recordings from the last `hours` (default 24, at most 72), up to 20. Never full transcripts. Use these only to see which tasks belong together.",
      inputSchema: { hours: z.number().int().min(1).max(72).optional().describe("How far back to look. Default 24.") },
      annotations: READ_ONLY,
    },
    async ({ hours }) =>
      run("get_recent_recordings", { writes: false }, async () => {
        const now = c.now();
        const since = new Date(now.getTime() - (hours ?? 24) * 3_600_000).toISOString();
        const recordings = await c.fieldy.conversations(since, now.toISOString());
        return json({ recordings: recordings.map((r) => ({ title: r.title, summary: r.summary, startTime: r.startTime })) });
      })
  );

  server.registerTool(
    "post_checklist",
    {
      title: "Post today's checklist",
      description:
        'Posts (or rebuilds) today\'s checklist in Dave\'s Slack channel. Give every open task from get_my_tasks a group. Tasks you leave out go under "Other"; unknown ids are dropped; anything Dave already ticked today stays ticked. Item text: the task title, shortened, nothing added.',
      inputSchema: {
        groups: z
          .array(
            z.object({
              name: z.string().max(100),
              items: z.array(z.object({ taskId: TASK_ID, text: z.string().max(200).optional() })).max(60),
            })
          )
          .max(20),
      },
      annotations: WRITE,
    },
    async ({ groups }) =>
      run("post_checklist", { writes: true }, async () => {
        const all = uniqueById(await c.fieldy.tasks());
        const grouping = validateGrouping(groups, pendingTasks(all));
        await buildChecklist(c, grouping, "chatgpt", completedTasks(all, c.now()).length);
        return json({
          posted: true,
          groups: grouping.groups,
          movedToOther: grouping.movedToOther,
          droppedIds: grouping.dropped,
          notShownCount: grouping.overflow,
        });
      })
  );

  server.registerTool(
    "mark_done",
    {
      title: "Mark tasks done",
      description:
        "Marks tasks completed in Fieldy and ticks them on today's Slack checklist. Only use ids from get_my_tasks, and only when Dave clearly said he finished that task.",
      inputSchema: { taskIds: z.array(TASK_ID).min(1).max(25) },
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ taskIds }) =>
      run("mark_done", { writes: true }, async () => {
        const cl = await todayChecklist();
        const r = await markDone(c, cl?.id ?? null, taskIds, "chatgpt");
        return json({
          ...r,
          note: cl
            ? "Ticked on today's Slack checklist and marked completed in Fieldy."
            : "There's no checklist today, so these were only marked completed in Fieldy.",
        });
      })
  );

  server.registerTool(
    "mark_not_done",
    {
      title: "Mark tasks not done",
      description: "Undoes mark_done: the tasks go back to open in Fieldy and are unticked on today's checklist.",
      inputSchema: { taskIds: z.array(TASK_ID).min(1).max(25) },
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ taskIds }) =>
      run("mark_not_done", { writes: true }, async () => {
        const cl = await todayChecklist();
        return json({ ...(await markNotDone(c, cl?.id ?? null, taskIds, "chatgpt")) });
      })
  );

  server.registerTool(
    "add_task",
    {
      title: "Add a task",
      description:
        'Creates a task in Dave\'s Fieldy and adds it to today\'s checklist if there is one. dueDate is YYYY-MM-DD (default today); group is optional (default "Added").',
      inputSchema: {
        title: z.string().min(1).max(200),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        group: z.string().max(60).optional(),
      },
      annotations: WRITE,
    },
    async ({ title, dueDate, group }) =>
      run("add_task", { writes: true }, async () => {
        const r = await addTask(c, { title, dueDay: dueDate, group });
        return json({
          created: { id: r.task.id, title: r.task.title },
          onChecklist: r.checklistId !== null,
          note: r.checklistId !== null ? "Added to today's checklist." : "No checklist today yet; it will show on the next one.",
        });
      })
  );

  return server;
}
```

`src/lib/mcp/tasks/deps.ts`:

```ts
// Live wiring and kill switch for the Trinity Tasks connector.
import { checklistConfigMissing, liveChecklistDeps } from "@/lib/tasks/deps";
import type { TasksDeps } from "./server";

export function liveTasksDeps(): TasksDeps {
  return {
    checklist: liveChecklistDeps(),
    ownerUserId: process.env.MCP_TASKS_OWNER_USER_ID || null,
    configMissing: checklistConfigMissing,
  };
}

// Off unless exactly "true", like the other connectors.
export function mcpTasksEnabled(): boolean {
  return process.env.MCP_TASKS_ENABLED === "true";
}
```

`src/app/api/mcp/tasks/route.ts`:

```ts
// MCP endpoint for the Trinity Tasks connector (Dave only; reads and writes Fieldy, posts to Slack).
// Spec: docs/superpowers/specs/2026-11-21-fieldy-checklist-design.md
//
// Not covered by src/middleware.ts on purpose: ChatGPT has no cookie session.
// Every request must carry a Supabase-issued OAuth access token instead.
import { TASKS_RESOURCE, supabaseClaimsVerifier, type ClaimsVerifier } from "@/lib/mcp/auth";
import { methodNotAllowed, serveMcp } from "@/lib/mcp/handler";
import { liveTasksDeps, mcpTasksEnabled } from "@/lib/mcp/tasks/deps";
import { createTasksMcpServer } from "@/lib/mcp/tasks/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Built on first use so a missing env var fails the request, not the build.
let verify: ClaimsVerifier | null = null;

export async function POST(req: Request): Promise<Response> {
  // Before the token check, so a switched-off connector reveals nothing and runs nothing.
  if (!mcpTasksEnabled()) {
    return Response.json({ error: "disabled", message: "The Trinity Tasks connector is turned off." }, { status: 503 });
  }
  verify ??= supabaseClaimsVerifier();
  return serveMcp(req, {
    verify,
    resource: TASKS_RESOURCE,
    createServer: (caller) => createTasksMcpServer(liveTasksDeps(), caller.userId),
  });
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
```

`src/app/.well-known/oauth-protected-resource/api/mcp/tasks/route.ts`:

```ts
// RFC 9728 path-specific metadata for /api/mcp/tasks. The 401 from that
// endpoint points here, so ChatGPT registers the tasks connector on its own.
import { TASKS_RESOURCE, metadataResponse } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return metadataResponse(req, TASKS_RESOURCE);
}
```

- [ ] **Step 4: Run the MCP tests, old and new, and the typecheck**

Run: `npx vitest run src/lib/mcp src/app/api/mcp src/__tests__/middleware.test.ts`
Expected: PASS. The middleware test's existing `/api/mcp` and `/.well-known` exclusion checks also cover the new paths.
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp src/app/api/mcp/tasks "src/app/.well-known/oauth-protected-resource/api/mcp/tasks"
git commit -m "feat(mcp): Trinity Tasks connector for Dave: tasks, recordings, checklist, done/undo, add"
```

---

### Task 9: Slack checkbox taps

**Files:**
- Create: `src/lib/tasks/interact.ts`, `src/app/api/slack/interact/route.ts`
- Test: `src/lib/tasks/__tests__/interact.test.ts`, `src/app/api/slack/interact/__tests__/route.test.ts`

**Interfaces:**
- Consumes:
  - `markDone`, `markNotDone`, `renderChecklist` and `ChecklistDeps` (Task 6)
  - `parseActionId` (Task 5)
  - `describeFieldyError` and `fieldyEnabled` (`fieldy.ts`)
  - `verifySlackSignature`, `postEphemeralNote` (Task 5)
  - `liveChecklistDeps` and `checklistConfigMissing` (Task 7)
- Produces:
  - `type BlockActionsPayload`
  - `optionValuesFor(blocks, actionId): string[] | null`
  - `allowedSlackUsers(): string[]`
  - `NOT_ALLOWED_TEXT`, `TAP_FAILED_TEXT`
  - `handleChecklistTap(payload, deps, opts: { allowedUsers: string[]; note(responseUrl: string, text: string): Promise<unknown> }): Promise<void>`

- [ ] **Step 1: Write the failing tests.** `src/lib/tasks/__tests__/interact.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FieldyApiError } from "@/lib/fieldy/client";
import { buildChecklist } from "../checklist";
import { NOT_ALLOWED_TEXT, handleChecklistTap, optionValuesFor, type BlockActionsPayload } from "../interact";
import { validateGrouping } from "../organize";
import { makeDeps, task } from "./fakes";

const DAVE = "U_DAVE";
const TASKS = [task("t1", "Order the Navien"), task("t2", "Call Mrs. Smith"), task("t3", "Van list")];

async function setup() {
  const ctx = makeDeps({ tasks: TASKS });
  const id = await buildChecklist(
    ctx.deps,
    validateGrouping([{ name: "A", items: [{ taskId: "t1" }, { taskId: "t2" }] }, { name: "B", items: [{ taskId: "t3" }] }], TASKS),
    "morning_ai",
    0
  );
  const note = vi.fn(async () => true);
  // What Slack sends: the message as Dave saw it, and the boxes now ticked in the one element he tapped.
  const tap = (actionId: string, selected: string[], user = DAVE): BlockActionsPayload => ({
    type: "block_actions",
    user: { id: user },
    response_url: "https://hooks.slack.com/actions/x",
    message: { blocks: ctx.slack.lastBlocks() },
    actions: [{ action_id: actionId, selected_options: selected.map((value) => ({ value })) }],
  });
  return { ...ctx, id, note, tap };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("handleChecklistTap", () => {
  it("ticks a box: Fieldy completed, item done via slack, message re-rendered", async () => {
    const { deps, fieldy, slack, items, id, note, tap } = await setup();
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, ["t2"]), deps, { allowedUsers: [DAVE], note });
    expect(fieldy.updates.map(([tid, u]) => [tid, u.status])).toEqual([["t2", "completed"]]);
    expect(items.get(id)!.find((i) => i.fieldyTaskId === "t2")).toMatchObject({ doneVia: "slack" });
    expect(slack.updates).toHaveLength(1);
    expect(note).not.toHaveBeenCalled();
  });

  it("unticks a box and leaves the other group alone", async () => {
    const { deps, fieldy, items, id, note, tap } = await setup();
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, ["t1", "t2"]), deps, { allowedUsers: [DAVE], note });
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, ["t2"]), deps, { allowedUsers: [DAVE], note });
    expect(fieldy.updates.map(([tid, u]) => [tid, u.status])).toEqual([
      ["t1", "completed"],
      ["t2", "completed"],
      ["t1", "approved"],
    ]);
    expect(items.get(id)!.find((i) => i.fieldyTaskId === "t3")!.doneAt).toBeNull();
  });

  it("snaps back and tells anyone else only Dave can tick", async () => {
    const { deps, fieldy, slack, id, note, tap } = await setup();
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, ["t1"], "U_ELLA"), deps, { allowedUsers: [DAVE], note });
    expect(fieldy.updates).toHaveLength(0);
    expect(slack.updates).toHaveLength(1);
    expect(note).toHaveBeenCalledWith("https://hooks.slack.com/actions/x", NOT_ALLOWED_TEXT);
  });

  it("snaps back and explains when Fieldy fails", async () => {
    const { deps, fieldy, slack, items, id, note, tap } = await setup();
    fieldy.failUpdateAt(1, new FieldyApiError("http_401", "PATCH /tasks/{id}"));
    await handleChecklistTap(tap(`fieldy_cb:${id}:0`, ["t1"]), deps, { allowedUsers: [DAVE], note });
    expect(items.get(id)!.every((i) => i.doneAt === null)).toBe(true);
    expect(slack.updates).toHaveLength(1);
    expect(note).toHaveBeenCalledWith("https://hooks.slack.com/actions/x", expect.stringMatching(/^Couldn't update Fieldy: http_401\./));
  });

  it("ignores actions that aren't checklist boxes, and unknown checklists", async () => {
    const { deps, fieldy, slack, note, tap } = await setup();
    await handleChecklistTap(tap("something_else", ["t1"]), deps, { allowedUsers: [DAVE], note });
    await handleChecklistTap(tap("fieldy_cb:999:0", ["t1"]), deps, { allowedUsers: [DAVE], note });
    expect(fieldy.updates).toHaveLength(0);
    expect(slack.updates).toHaveLength(0);
  });
});

describe("optionValuesFor", () => {
  it("finds the option values of one checkboxes element", () => {
    const blocks = [{ type: "actions", elements: [{ action_id: "fieldy_cb:1:0", options: [{ value: "a" }, { value: "b" }] }] }];
    expect(optionValuesFor(blocks, "fieldy_cb:1:0")).toEqual(["a", "b"]);
    expect(optionValuesFor(blocks, "fieldy_cb:1:9")).toBeNull();
  });
});
```

`src/app/api/slack/interact/__tests__/route.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

const { tapMock, waitUntilMock } = vi.hoisted(() => ({
  tapMock: vi.fn(async () => {}),
  waitUntilMock: vi.fn((p: Promise<unknown>) => p),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: waitUntilMock }));
vi.mock("@/lib/tasks/interact", async (orig) => ({
  ...(await orig<typeof import("@/lib/tasks/interact")>()),
  handleChecklistTap: tapMock,
}));
// Every export the real modules import from deps.ts, so none is missing from the mock.
vi.mock("@/lib/tasks/deps", () => ({
  liveChecklistDeps: () => ({}),
  checklistConfigMissing: () => null,
  liveFieldyPort: () => ({}),
  liveOrganizer: () => async () => null,
}));

import { POST } from "../route";

const SECRET = "test-signing-secret";

function signedRequest(payload: unknown, opts: { ts?: number; secret?: string } = {}) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = "v0=" + createHmac("sha256", opts.secret ?? SECRET).update(`v0:${ts}:${body}`).digest("hex");
  return new Request("https://ops.example.com/api/slack/interact", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
}

const TAP = {
  type: "block_actions",
  user: { id: "U_DAVE" },
  actions: [{ action_id: "fieldy_cb:1:0", selected_options: [{ value: "t1" }] }],
};

beforeEach(() => {
  tapMock.mockClear();
  vi.stubEnv("SLACK_FIELDY_ENABLED", "true");
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  vi.stubEnv("SLACK_FIELDY_ALLOWED_USERS", "U_DAVE, U_OTHER");
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/slack/interact", () => {
  it("hands a signed checklist tap to handleChecklistTap and answers 200 at once", async () => {
    const res = await POST(signedRequest(TAP));
    expect(res.status).toBe(200);
    expect(tapMock).toHaveBeenCalledTimes(1);
    expect(tapMock.mock.calls[0][0]).toEqual(TAP);
    expect(tapMock.mock.calls[0][2]).toMatchObject({ allowedUsers: ["U_DAVE", "U_OTHER"] });
  });

  it("does nothing while SLACK_FIELDY_ENABLED is off", async () => {
    vi.stubEnv("SLACK_FIELDY_ENABLED", "TRUE");
    const res = await POST(signedRequest(TAP));
    expect(res.status).toBe(200);
    expect(tapMock).not.toHaveBeenCalled();
  });

  it("refuses with 503 when the signing secret isn't set", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "");
    expect((await POST(signedRequest(TAP))).status).toBe(503);
  });

  it.each([
    ["a bad signature", { secret: "wrong" }],
    ["an old timestamp", { ts: Math.floor(Date.now() / 1000) - 600 }],
  ])("rejects %s with 401", async (_label, opts) => {
    expect((await POST(signedRequest(TAP, opts))).status).toBe(401);
    expect(tapMock).not.toHaveBeenCalled();
  });

  it("ignores payloads that aren't checklist taps", async () => {
    const res = await POST(signedRequest({ type: "block_actions", actions: [{ action_id: "other" }] }));
    expect(res.status).toBe(200);
    expect(tapMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run src/lib/tasks/__tests__/interact.test.ts src/app/api/slack/interact`
Expected: FAIL, with the modules missing.

- [ ] **Step 3: Implement.** `src/lib/tasks/interact.ts`:

```ts
// A tap on a checklist checkbox in Slack. Slack sends the message as Dave saw
// it and which boxes in the tapped element are ticked now; the difference from
// the database is what to tick and untick. Both go through the same service as
// ChatGPT's mark_done / mark_not_done, so Fieldy is updated first.
//
// After every tap the message is re-rendered from the database: that is what
// "snaps back" a tap that wasn't allowed or that Fieldy refused.
import { FieldyApiError } from "@/lib/fieldy/client";
import { describeFieldyError } from "@/lib/fieldy/fieldy";
import { markDone, markNotDone, renderChecklist, type ChecklistDeps } from "./checklist";
import { parseActionId } from "./render";

export type BlockActionsPayload = {
  type?: string;
  user?: { id?: string };
  response_url?: string;
  message?: { blocks?: unknown[] };
  actions?: Array<{ action_id?: string; selected_options?: Array<{ value?: string }> }>;
};

export const NOT_ALLOWED_TEXT = "Only Dave can check these off.";
export const TAP_FAILED_TEXT = "Couldn't update the checklist just now. Try again in a minute.";

export function allowedSlackUsers(): string[] {
  return (process.env.SLACK_FIELDY_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The option values of the checkboxes element with this action_id in the tapped message, or null. */
export function optionValuesFor(blocks: unknown[] | undefined, actionId: string): string[] | null {
  for (const b of blocks ?? []) {
    const block = b as { type?: string; elements?: unknown[] };
    if (block.type !== "actions") continue;
    for (const e of block.elements ?? []) {
      const el = e as { action_id?: string; options?: Array<{ value?: unknown }> };
      if (el.action_id === actionId) {
        return (el.options ?? []).map((o) => o.value).filter((v): v is string => typeof v === "string");
      }
    }
  }
  return null;
}

export async function handleChecklistTap(
  payload: BlockActionsPayload,
  deps: ChecklistDeps,
  opts: { allowedUsers: string[]; note: (responseUrl: string, text: string) => Promise<unknown> }
): Promise<void> {
  const userId = payload.user?.id ?? "";
  const say = async (text: string) => {
    if (payload.response_url) await opts.note(payload.response_url, text);
  };

  for (const action of payload.actions ?? []) {
    const id = action.action_id ?? "";
    const parsed = parseActionId(id);
    if (!parsed) continue;
    const cl = await deps.store.getById(parsed.checklistId);
    if (!cl) continue;

    if (!opts.allowedUsers.includes(userId)) {
      await renderChecklist(deps, cl.id);
      await say(NOT_ALLOWED_TEXT);
      continue;
    }

    const values = optionValuesFor(payload.message?.blocks, id) ?? [];
    const selected = new Set((action.selected_options ?? []).map((o) => o.value));
    const byId = new Map((await deps.store.listItems(cl.id)).map((i) => [i.fieldyTaskId, i]));
    const tick: string[] = [];
    const untick: string[] = [];
    for (const v of values) {
      const item = byId.get(v);
      if (!item) continue;
      const isDone = item.doneAt !== null;
      if (selected.has(v) && !isDone) tick.push(v);
      if (!selected.has(v) && isDone) untick.push(v);
    }

    try {
      if (tick.length > 0) await markDone(deps, cl.id, tick, "slack");
      if (untick.length > 0) await markNotDone(deps, cl.id, untick, "slack");
      if (tick.length === 0 && untick.length === 0) await renderChecklist(deps, cl.id);
    } catch (err) {
      await renderChecklist(deps, cl.id).catch(() => undefined);
      if (err instanceof FieldyApiError) {
        await say(describeFieldyError(err));
      } else {
        console.error(`[tasks] checklist tap failed: ${err instanceof Error ? err.message : String(err)}`);
        await say(TAP_FAILED_TEXT);
      }
    }
  }
}
```

`src/app/api/slack/interact/route.ts`:

```ts
// Slack interactivity: taps on Dave's Fieldy checklist checkboxes.
// Slack app → Interactivity & Shortcuts → Request URL https://ops.trinity.plumbing/api/slack/interact
//
// Like /api/slack/command, this is NOT behind src/middleware.ts's session gate
// (Slack's servers carry no cookies). The signature check below is the whole
// of the authentication; src/__tests__/middleware.test.ts keeps /api/slack/*
// out of the matcher.
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { fieldyEnabled } from "@/lib/fieldy/fieldy";
import { postEphemeralNote } from "@/lib/slack/respond";
import { verifySlackSignature } from "@/lib/slack/verify";
import { checklistConfigMissing, liveChecklistDeps } from "@/lib/tasks/deps";
import { allowedSlackUsers, handleChecklistTap, type BlockActionsPayload } from "@/lib/tasks/interact";
import { parseActionId } from "@/lib/tasks/render";

export const maxDuration = 60;

const OK = () => new NextResponse(null, { status: 200 });

export async function POST(req: Request) {
  // Same order as the command route: switch, secret, then read and verify the body.
  if (!fieldyEnabled()) return OK();

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
  const isChecklistTap =
    payload?.type === "block_actions" && (payload.actions ?? []).some((a) => a.action_id && parseActionId(a.action_id));
  if (!isChecklistTap) return OK();

  const missing = checklistConfigMissing();
  if (missing) {
    console.warn(`[fieldy] checklist tap ignored: ${missing}`);
    return OK();
  }

  // Slack wants an answer within 3 seconds; Fieldy plus chat.update can take longer.
  waitUntil(
    handleChecklistTap(payload, liveChecklistDeps(), { allowedUsers: allowedSlackUsers(), note: postEphemeralNote }).catch((err) =>
      console.error("[slack] checklist tap failed:", err instanceof Error ? err.message : String(err))
    )
  );
  return OK();
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run src/lib/tasks src/app/api/slack src/__tests__/middleware.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tasks/interact.ts src/lib/tasks/__tests__/interact.test.ts src/app/api/slack/interact
git commit -m "feat(slack): tick and untick Dave's checklist from Slack checkboxes"
```

---

### Task 10: Rollout doc and full verification

**Files:**
- Modify: `docs/SLACK-ROLLOUT.md` (replace the section `## Dave's Fieldy tasks — morning post and \`/trinity fieldy preview\`` and its `### Go-live (Ryan)` subsection, up to the next `## ` heading or the end of the file)

- [ ] **Step 1: Replace that section** in `docs/SLACK-ROLLOUT.md` with:

````markdown
## Dave's Fieldy checklist — Slack, ChatGPT and `/trinity fieldy preview`

Each morning between 7 and 11 (Eastern) the bot posts Dave's open Fieldy tasks
as one grouped checklist in a private channel. Ticking a box in Slack, or
telling ChatGPT "done with X" through the **Trinity Tasks** connector, marks the
task completed in Fieldy too. ChatGPT can also rebuild the checklist and add
tasks. Grouping uses the OpenAI API; if that fails the post still goes out,
grouped by date. Spec: `docs/superpowers/specs/2026-11-21-fieldy-checklist-design.md`.

### Go-live (Ryan)

0. **Test Dave's key first** (works with the code before this branch too):
   Vercel → Production → set `FIELDY_API_KEY`, `SLACK_FIELDY_CHANNEL_ID`,
   `SLACK_FIELDY_ENABLED=true`; redeploy; `/trinity fieldy preview` should list
   his real tasks.
1. Merge, then run `supabase/migrations/0008_task_checklists.sql` in the ops
   Supabase SQL editor.
2. Vercel → Production:
   - `OPENAI_API_KEY` — from platform.openai.com (billed separately from ChatGPT Business)
   - `OPENAI_MODEL` — optional; default `gpt-6-luna`
   - `MCP_TASKS_ENABLED=true`
   - `MCP_TASKS_OWNER_USER_ID` — Dave's user id (Supabase → Authentication → Users)
   - `SLACK_FIELDY_ALLOWED_USERS` — Dave's Slack member id (profile → ⋮ → Copy member ID)
   - confirm `SLACK_SIGNING_SECRET` is set (the `/trinity` command already uses it)

   Redeploy.
3. Slack app → **Interactivity & Shortcuts** → On → Request URL
   `https://ops.trinity.plumbing/api/slack/interact` → Save.
4. ChatGPT (Trinity workspace) → Plugins → Add custom MCP server: name
   `Trinity Tasks`, URL `https://ops.trinity.plumbing/api/mcp/tasks`, OAuth.
   Publish to the workspace; Dave connects with his ops login.
5. With Dave: "organize my Fieldy tasks" → a checklist appears in the channel;
   tick one box in Slack and say "done with …" in ChatGPT for another → both
   show completed in the Fieldy app; "add: call the Navien rep" → appears in
   Fieldy and under **Added**. Next morning: one post, not two.

### If something's off

| What you see | Cause |
|---|---|
| Preview says Fieldy isn't set up | `FIELDY_API_KEY` missing or not redeployed |
| No morning post | `SLACK_FIELDY_ENABLED` not exactly `true`, `SLACK_ALERTS_ENABLED` off, bot not in the channel, or a checklist already exists today |
| Footer says "AI grouping didn't run" | `OPENAI_API_KEY` missing or OpenAI failed; logs show `[tasks] AI grouping skipped: <code>` |
| Tapping a box does nothing | Interactivity URL not saved, or `SLACK_SIGNING_SECRET` missing |
| "Only Dave can check these off." for Dave | His member id isn't in `SLACK_FIELDY_ALLOWED_USERS` |
| ChatGPT says "only available to Dave's login" for Dave | `MCP_TASKS_OWNER_USER_ID` isn't his Supabase user id |

### Rollback

Set `SLACK_FIELDY_ENABLED` and `MCP_TASKS_ENABLED` to anything but `true` and
redeploy. Nothing in Fieldy is deleted by this feature, ever.
````

- [ ] **Step 2: Run the full suite, the typecheck, the lint and the build**

Run: `npx vitest run`
Expected: all tests pass.
Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npm run lint`
Expected: no errors. Fix any unused imports it reports.
Run: `npm run build`
Expected: build succeeds and lists `/api/mcp/tasks`, `/api/slack/interact` and `/.well-known/oauth-protected-resource/api/mcp/tasks`.

- [ ] **Step 3: Check that no task text reaches the logs.** Review every new `console.*` call:

Run: `git diff origin/main --unified=0 -- src | grep -n "console\."`
Expected: each logged string is a fixed prefix plus an error code or `err.message` from `FieldyApiError`, `SlackApiError` or a Supabase error. None of them logs a task title, a summary, a payload or a `response_url`.

- [ ] **Step 4: Commit**

```bash
git add docs/SLACK-ROLLOUT.md
git commit -m "docs: Fieldy checklist rollout (Slack, Trinity Tasks connector, OpenAI)"
```
