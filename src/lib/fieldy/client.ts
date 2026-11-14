// Fieldy Public API: read-only access to Dave's tasks. GET only; this app never
// creates, edits or deletes anything in Fieldy.
//
// Checked 2026-11-14 against the OpenAPI spec behind the API reference at
// https://api.fieldy.ai/docs (OpenAPI "Fieldy Public API", embedded in that
// page) and https://fieldyai.github.io/docs/public-api.md:
//   - Base URL:   https://api.fieldy.ai/api/public/v2
//   - Auth:       Authorization: Bearer sk-fieldy-…  (key from the Fieldy app,
//                 Settings → Developer Settings)
//   - GET /tasks?status=<status>: `status` is required and takes ONE of
//                 new | approved | completed | rejected | skipped | cancelled | expired
//   - 200 body:   { items: [{ id, title, status, date?, memoryId?,
//                 completionDate?, cancellationDate? }] }; the optional fields
//                 are string or null. `date` is the due date; the dates are
//                 ISO 8601 per the PATCH /tasks/{id} schema.
//   - Rate limit: 100 requests per 60 seconds per key; 429 beyond that.
//
// Not in the docs for /tasks: any date filter (so we fetch by status and filter
// here) and any pagination. See nextCursorOf() for how paging is handled.
//
// Errors carry a short code ("http_401", "timeout" …), never the response
// body or the key: the body can hold task text, which can hold customer details.

export const FIELDY_API_BASE = "https://api.fieldy.ai/api/public/v2";

const TIMEOUT_MS = 10_000;
// Today /tasks returns everything in one response. If Fieldy adds paging, a
// runaway cursor must fail loudly rather than burn the 100-a-minute limit.
const MAX_PAGES = 10;

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

export class FieldyApiError extends Error {
  constructor(readonly code: string) {
    super(`[fieldy] GET /tasks failed: ${code}`);
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

async function getPage(key: string, status: FieldyTaskStatus, cursor: string | null): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ status });
  if (cursor) params.set("cursor", cursor);

  let res: Response;
  try {
    res = await fetch(`${FIELDY_API_BASE}/tasks?${params}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // The underlying message is dropped on purpose; see the module note.
    throw new FieldyApiError(err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network");
  }

  if (!res.ok) throw new FieldyApiError(`http_${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new FieldyApiError("bad_response");
  }
  if (!body || typeof body !== "object" || !Array.isArray((body as Record<string, unknown>).items)) {
    throw new FieldyApiError("bad_response");
  }
  return body as Record<string, unknown>;
}

/** Every task with one status. Throws FieldyApiError; never returns a partial list. */
export async function listTasks(status: FieldyTaskStatus): Promise<FieldyTask[]> {
  const key = fieldyApiKey();
  if (!key) throw new FieldyApiError("key_not_set");

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
