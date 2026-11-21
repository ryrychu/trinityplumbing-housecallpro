import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deleteMessage, fetchChannelHistory, postMessage, updateMessage, SlackApiError } from "../web";

const TOKEN = "xoxb-test-not-real";
const fetchMock = vi.fn();

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchChannelHistory", () => {
  it("follows the cursor until has_more is false", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ ok: true, messages: [{ ts: "2.0" }, { ts: "1.0" }], has_more: true, response_metadata: { next_cursor: "page2" } })
      )
      .mockResolvedValueOnce(json({ ok: true, messages: [{ ts: "0.5" }], has_more: false, response_metadata: { next_cursor: "" } }));

    const messages = await fetchChannelHistory(TOKEN, "C_DECLINED", 100, 200);

    expect(messages.map((m) => m.ts)).toEqual(["2.0", "1.0", "0.5"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/conversations.history");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const first = new URLSearchParams(init.body);
    expect(first.get("channel")).toBe("C_DECLINED");
    expect(first.get("oldest")).toBe("100");
    expect(first.get("latest")).toBe("200");
    expect(first.get("limit")).toBe("200");
    expect(first.get("cursor")).toBeNull();
    expect(new URLSearchParams(fetchMock.mock.calls[1][1].body).get("cursor")).toBe("page2");
  });

  it("throws on a Slack error, naming only the error code", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "not_in_channel" }));
    const err = await fetchChannelHistory(TOKEN, "C_DECLINED", 0, 1).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("not_in_channel");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("carries Slack's error code and the missing scope as data", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "missing_scope", needed: "groups:history", provided: "chat:write" }));
    const err = await fetchChannelHistory(TOKEN, "C_DECLINED", 0, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err).toMatchObject({ code: "missing_scope", needed: "groups:history" });
  });

  it("throws when rate limited", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "ratelimited" }, 429, { "Retry-After": "30" }));
    await expect(fetchChannelHistory(TOKEN, "C_DECLINED", 0, 1)).rejects.toThrow(/ratelimited/);
  });

  it("throws on an HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
    await expect(fetchChannelHistory(TOKEN, "C_DECLINED", 0, 1)).rejects.toThrow(/http_502/);
  });

  it("gives up on a cursor that never ends", async () => {
    fetchMock.mockImplementation(async () => json({ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: "again" } }));
    await expect(fetchChannelHistory(TOKEN, "C_DECLINED", 0, 1)).rejects.toThrow(/too_many_pages/);
  });
});

describe("postMessage", () => {
  it("posts JSON to chat.postMessage", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await postMessage(TOKEN, "C_DECLINED", "hello");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse(init.body)).toMatchObject({ channel: "C_DECLINED", text: "hello" });
  });

  it("throws when Slack refuses", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "channel_not_found" }));
    await expect(postMessage(TOKEN, "C_DECLINED", "hello")).rejects.toThrow(/channel_not_found/);
  });
});

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

describe("deleteMessage", () => {
  it("calls chat.delete with the channel and ts", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await deleteMessage(TOKEN, "C1", "171.6");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.delete");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({ channel: "C1", ts: "171.6" });
  });

  it("throws on a Slack error", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "message_not_found" }));
    await expect(deleteMessage(TOKEN, "C1", "1")).rejects.toThrow(/chat\.delete failed: message_not_found/);
  });
});
