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

  const payload = JSON.parse(rawBody) as { event: string; resource: string; data: unknown };
  await syncOneRecord(payload.resource, payload.event, payload.data);

  return NextResponse.json({ ok: true }, { status: 200 });
}
