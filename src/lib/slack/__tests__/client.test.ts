import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postSlack, slackAlertsEnabled } from "../client";

describe("slackAlertsEnabled", () => {
  afterEach(() => {
    delete process.env.SLACK_ALERTS_ENABLED;
  });

  it("is false when unset — alerts are off by default", () => {
    expect(slackAlertsEnabled()).toBe(false);
  });

  it("is false for any value other than 'true'", () => {
    process.env.SLACK_ALERTS_ENABLED = "1";
    expect(slackAlertsEnabled()).toBe(false);
  });

  it("is true only for 'true'", () => {
    process.env.SLACK_ALERTS_ENABLED = "true";
    expect(slackAlertsEnabled()).toBe(true);
  });
});

describe("postSlack", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the text as JSON to the webhook url", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postSlack("https://hooks.slack.com/services/XXX", "hello");

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/XXX");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ text: "hello" });
  });

  it("skips without calling fetch when the url is undefined", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await postSlack(undefined, "hello")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns false instead of throwing when Slack responds non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" })
    );
    expect(await postSlack("https://hooks.slack.com/services/XXX", "hello")).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns false instead of throwing when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await postSlack("https://hooks.slack.com/services/XXX", "hello")).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });
});
