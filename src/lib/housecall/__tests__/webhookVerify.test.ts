import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifyWebhookSignature } from "../webhookVerify";

// Housecall Pro signs `${api-timestamp}.${rawBody}` with HMAC-SHA256 (secret as
// UTF-8 bytes), hex-encoded — derived offline from a live delivery on 2026-07-24.
describe("verifyWebhookSignature", () => {
  const secret = "test-webhook-secret";
  const timestamp = "1784871495";
  const body = JSON.stringify({ event: "customer.updated", customer: { id: "cus_1" } });

  function sign(ts: string, rawBody: string, withSecret: string) {
    return crypto.createHmac("sha256", withSecret).update(`${ts}.${rawBody}`).digest("hex");
  }

  it("accepts a signature over `${timestamp}.${body}` with the correct secret", () => {
    const signature = sign(timestamp, body, secret);
    expect(verifyWebhookSignature(body, signature, secret, timestamp)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const badSignature = sign(timestamp, body, "wrong-secret");
    expect(verifyWebhookSignature(body, badSignature, secret, timestamp)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const signature = sign(timestamp, body, secret);
    const tamperedBody = JSON.stringify({ event: "customer.updated", customer: { id: "cus_2" } });
    expect(verifyWebhookSignature(tamperedBody, signature, secret, timestamp)).toBe(false);
  });

  // The timestamp is part of the signed message, so a signature is bound to it:
  // replaying the same body under a different timestamp must fail.
  it("rejects a signature verified against a different timestamp", () => {
    const signature = sign(timestamp, body, secret);
    expect(verifyWebhookSignature(body, signature, secret, "1784871999")).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyWebhookSignature(body, "", secret, timestamp)).toBe(false);
  });
});
