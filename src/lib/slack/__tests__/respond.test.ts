import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postEphemeralNote, postToResponseUrl } from "../respond";

const URL_ = "https://hooks.slack.com/commands/T1/2/abc";

describe("postToResponseUrl", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("posts ephemerally so customer data is not left in channel history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await postToResponseUrl(URL_, "*Week ahead* — 9 jobs");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      response_type: "ephemeral",
      replace_original: true,
      text: "*Week ahead* — 9 jobs",
    });
  });

  it("sends Block Kit replies ephemerally too, with their fallback text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await postToResponseUrl(URL_, { text: "Website traffic", blocks: [{ type: "header" }] });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      response_type: "ephemeral",
      replace_original: true,
      text: "Website traffic",
      blocks: [{ type: "header" }],
    });
  });

  it("returns true on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    expect(await postToResponseUrl(URL_, "hi")).toBe(true);
  });

  // Nothing downstream can retry this, so a failure must be swallowed and
  // logged rather than thrown into an already-acknowledged request.
  it("returns false and does not throw when Slack rejects the post", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 400 })));
    expect(await postToResponseUrl(URL_, "hi")).toBe(false);
  });

  it("returns false and does not throw when the request errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await postToResponseUrl(URL_, "hi")).toBe(false);
  });
});

describe("postEphemeralNote", () => {
  it("posts an ephemeral reply that leaves the original message alone", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await postEphemeralNote("https://hooks.slack.com/actions/x", "Only Dave can check these off.")).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      response_type: "ephemeral",
      replace_original: false,
      text: "Only Dave can check these off.",
    });
  });
});
