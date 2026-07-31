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

let envFile: string;
try {
  envFile = readFileSync(".env.local", "utf8");
} catch {
  console.error(
    "No .env.local here. Run this from the repo root, with NEXT_PUBLIC_SUPABASE_URL,\n" +
      "SUPABASE_SERVICE_ROLE_KEY and SLACK_WEBHOOK_SCHEDULE set in it."
  );
  process.exit(1);
}

for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  // `vercel env pull` writes values double-quoted; a hand-written .env.local
  // usually does not. Strip one matching pair so both forms work — keeping the
  // quotes turned the Supabase URL into an invalid URL and blew up deep inside
  // supabase-js, a long way from the actual cause.
  process.env[m[1]] ??= m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
}

// Env vars marked "Sensitive" in Vercel are write-only: `vercel env pull` hands
// back the literal string [SENSITIVE] instead of the value, and nothing can
// recover the plaintext from Vercel. Caught here by name, because the resulting
// failure otherwise surfaces as an unrelated-looking client error.
const REQUIRED = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const unusable = REQUIRED.filter((k) => !process.env[k] || process.env[k] === "[SENSITIVE]");
if (unusable.length > 0) {
  console.error(
    `Unusable in .env.local: ${unusable.join(", ")}\n\n` +
      "If these read [SENSITIVE], they were pulled from Vercel, which stores them\n" +
      "write-only — the values cannot be read back. Copy the real ones from the\n" +
      "Supabase dashboard (Project Settings -> API) into .env.local by hand."
  );
  process.exit(1);
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
