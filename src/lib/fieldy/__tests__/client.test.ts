import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listTasks, toTask, nextCursorOf, FieldyApiError, FIELDY_API_BASE, updateTask, createTask, listConversations, CONVERSATION_MAX } from "../client";

const KEY = "sk-fieldy-test-not-real";
const fetchMock = vi.fn();

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.FIELDY_API_KEY = KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FIELDY_API_KEY;
});

describe("listTasks", () => {
  it("GETs /tasks for one status with the bearer key", async () => {
    fetchMock.mockResolvedValueOnce(ok({ items: [{ id: "t1", title: "Call back", status: "new" }] }));

    const tasks = await listTasks("new");

    expect(tasks).toEqual([
      { id: "t1", title: "Call back", status: "new", date: null, completionDate: null },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${FIELDY_API_BASE}/tasks?status=new`);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.body).toBeUndefined();
  });

  it("follows nextCursor if Fieldy ever pages /tasks, passing it back as cursor", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ items: [{ id: "a", title: "A", status: "completed" }], nextCursor: "c2" }))
      .mockResolvedValueOnce(ok({ items: [{ id: "b", title: "B", status: "completed" }], nextCursor: null }));

    const tasks = await listTasks("completed");

    expect(tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(fetchMock.mock.calls[1][0]).toBe(`${FIELDY_API_BASE}/tasks?status=completed&cursor=c2`);
  });

  it("stops at the page cap instead of looping forever", async () => {
    fetchMock.mockImplementation(async () => ok({ items: [], nextCursor: "again" }));
    await expect(listTasks("new")).rejects.toMatchObject({ code: "too_many_pages" });
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("refuses to call Fieldy without a key", async () => {
    delete process.env.FIELDY_API_KEY;
    await expect(listTasks("new")).rejects.toMatchObject({ code: "key_not_set" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 503])("throws the HTTP status only on %i, never the body or the key", async (status) => {
    fetchMock.mockResolvedValueOnce(
      new Response(`secret customer detail ${KEY}`, { status })
    );
    const err = await listTasks("new").catch((e) => e);
    expect(err).toBeInstanceOf(FieldyApiError);
    expect(err.code).toBe(`http_${status}`);
    expect(err.message).toBe(`[fieldy] GET /tasks failed: http_${status}`);
    expect(err.message).not.toContain("secret");
    expect(err.message).not.toContain(KEY);
  });

  it("reports a timeout or network failure without the underlying message", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error(`aborted ${KEY}`), { name: "TimeoutError" }));
    await expect(listTasks("new")).rejects.toMatchObject({ code: "timeout" });

    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${KEY}`));
    const err = await listTasks("new").catch((e) => e);
    expect(err.code).toBe("network");
    expect(err.message).not.toContain(KEY);
  });

  it.each([
    ["not JSON", new Response("<html>", { status: 200 })],
    ["no items array", ok({ tasks: [] })],
  ])("throws bad_response on %s", async (_label, res) => {
    fetchMock.mockResolvedValueOnce(res);
    await expect(listTasks("new")).rejects.toMatchObject({ code: "bad_response" });
  });

  it("drops rows that lack an id or title rather than failing the whole list", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ items: [{ id: "ok", title: "Fine", status: "new" }, { id: "x" }, null, { title: "no id", status: "new" }] })
    );
    expect((await listTasks("new")).map((t) => t.id)).toEqual(["ok"]);
  });
});

describe("toTask", () => {
  it("maps the documented fields and nulls the missing optional ones", () => {
    expect(
      toTask({
        id: "t9",
        title: "Order PRV",
        status: "completed",
        date: "2026-11-10T14:00:00.000Z",
        memoryId: "m1",
        completionDate: "2026-11-13T20:15:00.000Z",
        cancellationDate: null,
      })
    ).toEqual({
      id: "t9",
      title: "Order PRV",
      status: "completed",
      date: "2026-11-10T14:00:00.000Z",
      completionDate: "2026-11-13T20:15:00.000Z",
    });
  });

  it("treats non-string dates as missing", () => {
    expect(toTask({ id: "a", title: "A", status: "new", date: 12345, completionDate: {} })).toMatchObject({
      date: null,
      completionDate: null,
    });
  });
});

describe("nextCursorOf", () => {
  it("reads a non-empty string nextCursor and nothing else", () => {
    expect(nextCursorOf({ items: [], nextCursor: "abc" })).toBe("abc");
    expect(nextCursorOf({ items: [] })).toBeNull();
    expect(nextCursorOf({ items: [], nextCursor: "" })).toBeNull();
    expect(nextCursorOf({ items: [], nextCursor: 3 })).toBeNull();
  });
});

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

  it("accepts success: true without the task", async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: true, task: null }));
    await expect(updateTask("t1", { status: "approved" })).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(ok({ success: true }));
    await expect(updateTask("t1", { status: "approved" })).resolves.toBeNull();
  });

  it("still throws bad_response for a malformed task", async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: true, task: { title: "no id" } }));
    await expect(updateTask("t1", { status: "approved" })).rejects.toMatchObject({ code: "bad_response" });
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
