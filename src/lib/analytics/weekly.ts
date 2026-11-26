// Website traffic: the Monday post to SLACK_ANALYTICS_CHANNEL_ID, the
// `/trinity traffic preview` reply, and the lookup behind ChatGPT's
// get_site_traffic. All three build the same TrafficReport.
import type { SupabaseClient } from "@supabase/supabase-js";
import { claim, isClaimed } from "@/lib/notifications/dedupe";
import { isAnalyticsWeeklyDue } from "@/lib/notifications/schedule";
import { postMessage } from "@/lib/slack/web";
import { analyticsConfig, analyticsWeeklyEnabled, type GaProperty } from "./config";
import { fetchTrafficReport } from "./fetch";
import { GaApiError, getAccessToken, runReport } from "./google";
import type { TrafficReport } from "./report";
import { renderTrafficMessage, type TrafficMessage } from "./slack";
import { reportWeeks, type ReportWeeks } from "./week";

const KIND = "analytics_weekly";
const DOCS = "See docs/SLACK-ROLLOUT.md (Website traffic).";

export interface TrafficSource {
  fetch(properties: GaProperty[], weeks: ReportWeeks): Promise<TrafficReport>;
}

/** Reads the key when each fetch runs, so building this never throws. */
export function liveTrafficSource(): TrafficSource {
  return {
    async fetch(properties, weeks) {
      const cfg = analyticsConfig();
      if (!cfg.ok) throw new Error(`[analytics] ${cfg.missing}`);
      return fetchTrafficReport(properties, weeks, { token: () => getAccessToken(cfg.account), runReport });
    },
  };
}

export type TrafficCommand = { kind: "trafficPreview" } | { kind: "trafficUsage" };

/** `rest` is everything after the word "traffic". */
export function parseTraffic(rest: string): TrafficCommand {
  return rest.trim().toLowerCase() === "preview" ? { kind: "trafficPreview" } : { kind: "trafficUsage" };
}

export const USAGE_TEXT = [
  "*Website traffic* posts every Monday morning: last week's visitors on each site, where they came from, and the calls, booking clicks and form requests the sites brought in.",
  "`/trinity traffic preview` — last week's post, shown only to you",
].join("\n");

const TOKEN_FIXES: Record<string, string> = {
  invalid_grant:
    "Google didn't accept the service account key. Check GA_SERVICE_ACCOUNT_JSON holds a key that still exists in Google Cloud, then redeploy.",
  invalid_client: "Google doesn't recognise the service account. Paste the whole key file into GA_SERVICE_ACCOUNT_JSON again.",
  bad_key: "The private_key in GA_SERVICE_ACCOUNT_JSON can't be read. Paste the whole key file again.",
  network: "Couldn't reach Google. Try again in a moment.",
  timeout: "Google took too long to answer. Try again in a moment.",
};

/** One line for the person who asked. Error codes only, never the key. */
export function describeGaError(err: GaApiError): string {
  if (err.op === "token") return `Couldn't sign in to Google Analytics: ${err.code}. ${TOKEN_FIXES[err.code] ?? DOCS}`;
  return `Couldn't read Google Analytics: ${err.code}. ${DOCS}`;
}

export async function renderTraffic(
  cmd: TrafficCommand,
  now: Date,
  source: TrafficSource = liveTrafficSource()
): Promise<string | TrafficMessage> {
  if (cmd.kind === "trafficUsage") return USAGE_TEXT;

  const cfg = analyticsConfig();
  if (!cfg.ok) return `Website traffic isn't set up yet: ${cfg.missing}. ${DOCS}`;

  // Read-only: no claim, no post. The reply goes back through the slash
  // command's response_url, ephemeral.
  try {
    return renderTrafficMessage(await source.fetch(cfg.properties, reportWeeks(now)), { preview: true });
  } catch (err) {
    if (err instanceof GaApiError) return describeGaError(err);
    throw err;
  }
}

export type TrafficLookup =
  | { status: "not_configured"; missing: string }
  | { status: "no_match"; site: string; sites: string[] }
  | { status: "ok"; report: TrafficReport };

/** For ChatGPT: needs only the GA variables, not the weekly post's switch or channel. */
export async function lookupTraffic(
  now: Date,
  opts: { weeksAgo: number; site?: string },
  source: TrafficSource = liveTrafficSource()
): Promise<TrafficLookup> {
  const cfg = analyticsConfig();
  if (!cfg.ok) return { status: "not_configured", missing: cfg.missing };

  const needle = opts.site?.trim().toLowerCase();
  const properties = needle ? cfg.properties.filter((p) => p.site.toLowerCase().includes(needle)) : cfg.properties;
  if (properties.length === 0) {
    return { status: "no_match", site: opts.site?.trim() ?? "", sites: cfg.properties.map((p) => p.site) };
  }
  return { status: "ok", report: await source.fetch(properties, reportWeeks(now, opts.weeksAgo)) };
}

/** The first setting the Monday post is missing, or null. Names only, never values. */
function weeklyConfigMissing(): string | null {
  const cfg = analyticsConfig();
  if (!cfg.ok) return cfg.missing;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return "SLACK_BOT_TOKEN is not set";
  if (!token.startsWith("xoxb-")) return "SLACK_BOT_TOKEN is not a bot token (xoxb-…)";
  if (!process.env.SLACK_ANALYTICS_CHANNEL_ID) return "SLACK_ANALYTICS_CHANNEL_ID is not set";
  return null;
}

export type WeeklyDeps = { source: TrafficSource; post: (message: TrafficMessage) => Promise<void> };

function liveWeeklyDeps(): WeeklyDeps {
  return {
    source: liveTrafficSource(),
    post: async (m) => {
      await postMessage(process.env.SLACK_BOT_TOKEN ?? "", process.env.SLACK_ANALYTICS_CHANNEL_ID ?? "", m.text, m.blocks);
    },
  };
}

/**
 * The Monday post. Called from /api/cron/sync on every run; posts at most once
 * per reported week (claim() ledger, kind "analytics_weekly", keyed by that
 * week's Monday). Same order as the declined-calls post: build the report,
 * then claim, then post, so a Google outage throws before the claim and the
 * next 15-minute run tries again. It looks at the ledger first as well, so
 * the runs after the post don't call Google for nothing.
 */
export async function runAnalyticsWeeklyPass(
  supabase: SupabaseClient,
  now: Date,
  deps: WeeklyDeps = liveWeeklyDeps()
): Promise<boolean> {
  if (!analyticsWeeklyEnabled()) return false;
  if (!isAnalyticsWeeklyDue(now)) return false;
  const missing = weeklyConfigMissing();
  if (missing) {
    console.warn(`[analytics] weekly post skipped: ${missing}`);
    return false;
  }
  const cfg = analyticsConfig();
  if (!cfg.ok) return false;

  const weeks = reportWeeks(now);
  if (await isClaimed(supabase, KIND, weeks.week.key)) return false;

  const report = await deps.source.fetch(cfg.properties, weeks);
  // Some sites missing is still worth posting; none at all is an outage.
  if (report.siteCount > 0 && report.unavailableCount === report.siteCount) {
    const codes = report.sites.map((s) => (s.status === "unavailable" ? s.reason : "ok")).join(", ");
    throw new Error(`[analytics] no site could be read: ${codes}`);
  }
  const message = renderTrafficMessage(report);

  if (!(await claim(supabase, KIND, weeks.week.key))) return false;
  await deps.post(message);
  return true;
}
