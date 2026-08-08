// The /trinity slash command.
//
// This route is NOT covered by src/middleware.ts's Supabase session gate — a
// slash command arrives from Slack's servers with no cookies, and a redirect to
// /app/login would be all Slack ever saw. The signature check below is
// therefore the whole of the authentication. Do not remove it, and do not add
// /api/slack/* to the middleware matcher (there is a regression test in
// src/__tests__/middleware.test.ts holding both halves of that).
import { NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { verifySlackSignature } from "@/lib/slack/verify";
import { parseCommand, renderCommand } from "@/lib/slack/commands";
import { postToResponseUrl } from "@/lib/slack/respond";

// A schedule read pages every job, customer and technician row. Comfortably
// more than the 10s an interactive default allows on a cold start.
export const maxDuration = 60;

// Declared once, near the top: both the deferred (waitUntil) path and the
// no-response_url fallback below read this same fallback string, and keeping
// it here rather than duplicated at each call site is what keeps the two
// answers from drifting apart.
const FAILURE_TEXT = "I couldn't reach the schedule just now — try again in a moment.";

function ephemeral(text: string, status = 200) {
  return NextResponse.json({ response_type: "ephemeral", text }, { status });
}

export async function POST(req: Request) {
  // Both checks below run before the body is even read: a disabled deployment
  // or a missing signing secret should refuse an unauthenticated request
  // without first buffering it — Vercel allows a body up to ~4.5 MB, and
  // there is no reason to read one for a request we're about to reject
  // regardless of what it contains.

  // Default off, exactly like slackAlertsEnabled() — so this can deploy and be
  // observed before it is allowed to answer anyone.
  if (process.env.SLACK_COMMANDS_ENABLED !== "true") {
    return ephemeral("Trinity commands are not enabled on this deployment.");
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    // Distinct from a bad signature, and safe to say out loud: an unconfigured
    // variable is a setup mistake the operator needs named, not an attacker
    // hint. Without this the failure looks identical to a signing mismatch.
    // 503, not 200: this is the deployment refusing to run at all, not an
    // answer to the command.
    return ephemeral(
      "SLACK_SIGNING_SECRET is not set on this deployment — see docs/SLACK-ROLLOUT.md",
      503
    );
  }

  // Read the body ONCE, as text, only once we know we might actually use it.
  // Slack signs the raw bytes; parsing and re-serializing changes them and
  // every signature fails.
  const rawBody = await req.text();

  const ok = verifySlackSignature({
    rawBody,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    signingSecret,
    nowMs: Date.now(),
  });
  if (!ok) {
    // No detail in the body, and the presented signature is never logged.
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Defensive, not a known Slack behavior: x-slack-retry-num is an Events API
  // header, and slash commands are not documented to retry — a slow command
  // just shows the user "operation timed out" with nothing resent. If one
  // ever does arrive carrying this header, doing no work here is cheap
  // insurance against posting the same schedule twice.
  if (req.headers.get("x-slack-retry-num")) {
    return new NextResponse(null, { status: 200 });
  }

  const params = new URLSearchParams(rawBody);
  const responseUrl = params.get("response_url");
  const cmd = parseCommand(params.get("text") ?? "");

  if (!responseUrl) {
    // Nowhere to send the real answer, so answer inline. Reachable in normal
    // operation, not just from a hand-made request: Slack's ssl_check=1 probe
    // (sent when the command's Request URL is saved in the app config) is
    // signed like a real request but carries no response_url and no text.
    return ephemeral(
      await renderCommand(cmd, new Date()).catch((err) => {
        console.error("[slack] command failed:", err instanceof Error ? err.message : String(err));
        return FAILURE_TEXT;
      })
    );
  }

  // Acknowledge now, answer after. A schedule read cannot finish inside Slack's
  // 3-second budget, and a late 200 shows the user a timeout error and triggers
  // the retry the guard above then has to swallow.
  waitUntil(
    (async () => {
      let text: string;
      try {
        text = await renderCommand(cmd, new Date());
      } catch (err) {
        // Log the message; post a plain sentence. A raw Supabase error can
        // carry customer rows, and this reply lands in a chat window.
        console.error("[slack] command failed:", err instanceof Error ? err.message : String(err));
        text = FAILURE_TEXT;
      }
      await postToResponseUrl(responseUrl, text);
    })()
  );

  return ephemeral("Working on it…");
}
