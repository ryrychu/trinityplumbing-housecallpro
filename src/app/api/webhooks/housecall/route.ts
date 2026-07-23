import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/housecall/webhookVerify";
import { syncOneRecord } from "@/lib/sync/syncService";

export async function POST(req: Request) {
  const rawBody = await req.text();
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
