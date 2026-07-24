import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/housecall/webhookVerify";
import { syncOneRecord } from "@/lib/sync/syncService";

/**
 * Temporary go-live probe. Housecall Pro's OpenAPI spec documents the webhook
 * subscription endpoint but not the event payload (`schema: {type: object}`),
 * so three things must be confirmed against a real delivery:
 *   1. the signature header's actual name,
 *   2. whether `resource` is singular ("job") or plural ("jobs"),
 *   3. whether `data` is the full record or only the changed fields.
 *
 * This runs BEFORE signature verification on purpose: if the header name is
 * wrong we reject with 401 and would otherwise learn nothing from the delivery.
 * It logs key names only — never field values — so no customer PII reaches the
 * logs. Gated on WEBHOOK_DEBUG so it can be switched off without a code change.
 */
function logPayloadShape(req: Request, rawBody: string) {
  // forEach rather than spreading headers.keys(): the build targets pre-ES2015,
  // where iterating an iterator would require --downlevelIteration.
  const headerNames: string[] = [];
  req.headers.forEach((_value, name) => {
    if (!/^(cookie|authorization)$/i.test(name)) headerNames.push(name);
  });

  let shape: Record<string, unknown> = { parse: "failed" };
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const top = (parsed ?? {}) as Record<string, unknown>;
    const data = top.data;
    shape = {
      topLevelKeys: Object.keys(top),
      resource: top.resource,
      event: top.event,
      dataKeys:
        data && typeof data === "object" && !Array.isArray(data)
          ? Object.keys(data as Record<string, unknown>)
          : `not-an-object: ${Array.isArray(data) ? "array" : typeof data}`,
    };
  } catch {
    // shape stays { parse: "failed" }
  }

  console.log("[webhook-probe]", JSON.stringify({ headerNames, shape }));
}

export async function POST(req: Request) {
  const rawBody = await req.text();

  if (process.env.WEBHOOK_DEBUG === "1") {
    logPayloadShape(req, rawBody);
  }

  const signature = req.headers.get("X-HousecallPro-Signature") ?? "";
  const secret = process.env.HOUSECALL_WEBHOOK_SECRET;

  if (!secret) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: { event?: string; resource?: string; data?: unknown };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  if (typeof payload?.resource !== "string" || payload.data == null) {
    return NextResponse.json({ error: "Missing resource or data" }, { status: 400 });
  }

  try {
    await syncOneRecord(payload.resource, payload.event ?? "", payload.data);
  } catch (err) {
    // Log and acknowledge (200) rather than 500: a permanent failure (e.g. an
    // out-of-order event hitting an FK constraint) would otherwise trigger a
    // Housecall Pro retry storm. The Vercel Cron backfill reconciles any gap.
    console.error(
      `[webhook] sync failed for resource=${payload.resource} event=${payload.event ?? ""}:`,
      err
    );
    return NextResponse.json(
      { ok: false, error: "sync failed; logged for reconciliation" },
      { status: 200 }
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
