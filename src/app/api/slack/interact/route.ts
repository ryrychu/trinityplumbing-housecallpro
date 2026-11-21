// Slack interactivity: taps on Dave's Fieldy checklist checkboxes.
// Slack app → Interactivity & Shortcuts → Request URL https://ops.trinity.plumbing/api/slack/interact
//
// Like /api/slack/command, this is NOT behind src/middleware.ts's session gate
// (Slack's servers carry no cookies). The signature check below is the whole
// of the authentication; src/__tests__/middleware.test.ts keeps /api/slack/*
// out of the matcher.
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { fieldyEnabled } from "@/lib/fieldy/fieldy";
import { postEphemeralNote } from "@/lib/slack/respond";
import { verifySlackSignature } from "@/lib/slack/verify";
import { checklistConfigMissing, liveChecklistDeps } from "@/lib/tasks/deps";
import { allowedSlackUsers, handleChecklistTap, type BlockActionsPayload } from "@/lib/tasks/interact";
import { parseActionId } from "@/lib/tasks/render";

export const maxDuration = 60;

const OK = () => new NextResponse(null, { status: 200 });

export async function POST(req: Request) {
  // Same order as the command route: switch, secret, then read and verify the body.
  if (!fieldyEnabled()) return OK();

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return NextResponse.json({ error: "SLACK_SIGNING_SECRET is not set on this deployment" }, { status: 503 });
  }

  const rawBody = await req.text();
  const ok = verifySlackSignature({
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    signingSecret,
    nowMs: Date.now(),
  });
  if (!ok) return new NextResponse("Unauthorized", { status: 401 });

  let payload: BlockActionsPayload;
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "");
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const isChecklistTap =
    payload?.type === "block_actions" && (payload.actions ?? []).some((a) => a.action_id && parseActionId(a.action_id));
  if (!isChecklistTap) return OK();

  const missing = checklistConfigMissing();
  if (missing) {
    console.warn(`[fieldy] checklist tap ignored: ${missing}`);
    return OK();
  }

  // Slack wants an answer within 3 seconds; Fieldy plus chat.update can take longer.
  waitUntil(
    handleChecklistTap(payload, liveChecklistDeps(), { allowedUsers: allowedSlackUsers(), note: postEphemeralNote }).catch((err) =>
      console.error("[slack] checklist tap failed:", err instanceof Error ? err.message : String(err))
    )
  );
  return OK();
}
