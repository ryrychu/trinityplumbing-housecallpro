import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listTasks, toTask, nextCursorOf, FieldyApiError, FIELDY_API_BASE } from "../client";

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
