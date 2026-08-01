import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { renderDigestMock, postSlackMock, slackAlertsEnabledMock } = vi.hoisted(() => ({
  renderDigestMock: vi.fn().mockResolvedValue("*Today — Sat Aug 1* — 1 job"),
  postSlackMock: vi.fn().mockResolvedValue(true),
  slackAlertsEnabledMock: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/notifications/digest", async (importOriginal) => ({
  // Keep the real isDigestKind/DIGEST_LABELS so the validation and labelling
  // under test are the shipped ones, not a mock that agrees with itself.
  ...(await importOriginal<typeof import("@/lib/notifications/digest")>()),
  renderDigest: renderDigestMock,
}));

vi.mock("@/lib/slack/client", () => ({
  postSlack: postSlackMock,
  slackAlertsEnabled: slackAlertsEnabledMock,
}));

import { POST } from "../route";

const TOKEN = "s3cret-admin-token";

function request(body: unknown): Request {
  return new Request("https://example.com/api/admin/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_TRIGGER_TOKEN = TOKEN;
    process.env.SLACK_WEBHOOK_SCHEDULE = "https://hooks.slack.com/services/SCHED";
    renderDigestMock.mockResolvedValue("*Today — Sat Aug 1* — 1 job");
    postSlackMock.mockResolvedValue(true);
    slackAlertsEnabledMock.mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.ADMIN_TRIGGER_TOKEN;
    delete process.env.SLACK_WEBHOOK_SCHEDULE;
  });

  // This route is the only thing between a public URL and the company Slack —
  // the app has no other authentication.
  describe("auth", () => {
    it("rejects a wrong token", async () => {
      const res = await POST(request({ action: "digest", token: "nope", post: true }));
      expect(res.status).toBe(401);
      expect(postSlackMock).not.toHaveBeenCalled();
    });

    it("rejects a missing token", async () => {
      const res = await POST(request({ action: "digest", post: true }));
      expect(res.status).toBe(401);
      expect(postSlackMock).not.toHaveBeenCalled();
    });

    // An unset variable must never mean "no auth required".
    it("refuses to run when ADMIN_TRIGGER_TOKEN is unset", async () => {
      delete process.env.ADMIN_TRIGGER_TOKEN;
      const res = await POST(request({ action: "digest", token: "", post: true }));
      expect(res.status).toBe(503);
      expect(postSlackMock).not.toHaveBeenCalled();
    });

    // Guards the sha256-then-compare in tokenMatches: timingSafeEqual throws on
    // a length mismatch, which without the hash would 500 instead of 401 and
    // leak the expected token's length.
    it("rejects a token of a different length without throwing", async () => {
      const res = await POST(request({ action: "digest", token: "x", post: true }));
      expect(res.status).toBe(401);
    });
  });

  describe("preview", () => {
    // Posting to a channel several people read should be opt-in, not what you
    // get by forgetting a flag.
    it("does not post when `post` is omitted", async () => {
      const res = await POST(request({ action: "digest", token: TOKEN }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ posted: false, text: "*Today — Sat Aug 1* — 1 job" });
      expect(postSlackMock).not.toHaveBeenCalled();
    });

    it("returns the exact text Slack would receive", async () => {
      const res = await POST(request({ action: "week", token: TOKEN }));
      const body = await res.json();

      expect(renderDigestMock).toHaveBeenCalledWith("week", expect.any(Date), null);
      expect(body.text).toBe("*Today — Sat Aug 1* — 1 job");
    });
  });

  describe("posting", () => {
    it("posts to the schedule webhook when post is true", async () => {
      const res = await POST(request({ action: "digest", token: TOKEN, post: true }));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, posted: true });
      expect(postSlackMock).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/SCHED",
        "*Today — Sat Aug 1* — 1 job"
      );
    });

    // postSlack swallows failures and returns false, which is right for the
    // cron and wrong for a person watching a button.
    it("surfaces a rejected Slack post as an error", async () => {
      postSlackMock.mockResolvedValue(false);

      const res = await POST(request({ action: "digest", token: TOKEN, post: true }));

      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/Slack/);
    });

    it("reports the kill switch instead of silently doing nothing", async () => {
      slackAlertsEnabledMock.mockReturnValue(false);

      const res = await POST(request({ action: "digest", token: TOKEN, post: true }));

      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/SLACK_ALERTS_ENABLED/);
      expect(postSlackMock).not.toHaveBeenCalled();
    });

    it("surfaces a render failure rather than posting a broken message", async () => {
      renderDigestMock.mockRejectedValue(new Error("supabase unreachable"));

      const res = await POST(request({ action: "digest", token: TOKEN, post: true }));

      expect(res.status).toBe(500);
      expect((await res.json()).error).toMatch(/supabase unreachable/);
      expect(postSlackMock).not.toHaveBeenCalled();
    });
  });

  describe("input", () => {
    it("rejects an unknown action", async () => {
      const res = await POST(request({ action: "daily", token: TOKEN, post: true }));
      expect(res.status).toBe(400);
      expect(postSlackMock).not.toHaveBeenCalled();
    });

    it("rejects a non-JSON body", async () => {
      const res = await POST(
        new Request("https://example.com/api/admin/trigger", { method: "POST", body: "not json" })
      );
      expect(res.status).toBe(400);
    });
  });
});
