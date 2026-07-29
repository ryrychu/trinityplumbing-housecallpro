import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

vi.mock("@/lib/sync/syncService", () => ({
  syncOneRecord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseServerClient: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/notifications/dispatch", () => ({
  notifyApprovedEstimates: vi.fn().mockResolvedValue(0),
}));

import { POST } from "../route";
import { syncOneRecord } from "@/lib/sync/syncService";
import { notifyApprovedEstimates } from "@/lib/notifications/dispatch";
import { getSupabaseServerClient } from "@/lib/supabase/client";

// A Housecall Pro delivery is `{ event, event_occurred_at, company_id, <typeKey> }`
// where <typeKey> is the singular resource name (e.g. "customer") and holds the
// FULL record — confirmed from a live 2026-07-24 capture. There is no `resource`
// field and no `data` field. HCP signs `${api-timestamp}.${rawBody}` with
// HMAC-SHA256 (secret as UTF-8), hex-encoded, in the `api-signature` header.
const TS = "1784871495";

function customerEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    event: "customer.updated",
    event_occurred_at: "2026-07-24T05:38:14Z",
    company_id: "233b75f9-4b4f-4a83-b21b-c1ed9e571daa",
    customer: { id: "cus_1", first_name: "A", tags: [], addresses: [], attachments: [] },
    ...overrides,
  };
}

function sign(ts: string, rawBody: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
}

function signedRequest(body: object, secret: string, headerName = "api-signature") {
  const raw = JSON.stringify(body);
  return new Request("https://example.com/api/webhooks/housecall", {
    method: "POST",
    headers: {
      [headerName]: sign(TS, raw, secret),
      "api-timestamp": TS,
      "Content-Type": "application/json",
    },
    body: raw,
  });
}

