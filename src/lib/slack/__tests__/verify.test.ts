import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "../verify";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BODY = "command=%2Ftrinity&text=week&response_url=https%3A%2F%2Fhooks.slack.com%2Fx";
const NOW_MS = 1_754_640_000_000; // 2026-08-08T08:00:00Z
const TS = String(Math.floor(NOW_MS / 1000));

// Built here from Slack's documented base string rather than by calling the
// implementation, so a change to that format breaks this test instead of
// silently agreeing with itself.
function sign(body: string, ts: string, secret = SECRET): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
}

const base = {
  rawBody: BODY,
  timestamp: TS,
  signature: sign(BODY, TS),
  signingSecret: SECRET,
  nowMs: NOW_MS,
};

describe("verifySlackSignature", () => {
  it("accepts a correctly signed request", () => {
    expect(verifySlackSignature(base)).toBe(true);
  });

  // The signature covers the raw body. Any re-serialization changes the bytes.
  it("rejects a tampered body", () => {
    expect(verifySlackSignature({ ...base, rawBody: BODY + "&evil=1" })).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifySlackSignature({ ...base, signature: sign(BODY, TS, "wrong-secret") })).toBe(false);
  });

  // Replay guard: a captured request must not stay valid indefinitely.
  it("rejects a timestamp older than five minutes", () => {
    const oldTs = String(Math.floor(NOW_MS / 1000) - 301);
    expect(
      verifySlackSignature({ ...base, timestamp: oldTs, signature: sign(BODY, oldTs) })
    ).toBe(false);
  });

  it("rejects a timestamp more than five minutes in the future", () => {
    const futureTs = String(Math.floor(NOW_MS / 1000) + 301);
    expect(
      verifySlackSignature({ ...base, timestamp: futureTs, signature: sign(BODY, futureTs) })
    ).toBe(false);
  });

  it("accepts a timestamp just inside the window", () => {
    const ts = String(Math.floor(NOW_MS / 1000) - 299);
    expect(verifySlackSignature({ ...base, timestamp: ts, signature: sign(BODY, ts) })).toBe(true);
  });

  it("rejects a missing signature", () => {
    expect(verifySlackSignature({ ...base, signature: null })).toBe(false);
  });

  it("rejects a missing timestamp", () => {
    expect(verifySlackSignature({ ...base, timestamp: null })).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verifySlackSignature({ ...base, timestamp: "not-a-number" })).toBe(false);
  });

  // An unset secret must never mean "no verification required".
  it("rejects when the signing secret is unset", () => {
    expect(verifySlackSignature({ ...base, signingSecret: undefined })).toBe(false);
  });

  // Guards the hash-then-compare: timingSafeEqual throws on a length mismatch,
  // which would 500 instead of returning false and leak the expected length.
  it("rejects a short signature without throwing", () => {
    expect(verifySlackSignature({ ...base, signature: "v0=aa" })).toBe(false);
  });
});
