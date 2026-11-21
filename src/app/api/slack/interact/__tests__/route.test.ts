// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

const { tapMock, waitUntilMock } = vi.hoisted(() => ({
  tapMock: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  waitUntilMock: vi.fn((p: Promise<unknown>) => p),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: waitUntilMock }));
vi.mock("@/lib/tasks/interact", async (orig) => ({
  ...(await orig<typeof import("@/lib/tasks/interact")>()),
  handleChecklistTap: tapMock,
}));
// Every export the real modules import from deps.ts, so none is missing from the mock.
vi.mock("@/lib/tasks/deps", () => ({
  liveChecklistDeps: () => ({}),
  checklistConfigMissing: () => null,
  liveFieldyPort: () => ({}),
  liveOrganizer: () => async () => null,
}));

import { POST } from "../route";

const SECRET = "test-signing-secret";

function signedRequest(payload: unknown, opts: { ts?: number; secret?: string } = {}) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = "v0=" + createHmac("sha256", opts.secret ?? SECRET).update(`v0:${ts}:${body}`).digest("hex");
  return new Request("https://ops.example.com/api/slack/interact", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body,
  });
}

const TAP = {
  type: "block_actions",
  user: { id: "U_DAVE" },
  actions: [{ action_id: "fieldy_cb:1:0", selected_options: [{ value: "t1" }] }],
};

beforeEach(() => {
  tapMock.mockClear();
  vi.stubEnv("SLACK_FIELDY_ENABLED", "true");
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  vi.stubEnv("SLACK_FIELDY_ALLOWED_USERS", "U_DAVE, U_OTHER");
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/slack/interact", () => {
  it("hands a signed checklist tap to handleChecklistTap and answers 200 at once", async () => {
    const res = await POST(signedRequest(TAP));
    expect(res.status).toBe(200);
    expect(tapMock).toHaveBeenCalledTimes(1);
    expect(tapMock.mock.calls[0][0]).toEqual(TAP);
    expect(tapMock.mock.calls[0][2]).toMatchObject({ allowedUsers: ["U_DAVE", "U_OTHER"] });
  });

  it("does nothing while SLACK_FIELDY_ENABLED is off", async () => {
    vi.stubEnv("SLACK_FIELDY_ENABLED", "TRUE");
    const res = await POST(signedRequest(TAP));
    expect(res.status).toBe(200);
    expect(tapMock).not.toHaveBeenCalled();
  });

  it("refuses with 503 when the signing secret isn't set", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "");
    expect((await POST(signedRequest(TAP))).status).toBe(503);
  });

  it.each([
    ["a bad signature", { secret: "wrong" }],
    ["an old timestamp", { ts: Math.floor(Date.now() / 1000) - 600 }],
  ])("rejects %s with 401", async (_label, opts) => {
    expect((await POST(signedRequest(TAP, opts))).status).toBe(401);
    expect(tapMock).not.toHaveBeenCalled();
  });

  it("ignores payloads that aren't checklist taps", async () => {
    const res = await POST(signedRequest({ type: "block_actions", actions: [{ action_id: "other" }] }));
    expect(res.status).toBe(200);
    expect(tapMock).not.toHaveBeenCalled();
  });
});
