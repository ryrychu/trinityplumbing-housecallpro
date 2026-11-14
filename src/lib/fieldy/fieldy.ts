// Dave's Fieldy tasks in Slack: the morning post and `/trinity fieldy preview`.
//
// Fieldy (Dave's recording pendant) turns conversations into tasks. Each
// morning the bot posts the open ones and the ones he marked done yesterday
// to the channel in SLACK_FIELDY_CHANNEL_ID. Read from Fieldy at post time;
// nothing from Fieldy is stored. No LLM: the task status is already structured.
//
// Task titles can hold customer names and addresses, so they appear only in
// the post or the preview, never in logs.
import type { SupabaseClient } from "@supabase/supabase-js";
import { claim } from "@/lib/notifications/dedupe";
import { isFieldyDailyDue, localDateKey } from "@/lib/notifications/schedule";
import { postMessage } from "@/lib/slack/web";
import { FieldyApiError, fieldyApiKey, listTasks, type FieldyTask, type FieldyTaskStatus } from "./client";
import { formatFieldyPost } from "./report";

// Off unless exactly "true", like SLACK_ALERTS_ENABLED and SLACK_DECLINED_ENABLED.
// Covers the morning post and the preview.
export function fieldyEnabled(): boolean {
  return process.env.SLACK_FIELDY_ENABLED === "true";
}

export const DISABLED_TEXT = "The Fieldy task post isn't switched on yet.";

export const USAGE_TEXT = [
  "*Dave's Fieldy tasks* post each morning between 7 and 11.",
  "`/trinity fieldy preview` — today's post, shown only to you",
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
};

/** One line for the person who asked: the error code and what to do. Never the key or task text. */
export function describeFieldyError(err: FieldyApiError): string {
  const fix =
    FIXES[err.code] ??
    (err.code.startsWith("http_5") ? "Fieldy had a server error. Try again in a moment." : "See https://api.fieldy.ai/docs.");
  return `Couldn't read Fieldy: ${err.code}. ${fix}`;
}

export async function renderFieldy(cmd: FieldyCommand, now: Date, source: TaskSource = fieldyTaskSource()): Promise<string> {
  if (!fieldyEnabled()) return DISABLED_TEXT;
  if (cmd.kind === "fieldyUsage") return USAGE_TEXT;

  // Read-only: no claim, no post. The reply goes back through the slash
  // command's response_url, ephemeral.
  try {
    return formatFieldyPost(await source.tasks(), now, { preview: true });
  } catch (err) {
    if (err instanceof FieldyApiError) return describeFieldyError(err);
    throw err;
  }
}

/** The first setting the morning post is missing, or null when it has them all. */
function missingConfig(): string | null {
  if (!fieldyApiKey()) return "FIELDY_API_KEY is not set";
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return "SLACK_BOT_TOKEN is not set";
  if (!token.startsWith("xoxb-")) return "SLACK_BOT_TOKEN is not a bot token (xoxb-…)";
  if (!process.env.SLACK_FIELDY_CHANNEL_ID) return "SLACK_FIELDY_CHANNEL_ID is not set";
  return null;
}

export type FieldyReportDeps = { source: TaskSource; post: (text: string) => Promise<void> };

function defaultDeps(): FieldyReportDeps {
  return {
    source: fieldyTaskSource(),
    post: (text) => postMessage(process.env.SLACK_BOT_TOKEN!, process.env.SLACK_FIELDY_CHANNEL_ID!, text),
  };
}

/**
 * The morning post. Called from /api/cron/sync on every run (which already
 * checks SLACK_ALERTS_ENABLED); posts at most once per Eastern day (claim()
 * ledger, kind "fieldy_daily", keyed by the date).
 *
 * Same order as the declined-calls Monday post: read Fieldy and build the
 * text BEFORE claiming, so a Fieldy outage throws before the claim and the
 * next 15-minute run tries again. Once claimed, a failed post is not retried
 * (losing a message beats posting it twice).
 */
export async function runFieldyDailyPass(
  supabase: SupabaseClient,
  now: Date,
  deps: FieldyReportDeps = defaultDeps()
): Promise<boolean> {
  if (!fieldyEnabled()) return false;
  if (!isFieldyDailyDue(now)) return false;
  const missing = missingConfig();
  if (missing) {
    console.warn(`[fieldy] daily post skipped: ${missing}`);
    return false;
  }

  const text = formatFieldyPost(await deps.source.tasks(), now);
  if (!(await claim(supabase, "fieldy_daily", localDateKey(now)))) return false;

  await deps.post(text);
  return true;
}

