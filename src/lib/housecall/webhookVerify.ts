import crypto from "crypto";

/**
 * Housecall Pro signs the message `${api-timestamp}.${rawBody}` with
 * HMAC-SHA256 (the webhook secret as UTF-8 bytes) and hex-encodes it into the
 * `api-signature` header. This construction was derived offline from a live
 * delivery on 2026-07-24 (timestamp `.` body, sha256, utf8 key, hex output).
 * The timestamp is part of the signed message, so it must be supplied here or
 * the comparison can never match.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
  timestamp: string
): boolean {
  const message = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(message).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");

  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
