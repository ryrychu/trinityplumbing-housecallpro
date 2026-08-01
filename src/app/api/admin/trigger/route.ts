// Manual Slack triggers for the /admin buttons.
//
// Why this exists at all: the schedule digest only sends between 06:00 and
// 12:00 Eastern, and every secret in this project is a Vercel *Sensitive*
// environment variable — write-only, so `vercel env pull` hands back the
// literal string [SENSITIVE] and scripts/preview-digest.mts cannot reach
// production Supabase or Slack from a laptop. Vercel also has no "run this
// cron now" button. Without this route there is no way to post a digest on
// demand, which is exactly what you want the first time you're checking that
// a fix works.
//
// AUTH: this is deliberately NOT gated on CRON_SECRET. That value is Sensitive
// too, so nobody can read it to type it into a form. ADMIN_TRIGGER_TOKEN is a
// separate variable whose value you choose, which is what makes it usable by a
// human. It is the only thing standing between a public URL and anyone posting
// to the company Slack — the app has no other authentication.
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { renderDigest, isDigestKind, DIGEST_LABELS } from "@/lib/notifications/digest";
import { postSlack, slackAlertsEnabled } from "@/lib/slack/client";

// Digest queries hit Supabase and Slack; well under the sync route's budget,
// but not the 10s an interactive default would allow on a cold start.
export const maxDuration = 60;

// Compare hashes, not the raw strings: sha256 makes both sides a fixed 32
// bytes (timingSafeEqual throws on a length mismatch, and that throw would
// itself leak the token's length to anyone probing).
function tokenMatches(supplied: string, expected: string): boolean {
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const expected = process.env.ADMIN_TRIGGER_TOKEN;
  if (!expected) {
    // Distinct from a wrong token, and safe to say out loud: an unconfigured
    // variable is a setup mistake the operator needs named, not an attacker
    // hint. Without this the failure looks identical to a typo'd token.
    return NextResponse.json(
      { error: "ADMIN_TRIGGER_TOKEN is not set on this deployment — see docs/SLACK-ROLLOUT.md" },
      { status: 503 }
    );
  }

  let body: { action?: unknown; token?: unknown; post?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  if (!token || !tokenMatches(token, expected)) {
    return NextResponse.json({ error: "Wrong token" }, { status: 401 });
  }

  if (!isDigestKind(body.action)) {
    return NextResponse.json(
      { error: `Unknown action '${String(body.action)}' — use 'digest' or 'week'` },
      { status: 400 }
    );
  }
  const action = body.action;

  // Preview is the default. Posting to a real channel that several people read
  // should be the thing you opt into, not the thing you get by forgetting a
  // flag — and previewing first is the whole reason to have a UI rather than
  // a curl command.
  const shouldPost = body.post === true;

  let text: string;
  try {
    text = await renderDigest(action, new Date());
  } catch (err) {
    return NextResponse.json(
      { error: `Could not build the message: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  if (!shouldPost) {
    return NextResponse.json({ ok: true, posted: false, label: DIGEST_LABELS[action], text });
  }

  if (!slackAlertsEnabled()) {
    return NextResponse.json(
      { ok: false, posted: false, text, error: "SLACK_ALERTS_ENABLED is not 'true' on this deployment" },
      { status: 409 }
    );
  }

  // postSlack swallows its own failures and returns false — correct for the
  // cron, where a Slack outage must not fail the sync, but here the caller is
  // a person watching a button, so the false has to become a visible error.
  const posted = await postSlack(process.env.SLACK_WEBHOOK_SCHEDULE, text);
  if (!posted) {
    return NextResponse.json(
      { ok: false, posted: false, text, error: "Slack rejected the post — check the function logs" },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, posted: true, label: DIGEST_LABELS[action], text });
}
