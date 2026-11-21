// Slack interactivity: taps on checklist checkboxes. Handles fieldy_cb: (Dave's Fieldy
// checklist) and pb_cb: (price book service changes) taps, each behind its own switch.
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
import { liveServiceDeps, pricebookEditEnabled, pricebookSlackUsers, serviceConfigMissing } from "@/lib/pricebook/edit/deps";
import { handleServiceTap, parsePbActionId } from "@/lib/pricebook/edit/serviceChecklist";

export const maxDuration = 60;

const OK = () => new NextResponse(null, { status: 200 });

export async function POST(req: Request) {
  // Same order as the command route: switches, secret, then read and verify the body.
  const fieldyOn = fieldyEnabled();
  const pbOn = pricebookEditEnabled();
  if (!fieldyOn && !pbOn) return OK();

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
  if (payload?.type !== "block_actions" || !Array.isArray(payload.actions)) return OK();
  const actions = payload.actions;

  const jobs: Promise<unknown>[] = [];
  const log = (what: string) => (err: unknown) =>
    console.error(`[slack] ${what} tap failed:`, err instanceof Error ? err.message : String(err));

  if (fieldyOn && actions.some((a) => a.action_id && parseActionId(a.action_id))) {
    const missing = checklistConfigMissing();
    if (missing) console.warn(`[fieldy] checklist tap ignored: ${missing}`);
    else jobs.push(handleChecklistTap(payload, liveChecklistDeps(), { allowedUsers: allowedSlackUsers(), note: postEphemeralNote }).catch(log("checklist")));
  }
  if (pbOn && actions.some((a) => a.action_id && parsePbActionId(a.action_id))) {
    const missing = serviceConfigMissing();
    if (missing) console.warn(`[pricebook] service tap ignored: ${missing}`);
    else jobs.push(handleServiceTap(payload, liveServiceDeps(), { allowedUsers: pricebookSlackUsers(), note: postEphemeralNote }).catch(log("price book")));
  }
  // Slack wants an answer within 3 seconds; the work finishes after the reply.
  if (jobs.length > 0) waitUntil(Promise.all(jobs));
  return OK();
}
