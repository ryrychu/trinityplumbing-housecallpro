// Digest timing, decided in code rather than in a cron expression. Cron cannot
// express "6am Eastern" — only a fixed UTC hour that is wrong for half the
// year. Evaluating the rule against America/New_York on every 15-minute run
// makes DST a non-issue permanently and makes a missed ping self-healing.
//
// Pure: clock in, boolean out. The "already sent today" check is claim(),
// applied by the caller — keeping it out of here is what lets these tests run
// without a database.
import { localParts } from "@/lib/dashboard/week";

const DIGEST_HOUR = 6;
// Upper bound so a scheduler outage that ends in the afternoon does not deliver
// a "Today" digest at bedtime. Between 06:00 and this hour, any run catches up.
const DIGEST_CUTOFF_HOUR = 12;
const MONDAY = 1;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDateKey(now: Date): string {
  const { y, m0, d } = localParts(now);
  return `${y}-${pad(m0 + 1)}-${pad(d)}`;
}

export function mondayDateKey(now: Date): string {
  const { y, m0, d, dow } = localParts(now);
  const daysSinceMonday = (dow + 6) % 7; // Sun(0) -> 6, Mon(1) -> 0
  const monday = new Date(Date.UTC(y, m0, d - daysSinceMonday));
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

function inMorningWindow(now: Date): boolean {
  const { hour } = localParts(now);
  return hour >= DIGEST_HOUR && hour < DIGEST_CUTOFF_HOUR;
}

export function isDailyDigestDue(now: Date): boolean {
  const { dow } = localParts(now);
  if (dow === 0 || dow === 6) return false; // weekends
  return inMorningWindow(now);
}

export function isWeeklyLookaheadDue(now: Date): boolean {
  const { dow } = localParts(now);
  if (dow !== MONDAY) return false;
  return inMorningWindow(now);
}
