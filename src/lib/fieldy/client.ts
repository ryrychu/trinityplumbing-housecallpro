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

export const FIELDY_API_BASE = "https://api.fieldy.ai/api/public/v2";

const TIMEOUT_MS = 10_000;
// Today /tasks returns everything in one response. If Fieldy adds paging, a
// runaway cursor must fail loudly rather than burn the 100-a-minute limit.
const MAX_PAGES = 10;

/** Conversations read per call, at most. */
export const CONVERSATION_MAX = 20;

export const TASK_STATUSES = ["new", "approved", "completed", "rejected", "skipped", "cancelled", "expired"] as const;
export type FieldyTaskStatus = (typeof TASK_STATUSES)[number];

/** The fields of a Fieldy task this app reads. Nothing else is kept. */
export type FieldyTask = {
  id: string;
  title: string;
  /** Usually one of FieldyTaskStatus; kept as a string so a new value doesn't crash the post. */
  status: string;
  /** Due date, ISO 8601, or null. */
  date: string | null;
  /** When it was marked done, ISO 8601, or null. */
  completionDate: string | null;
};

/** A conversation as this app keeps it: no transcript, quotes, speakers or location. */
export type ConversationSummary = { id: string; title: string | null; summary: string | null; startTime: string };

/** The two changes this app makes to a task. */
export type TaskUpdate = { status: "completed"; completionDate: string } | { status: "approved" };

export class FieldyApiError extends Error {
  constructor(
    readonly code: string,
    readonly op: string = "GET /tasks"
  ) {
    super(`[fieldy] ${op} failed: ${code}`);
    this.name = "FieldyApiError";
  }
}

export function fieldyApiKey(): string | null {
  return process.env.FIELDY_API_KEY || null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** One raw item from the /tasks response, or null if it lacks an id or title. */
export function toTask(raw: unknown): FieldyTask | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const title = str(r.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    status: str(r.status) ?? "",
    date: str(r.date),
    completionDate: str(r.completionDate),
  };
}

/**
 * The cursor for the next page, or null when there is none.
 *
 * ASSUMPTION: /tasks documents no pagination, so today this always returns
 * null. Fieldy's paged endpoints (GET /conversations, GET /transcriptions)
 * take `cursor` and return `nextCursor`, so that is what this follows if
 * /tasks starts paging. If it pages differently, this function and the
 * `cursor` param in listTasks() are the only places to change.
 */
export function nextCursorOf(body: Record<string, unknown>): string | null {
  return str(body.nextCursor);
}

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

/** Every task with one status. Throws FieldyApiError; never returns a partial list. */
export async function listTasks(status: FieldyTaskStatus): Promise<FieldyTask[]> {
  const key = requireKey("GET /tasks");

  const out: FieldyTask[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await getPage(key, status, cursor);
    for (const raw of body.items as unknown[]) {
      const task = toTask(raw);
      if (task) out.push(task);
    }
    cursor = nextCursorOf(body);
    if (!cursor) return out;
  }
  throw new FieldyApiError("too_many_pages");
}

/**
 * Marks a task done (`completed` + completionDate) or open again (`approved`).
 * Null when Fieldy reports success without sending the task back.
 */
export async function updateTask(id: string, update: TaskUpdate): Promise<FieldyTask | null> {
  const op = "PATCH /tasks/{id}";
  const key = requireKey(op);
  const body = await request(key, "PATCH", `/tasks/${encodeURIComponent(id)}`, op, { body: update });
  if (body.success !== true) throw new FieldyApiError("update_failed", op);
  if (body.task === null || body.task === undefined) return null;
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
