// Dave's Fieldy tasks in Slack: the switch, /trinity fieldy preview, and the Fieldy error text. The checklist itself lives in src/lib/tasks/.
//
// Task titles can hold customer names and addresses, so they appear only in
// the checklist or the preview, never in logs.
import { localDateKey } from "@/lib/notifications/schedule";
import { liveFieldyPort, liveOrganizer } from "@/lib/tasks/deps";
import { planChecklist, type ChecklistPlan } from "@/lib/tasks/morning";
import { renderChecklistPreview } from "@/lib/tasks/render";
import { FieldyApiError, listTasks, type FieldyTask, type FieldyTaskStatus } from "./client";

// Off unless exactly "true", like SLACK_ALERTS_ENABLED and SLACK_DECLINED_ENABLED.
// Covers the morning post and the preview.
export function fieldyEnabled(): boolean {
  return process.env.SLACK_FIELDY_ENABLED === "true";
}

export const DISABLED_TEXT = "The Fieldy task post isn't switched on yet.";

export const USAGE_TEXT = [
  "*Dave's Fieldy checklist* posts each morning between 7 and 11.",
  "`/trinity fieldy preview` — today's checklist as it would be built now, shown only to you",
].join("\n");

export type FieldyCommand = { kind: "fieldyPreview" } | { kind: "fieldyUsage" };

/** `rest` is everything after the word "fieldy". */
export function parseFieldy(rest: string): FieldyCommand {
  return rest.trim().toLowerCase() === "preview" ? { kind: "fieldyPreview" } : { kind: "fieldyUsage" };
}

// The three statuses the post needs. Rejected, skipped, cancelled and expired
// are never shown, so they are never fetched.
const FETCH_STATUSES: FieldyTaskStatus[] = ["new", "approved", "completed"];

export interface TaskSource {
  tasks(): Promise<FieldyTask[]>;
}

/** Three GETs (well inside Fieldy's 100 a minute). Any failure fails the whole read. */
export function fieldyTaskSource(): TaskSource {
  return {
    async tasks() {
      const lists = await Promise.all(FETCH_STATUSES.map((s) => listTasks(s)));
      return lists.flat();
    },
  };
}

const FIXES: Record<string, string> = {
  key_not_set:
    "FIELDY_API_KEY isn't set on this deployment yet. Dave makes a key in the Fieldy app (Settings → Developer Settings); Ryan adds it in Vercel and redeploys.",
  http_401: "Fieldy refused FIELDY_API_KEY. Make a new key in the Fieldy app (Settings → Developer Settings), update it in Vercel, redeploy.",
  http_403: "Fieldy refused FIELDY_API_KEY for this. Check the key and that Dave's Fieldy plan includes the API.",
  http_429: "Fieldy is rate-limiting (100 requests a minute). Try again in a minute.",
  timeout: "Couldn't reach Fieldy (timed out). Try again in a moment.",
  network: "Couldn't reach Fieldy (network). Try again in a moment.",
  bad_response: "Fieldy sent back something unexpected. Its API may have changed; see src/lib/fieldy/client.ts.",
  too_many_pages: "Fieldy kept returning more pages than expected. See src/lib/fieldy/client.ts.",
  http_404: "Fieldy doesn't have that task any more. It may have been deleted in the Fieldy app.",
  update_failed: "Fieldy didn't accept the change. The task may have been deleted in the Fieldy app.",
};

/** One line for the person who asked: the error code and what to do. Never the key or task text. */
export function describeFieldyError(err: FieldyApiError): string {
  const fix =
    FIXES[err.code] ??
    (err.code.startsWith("http_5") ? "Fieldy had a server error. Try again in a moment." : "See https://api.fieldy.ai/docs.");
  const verb = err.op.startsWith("GET") ? "read" : "update";
  return `Couldn't ${verb} Fieldy: ${err.code}. ${fix}`;
}

export async function renderFieldy(
  cmd: FieldyCommand,
  now: Date,
  plan: () => Promise<ChecklistPlan> = () => planChecklist({ fieldy: liveFieldyPort(), now: () => now }, liveOrganizer())
): Promise<string> {
  if (!fieldyEnabled()) return DISABLED_TEXT;
  if (cmd.kind === "fieldyUsage") return USAGE_TEXT;

  // Read-only: no claim, no post, nothing saved. The reply goes back through
  // the slash command's response_url, ephemeral.
  try {
    const p = await plan();
    return renderChecklistPreview(localDateKey(now), p.grouping, p.builtBy, p.finishedYesterday);
  } catch (err) {
    if (err instanceof FieldyApiError) return describeFieldyError(err);
    throw err;
  }
}
