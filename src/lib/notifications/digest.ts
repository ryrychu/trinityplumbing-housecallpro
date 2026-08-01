// Rendering a schedule digest on demand, independent of when it is due.
//
// Three callers need the exact same message: the 6am scheduled pass, the
// `?force=` escape hatch on the cron route, and the /admin buttons. Factoring
// it here is what makes "what the button previews" and "what the 6am cron
// sends" the same string by construction rather than by two implementations
// agreeing today and drifting next month.
import { getDashboardSnapshot, getWeekAheadSchedule } from "@/lib/dashboard/queries";
import { formatDailyDigest, formatWeeklyLookahead } from "@/lib/slack/format";

export type DigestKind = "digest" | "week";

export function isDigestKind(v: unknown): v is DigestKind {
  return v === "digest" || v === "week";
}

// Human-readable label for a kind, so callers don't each invent their own.
export const DIGEST_LABELS: Record<DigestKind, string> = {
  digest: "Today's schedule",
  week: "Week ahead",
};

export async function renderDigest(
  kind: DigestKind,
  now: Date,
  lastSyncMinutesAgo: number | null
): Promise<string> {
  if (kind === "week") {
    return formatWeeklyLookahead(now, await getWeekAheadSchedule(now));
  }
  const snapshot = await getDashboardSnapshot(now);
  return formatDailyDigest(now, snapshot.todaySchedule, lastSyncMinutesAgo);
}
