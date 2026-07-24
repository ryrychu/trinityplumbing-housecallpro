import crypto from "crypto";
import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/housecall/webhookVerify";
import { syncOneRecord } from "@/lib/sync/syncService";

/**
 * Temporary: Housecall Pro does not document how `api-signature` is computed,
 * and 480 candidate constructions tested offline against the URL-validation
 * handshake all failed — most likely because that sample predates the signing
 * secret now in use. This runs the same search server-side against a real
 * delivery, where the secret is known to match, and logs only the NAME of the
 * winning construction. The request body never reaches the logs, so a real
 * customer record can be used as the sample without leaking PII.
 *
 * Delete this, and its WEBHOOK_DEBUG gate, once the scheme is pinned down and
 * encoded in verifyWebhookSignature.
 */
const SIGNATURE_CANDIDATES: Array<[string, (ts: string, body: string) => string]> = [
  ["body", (_ts, b) => b],
  ["ts+body", (ts, b) => ts + b],
  ["body+ts", (ts, b) => b + ts],
  ["ts.body", (ts, b) => `${ts}.${b}`],
  ["ts:body", (ts, b) => `${ts}:${b}`],
  ["ts|body", (ts, b) => `${ts}|${b}`],
  ["ts body", (ts, b) => `${ts} ${b}`],
  ["ts\\nbody", (ts, b) => `${ts}\n${b}`],
  ["v0:ts:body", (ts, b) => `v0:${ts}:${b}`],
  ["body.ts", (ts, b) => `${b}.${ts}`],
  ["ts-only", (ts) => ts],
];

function detectSignatureScheme(req: Request, rawBody: string, secret: string, received: string) {
  const ts = req.headers.get("api-timestamp") ?? "";

  const keys: Record<string, Buffer> = { utf8: Buffer.from(secret, "utf8") };
  if (/^[0-9a-f]+$/i.test(secret) && secret.length % 2 === 0) {
    keys.hex = Buffer.from(secret, "hex");
  }
  keys.b64 = Buffer.from(secret, "base64");

  const matched: string[] = [];
  for (const [keyName, key] of Object.entries(keys)) {
    for (const [msgName, build] of SIGNATURE_CANDIDATES) {
      for (const digest of ["sha256", "sha512", "sha1"]) {
        const message = build(ts, rawBody);
        const hex = crypto.createHmac(digest, key).update(message, "utf8").digest("hex");
        const b64 = crypto.createHmac(digest, key).update(message, "utf8").digest("base64");
        if (hex === received) matched.push(`${digest}/key=${keyName}/msg=${msgName}/hex`);
        if (b64 === received) matched.push(`${digest}/key=${keyName}/msg=${msgName}/base64`);
      }
    }
  }

  console.log(
    "[webhook-scheme]",
    JSON.stringify({
      matched,
      timestampPresent: ts.length > 0,
      receivedLength: received.length,
      bodyLength: rawBody.length,
    })
  );
}

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

/**
 * Housecall Pro signs deliveries with an `api-signature` header and sends an
 * `api-timestamp` alongside it — both confirmed from a real HCP request on
 * 2026-07-24. The previously assumed `X-HousecallPro-Signature` is never sent;
 * it is retained only as a fallback so the endpoint keeps working if HCP ever
 * renames the header back.
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

  if (process.env.WEBHOOK_DEBUG === "1") {
    logPayloadShape(req, rawBody);
  }

  let payload: { event?: string; resource?: string; data?: unknown };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }

  // Housecall Pro validates a webhook URL before saving it by POSTing a test
  // body of {"foo":"bar"} and requiring a 2xx; a 401 blocks the URL from being
  // saved at all. Such a request carries neither `resource` nor `data`, is never
  // dispatched to the sync layer, and touches nothing — so answering 200 ahead
  // of signature verification has no side effects. Requiring BOTH to be absent
  // keeps a real-but-malformed event (e.g. `data` present, `resource` missing)
  // on the 400 path rather than silently passing as a handshake.
  if (payload?.resource == null && payload?.data == null) {
    if (process.env.WEBHOOK_DEBUG === "1") {
      // Safe to log in full: the handshake body is the fixed literal
      // {"foo":"bar"} and contains no customer data. Captures the signature and
      // timestamp values needed to derive HCP's signing construction.
      console.log(
        "[webhook-handshake]",
        JSON.stringify({
          apiSignature: req.headers.get("api-signature"),
          apiTimestamp: req.headers.get("api-timestamp"),
          rawBody,
        })
      );
    }
    return NextResponse.json({ ok: true, handshake: true }, { status: 200 });
  }

  const signature = readSignature(req);
  const secret = process.env.HOUSECALL_WEBHOOK_SECRET;

  if (!secret) {
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    if (process.env.WEBHOOK_DEBUG === "1" && signature) {
      detectSignatureScheme(req, rawBody, secret, signature);
    }
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
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
