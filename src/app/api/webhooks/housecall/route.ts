import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/housecall/webhookVerify";
import { syncOneRecord } from "@/lib/sync/syncService";

/**
 * Housecall Pro signs deliveries with an `api-signature` header — HMAC-SHA256 of
 * `${api-timestamp}.${rawBody}` — and sends the `api-timestamp` alongside it.
 * Both were confirmed from real HCP requests on 2026-07-24. The previously
 * assumed `X-HousecallPro-Signature` is never sent; it is retained only as a
 * fallback so the endpoint keeps working if HCP ever renames the header.
 */
const SIGNATURE_HEADERS = ["api-signature", "x-housecallpro-signature"];

function readSignature(req: Request): string {
  for (const name of SIGNATURE_HEADERS) {
    const value = req.headers.get(name);
    if (value) return value;
  }
  return "";
}

export async function POST(req: Request) {
  const rawBody = await req.text();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  // Housecall Pro validates a webhook URL before saving it by POSTing an unsigned
  // test body of {"foo":"bar"} and requiring a 2xx; a 401 blocks the URL from
  // being saved at all. That handshake carries no `event`, whereas every real
  // delivery does (e.g. "customer.updated"). Gating the handshake on `event`
  // being absent — rather than on `resource`/`data`, which a real HCP event never
  // sends — is what stops a genuine delivery from being silently swallowed here.
  const event = typeof payload?.event === "string" ? payload.event : null;
  if (event == null) {
    return NextResponse.json({ ok: true, handshake: true }, { status: 200 });
  }

  const signature = readSignature(req);
  const timestamp = req.headers.get("api-timestamp") ?? "";
  const secret = process.env.HOUSECALL_WEBHOOK_SECRET;

  if (!secret) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  if (!verifyWebhookSignature(rawBody, signature, secret, timestamp)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // The changed record is delivered under a key named after its type, and the
  // type is the event's prefix: "customer.updated" → payload.customer holds the
  // FULL customer record. There is no `resource` field and no `data` field.
  // syncOneRecord normalizes the singular resource ("customer") to its plural
  // table key.
  const resource = event.split(".")[0];
  const record = payload[resource];
  if (record == null || typeof record !== "object" || Array.isArray(record)) {
    return NextResponse.json({ error: `Missing record for event ${event}` }, { status: 400 });
  }

  try {
    await syncOneRecord(resource, event, record);
  } catch (err) {
    // Log and acknowledge (200) rather than 500: a permanent failure (e.g. an
    // out-of-order event hitting an FK constraint) would otherwise trigger a
    // Housecall Pro retry storm. The Vercel Cron backfill reconciles any gap.
    console.error(`[webhook] sync failed for event=${event}:`, err);
    return NextResponse.json(
      { ok: false, error: "sync failed; logged for reconciliation" },
      { status: 200 }
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
