import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifyWebhookSignature } from "../webhookVerify";

describe("verifyWebhookSignature", () => {
  const secret = "test-webhook-secret";
  const body = JSON.stringify({ event: "job.updated", id: "j1" });

  it("accepts a signature computed with the correct secret", () => {
    const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const badSignature = crypto.createHmac("sha256", "wrong-secret").update(body).digest("hex");
    expect(verifyWebhookSignature(body, badSignature, secret)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const tamperedBody = JSON.stringify({ event: "job.updated", id: "j2" });
    expect(verifyWebhookSignature(tamperedBody, signature, secret)).toBe(false);
  });
});
