import crypto from "crypto";

export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(signature, "hex");

  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
