import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

vi.mock("@/lib/sync/syncService", () => ({
  syncOneRecord: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "../route";
import { syncOneRecord } from "@/lib/sync/syncService";

function signedRequest(body: object, secret: string) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return new Request("https://example.com/api/webhooks/housecall", {
    method: "POST",
    headers: { "X-HousecallPro-Signature": signature, "Content-Type": "application/json" },
    body: raw,
  });
}

describe("POST /api/webhooks/housecall", () => {
  beforeEach(() => {
    process.env.HOUSECALL_WEBHOOK_SECRET = "test-secret";
    vi.clearAllMocks();
  });

  it("accepts a validly signed event and calls syncOneRecord", async () => {
    const req = signedRequest(
      { event: "job.updated", resource: "jobs", data: { id: "j1" } },
      "test-secret"
    );

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(syncOneRecord).toHaveBeenCalledWith("jobs", "job.updated", { id: "j1" });
  });

  it("rejects a request with an invalid signature", async () => {
    const req = signedRequest(
      { event: "job.updated", resource: "jobs", data: { id: "j1" } },
      "wrong-secret"
    );

    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(syncOneRecord).not.toHaveBeenCalled();
  });
});
