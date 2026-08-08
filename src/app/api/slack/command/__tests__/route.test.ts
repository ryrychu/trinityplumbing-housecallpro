import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

const { renderCommandMock, postMock, waitUntilMock } = vi.hoisted(() => ({
  renderCommandMock: vi.fn(),
  postMock: vi.fn(),
  // The real waitUntil defers work past the response. Running it inline lets
  // the tests assert on what the deferred work did.
  waitUntilMock: vi.fn((p: Promise<unknown>) => p),
}));

vi.mock("@/lib/slack/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/slack/commands")>()),
  renderCommand: renderCommandMock,
}));
vi.mock("@/lib/slack/respond", () => ({ postToResponseUrl: postMock }));
vi.mock("@vercel/functions", () => ({ waitUntil: waitUntilMock }));

import { POST } from "../route";

const SECRET = "test-signing-secret";
const RESPONSE_URL = "https://hooks.slack.com/commands/T1/2/abc";

function slackRequest(
  text: string,
  opts: { secret?: string; tsOffsetSec?: number; retry?: boolean } = {}
): Request {
  const body = new URLSearchParams({
    command: "/trinity",
    text,
    user_id: "U123",
    response_url: RESPONSE_URL,
  }).toString();
  const ts = String(Math.floor(Date.now() / 1000) + (opts.tsOffsetSec ?? 0));
  const sig =
    "v0=" + createHmac("sha256", opts.secret ?? SECRET).update(`v0:${ts}:${body}`).digest("hex");

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "x-slack-signature": sig,
    "x-slack-request-timestamp": ts,
  };
  if (opts.retry) headers["x-slack-retry-num"] = "1";

  return new Request("https://ops.trinity.plumbing/api/slack/command", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/slack/command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.SLACK_COMMANDS_ENABLED = "true";
    renderCommandMock.mockResolvedValue("*Week ahead* — 9 jobs");
    postMock.mockResolvedValue(true);
    waitUntilMock.mockImplementation((p: Promise<unknown>) => p);
  });

  afterEach(() => {
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_COMMANDS_ENABLED;
  });

  describe("auth", () => {
    it("rejects a request signed with the wrong secret", async () => {
      const res = await POST(slackRequest("week", { secret: "not-the-secret" }));
      expect(res.status).toBe(401);
      expect(renderCommandMock).not.toHaveBeenCalled();
      expect(postMock).not.toHaveBeenCalled();
    });

    it("rejects a stale request", async () => {
      const res = await POST(slackRequest("week", { tsOffsetSec: -600 }));
      expect(res.status).toBe(401);
      expect(renderCommandMock).not.toHaveBeenCalled();
    });

    // An unset secret must never mean "no verification required".
    it("refuses to run when SLACK_SIGNING_SECRET is unset", async () => {
      delete process.env.SLACK_SIGNING_SECRET;
      const res = await POST(slackRequest("week"));
      expect(res.status).toBe(503);
      expect(renderCommandMock).not.toHaveBeenCalled();
    });
  });

  describe("kill switch", () => {
    it("does nothing when SLACK_COMMANDS_ENABLED is unset", async () => {
      delete process.env.SLACK_COMMANDS_ENABLED;
      const res = await POST(slackRequest("week"));
      expect(res.status).toBe(200);
      expect((await res.json()).text).toMatch(/not enabled/i);
      expect(renderCommandMock).not.toHaveBeenCalled();
    });

    it("treats any value other than the exact string 'true' as off", async () => {
      process.env.SLACK_COMMANDS_ENABLED = "TRUE";
      const res = await POST(slackRequest("week"));
      expect((await res.json()).text).toMatch(/not enabled/i);
      expect(renderCommandMock).not.toHaveBeenCalled();
    });
  });

  describe("acknowledgement", () => {
    it("acknowledges 200 with an ephemeral placeholder", async () => {
      const res = await POST(slackRequest("week"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ response_type: "ephemeral" });
    });

    it("defers the real work rather than doing it before responding", async () => {
      await POST(slackRequest("week"));
      expect(waitUntilMock).toHaveBeenCalledTimes(1);
    });

    it("posts the rendered answer to response_url", async () => {
      await POST(slackRequest("week"));
      expect(postMock).toHaveBeenCalledWith(RESPONSE_URL, "*Week ahead* — 9 jobs");
    });

    it("passes the parsed command through to renderCommand", async () => {
      await POST(slackRequest("next week"));
      expect(renderCommandMock).toHaveBeenCalledWith({ kind: "nextWeek" }, expect.any(Date));
    });
  });

  // Slack retries on timeout or a non-2xx. Without this guard the same schedule
  // is posted three times.
  describe("retries", () => {
    it("does no work when Slack marks the request as a retry", async () => {
      const res = await POST(slackRequest("week", { retry: true }));
      expect(res.status).toBe(200);
      expect(renderCommandMock).not.toHaveBeenCalled();
      expect(postMock).not.toHaveBeenCalled();
    });
  });

  describe("failures", () => {
    // A raw Supabase error can carry customer rows. It must never reach Slack.
    it("posts a plain apology and never the raw error", async () => {
      renderCommandMock.mockRejectedValue(new Error("customers query failed: row Devon Robinson"));

      await POST(slackRequest("week"));

      expect(postMock).toHaveBeenCalledTimes(1);
      const [, text] = postMock.mock.calls[0];
      expect(text).not.toContain("Devon Robinson");
      expect(text).toMatch(/couldn't/i);
    });
  });
});
