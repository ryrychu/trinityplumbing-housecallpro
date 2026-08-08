// Slack request signing. This is the ONLY thing standing between a stranger and
// the schedule: /api/slack/command sits outside the middleware's Supabase
// session gate (a slash command arrives from Slack's servers with no cookies),
// so there is no login behind this.
//
// https://api.slack.com/authentication/verifying-requests-from-slack
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Slack's own recommendation. Bounds how long a captured request stays
// replayable if one is ever intercepted.
const MAX_SKEW_MS = 5 * 60 * 1000;

export function verifySlackSignature(opts: {
  /**
   * The request body EXACTLY as received. Slack signs the bytes, so the caller
   * must read it once with `await req.text()` and parse it themselves.
   * Reading with req.json()/req.formData() and re-serializing changes the bytes
   * and makes every signature fail, with no useful error to explain why.
   */
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  signingSecret: string | undefined;
  nowMs: number;
}): boolean {
  const { rawBody, timestamp, signature, signingSecret, nowMs } = opts;

  // An unset secret is a setup mistake, and it must fail closed. Returning true
  // here (or skipping the check) would publish the schedule to the internet.
  if (!signingSecret || !timestamp || !signature) return false;

  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  if (Math.abs(nowMs - tsSeconds * 1000) > MAX_SKEW_MS) return false;

  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  // sha256 both sides before comparing: timingSafeEqual throws when the two
  // buffers differ in length, and that throw would itself leak the expected
  // signature's length to anyone probing. Same technique as tokenMatches() in
  // src/app/api/admin/trigger/route.ts.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(signature).digest();
  return timingSafeEqual(a, b);
}