describe("POST /api/webhooks/housecall", () => {
  beforeEach(() => {
    process.env.HOUSECALL_WEBHOOK_SECRET = "test-secret";
    vi.clearAllMocks();
  });

  it("syncs a validly signed customer event using the record under payload.customer", async () => {
    const env = customerEnvelope();
    const req = signedRequest(env, "test-secret");

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(syncOneRecord).toHaveBeenCalledWith(
      "customer",
      "customer.updated",
      env.customer,
      "updated"
    );
  });

  it("derives the resource and record key from the event name for a job event", async () => {
    const env = {
      event: "job.created",
      event_occurred_at: "2026-07-24T05:38:14Z",
      company_id: "co_1",
      job: { id: "job_1", work_status: "scheduled" },
    };
    const req = signedRequest(env, "test-secret");

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(syncOneRecord).toHaveBeenCalledWith("job", "job.created", env.job, "created");
  });

  it("rejects a request with an invalid signature", async () => {
    const req = signedRequest(customerEnvelope(), "wrong-secret");

    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(syncOneRecord).not.toHaveBeenCalled();
  });

  it("returns 400 for a validly signed body that is not JSON", async () => {
    const raw = "this is not json";
    const req = new Request("https://example.com/api/webhooks/housecall", {
      method: "POST",
      headers: { "api-signature": sign(TS, raw, "test-secret"), "api-timestamp": TS },
      body: raw,
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(syncOneRecord).not.toHaveBeenCalled();
  });

  // The bug this whole change fixes: a real event carries neither `resource` nor
  // `data`, so the old handshake gate (both absent → 200 without syncing)
  // swallowed every delivery. The gate is now `event == null`, so a signed event
  // whose named record key is missing must fail loudly with 400, not pass as a
  // handshake.
  it("returns 400 for a signed event whose named record is absent", async () => {
    const req = signedRequest(
      {
        event: "customer.updated",
        event_occurred_at: "2026-07-24T05:38:14Z",
        company_id: "co_1",
      },
      "test-secret"
    );

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(syncOneRecord).not.toHaveBeenCalled();
  });

  // Housecall Pro will not save a webhook URL unless a test POST of {"foo":"bar"}
  // returns 2xx. It arrives unsigned and has no `event`, so it must succeed
  // without verification and without syncing.
  it("answers the HCP URL-validation handshake with 200 without syncing", async () => {
    const req = new Request("https://example.com/api/webhooks/housecall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handshake: true });
    expect(syncOneRecord).not.toHaveBeenCalled();
  });

  // Regression guard: HCP signs with `api-signature`; the legacy
  // `X-HousecallPro-Signature` is retained only as a fallback.
  it("verifies a signature supplied in the api-signature header", async () => {
    const env = customerEnvelope();
    const req = signedRequest(env, "test-secret", "api-signature");

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(syncOneRecord).toHaveBeenCalledWith(
      "customer",
      "customer.updated",
      env.customer,
      "updated"
    );
  });

  it("still verifies a signature supplied in the legacy X-HousecallPro-Signature header", async () => {
    const env = customerEnvelope();
    const req = signedRequest(env, "test-secret", "X-HousecallPro-Signature");

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(syncOneRecord).toHaveBeenCalledWith(
      "customer",
      "customer.updated",
      env.customer,
      "updated"
    );
  });

  it("still rejects an event whose api-signature is wrong", async () => {
    const raw = JSON.stringify(customerEnvelope());
    const req = new Request("https://example.com/api/webhooks/housecall", {
      method: "POST",
      headers: {
        "api-signature": "deadbeef",
        "api-timestamp": TS,
        "Content-Type": "application/json",
      },
      body: raw,
    });

    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(syncOneRecord).not.toHaveBeenCalled();
  });

  it("passes action 'deleted' through for a delete event", async () => {
    const env = customerEnvelope({ event: "customer.deleted", customer: { id: "cus_1" } });
    const req = signedRequest(env, "test-secret");

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(syncOneRecord).toHaveBeenCalledWith(
      "customer",
      "customer.deleted",
      env.customer,
      "deleted"
    );
  });

  it("acknowledges with 200 (not 500) and logs when the sync fails downstream", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(syncOneRecord).mockRejectedValueOnce(new Error("FK violation"));

    const req = signedRequest(customerEnvelope({ event: "customer.created" }), "test-secret");

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(syncOneRecord).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // Estimates are the one notification class HCP delivers by webhook (the
  // instant path); the cron re-checks the same records as a safety net.
  it("notifies on an approved estimate option after a successful sync", async () => {
    const env = {
      event: "estimate.updated",
      event_occurred_at: "2026-07-24T05:38:14Z",
      company_id: "co_1",
      estimate: {
        id: "est_1",
        customer: { first_name: "R.", last_name: "Hoffman" },
        options: [{ id: "opt_b", approval_status: "approved", total_amount: 250000 }],
      },
    };
    const req = signedRequest(env, "test-secret");

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(notifyApprovedEstimates).toHaveBeenCalledOnce();
    expect(vi.mocked(notifyApprovedEstimates).mock.calls[0][1]).toEqual([
      expect.objectContaining({ id: "est_1" }),
    ]);
  });

  // Pins rule 1: announcing an approval we failed to persist would put Slack
  // ahead of the database, so a sync failure must suppress the notification.
  it("does not notify when the sync throws", async () => {
    vi.mocked(syncOneRecord).mockRejectedValueOnce(new Error("db down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const env = {
      event: "estimate.updated",
      event_occurred_at: "2026-07-24T05:38:14Z",
      company_id: "co_1",
      estimate: { id: "est_1" },
    };
    const req = signedRequest(env, "test-secret");

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(notifyApprovedEstimates).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // Pins the resource guard: a non-estimate event must never reach the
  // notification path.
  it("does not notify for a non-estimate event", async () => {
    const req = signedRequest(customerEnvelope(), "test-secret");

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(notifyApprovedEstimates).not.toHaveBeenCalled();
  });

  // Regression guard for the notification's own try/catch: a Slack failure
  // (async rejection from notifyApprovedEstimates) must be invisible to HCP —
  // same 200, same success body — not just "not a 500". A future edit that
  // moves this call outside its try/catch, or lets its rejection propagate,
  // would otherwise slip past every other test here.
  it("swallows an async notification failure and still returns the normal success response", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(notifyApprovedEstimates).mockRejectedValueOnce(new Error("slack down"));

    const env = {
      event: "estimate.updated",
      event_occurred_at: "2026-07-24T05:38:14Z",
      company_id: "co_1",
      estimate: {
        id: "est_1",
        options: [{ id: "opt_a", approval_status: "approved", total_amount: 100 }],
      },
    };
    const req = signedRequest(env, "test-secret");

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // Same guarantee, but for the real-world trigger: getSupabaseServerClient()
  // throws synchronously when a Supabase env var is missing in production.
  // That throw happens while evaluating the arguments to
  // notifyApprovedEstimates(...), still inside the notification's try block,
  // so it must be caught there rather than escaping to the response.
  it("swallows a synchronous getSupabaseServerClient() failure and still returns 200", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getSupabaseServerClient).mockImplementationOnce(() => {
      throw new Error("Missing env var: NEXT_PUBLIC_SUPABASE_URL");
    });

    const env = {
      event: "estimate.updated",
      event_occurred_at: "2026-07-24T05:38:14Z",
      company_id: "co_1",
      estimate: {
        id: "est_1",
        options: [{ id: "opt_a", approval_status: "approved", total_amount: 100 }],
      },
    };
    const req = signedRequest(env, "test-secret");

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
