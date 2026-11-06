import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchChannelHistory, postMessage } from "../web";

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

  it("throws when rate limited", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "ratelimited" }, 429, { "Retry-After": "30" }));
    await expect(fetchChannelHistory(TOKEN, "C_DECLINED", 0, 1)).rejects.toThrow(/rate limited/);
  });

  it("throws on an HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
    await expect(fetchChannelHistory(TOKEN, "C_DECLINED", 0, 1)).rejects.toThrow(/HTTP 502/);
  });

  it("gives up on a cursor that never ends", async () => {
    fetchMock.mockImplementation(async () => json({ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: "again" } }));
    await expect(fetchChannelHistory(TOKEN, "C_DECLINED", 0, 1)).rejects.toThrow(/pages/);
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
