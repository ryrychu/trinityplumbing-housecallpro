// Render the real daily digest from live Supabase data and optionally post it
// to Slack — at any hour, without waiting for the 06:00-12:00 Eastern window.
//
// This deliberately bypasses isDailyDigestDue() and claim(), so it does NOT
// consume the day's claim: running it will not stop the genuine 6am digest from
// going out. It exercises the real query and the real formatter, so what you
// see here is exactly what the cron will send.
//
// Usage (from the repo root):
//   npx tsx scripts/preview-digest.mts             # print only, post nothing
//   npx tsx scripts/preview-digest.mts --post      # also post to Slack
//   npx tsx scripts/preview-digest.mts --post --week   # week-ahead instead
//
// Reads SLACK_WEBHOOK_SCHEDULE from .env.local, or pass it as the last arg.
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim();
}

const { getDashboardSnapshot, getWeekAheadSchedule } = await import("@/lib/dashboard/queries");
const { formatDailyDigest, formatWeeklyLookahead } = await import("@/lib/slack/format");
const { postSlack } = await import("@/lib/slack/client");

const args = process.argv.slice(2);
const shouldPost = args.includes("--post");
const weekly = args.includes("--week");
const urlArg = args.find((a) => a.startsWith("https://hooks.slack.com/"));
const webhook = urlArg ?? process.env.SLACK_WEBHOOK_SCHEDULE;

const now = new Date();

const text = weekly
  ? formatWeeklyLookahead(now, await getWeekAheadSchedule(now))
  : formatDailyDigest(now, (await getDashboardSnapshot(now)).todaySchedule, 0);

console.log("\n" + "-".repeat(60));
console.log(text);
console.log("-".repeat(60) + "\n");

if (!shouldPost) {
  console.log("Not posted. Re-run with --post to send it to Slack.\n");
  process.exit(0);
}

if (!webhook) {
  console.error("No webhook. Add SLACK_WEBHOOK_SCHEDULE to .env.local or pass the URL as an argument.");
  process.exit(1);
}

console.log((await postSlack(webhook, text)) ? "Posted to Slack.\n" : "Post FAILED — see the error above.\n");
