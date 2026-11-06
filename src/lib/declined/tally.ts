// Counting and wording for turned-down calls. Pure: rows and a clock in, numbers
// and strings out, so the rules Dave's hiring decision rests on are testable
// without a database.
//
// Weeks are Trinity's Mon–Sun in America/New_York, taken from
// src/lib/dashboard/week.ts so this count and the schedule digests can never
// disagree about which week a Sunday-night call belongs to.
import { weekRange, dayRange, localParts } from "@/lib/dashboard/week";
import { localDateKey, mondayDateKey } from "@/lib/notifications/schedule";
import { dayLabelFromKey } from "@/lib/slack/format";
import type { DeclinedReason } from "./parse";

/** About this many a week means another van and another plumber. */
export const HIRE_THRESHOLD = 15;

export type DeclinedRow = {
  created_at: string;
  reason: DeclinedReason;
  phone_hash: string | null;
};

export type Tally = { total: number; busy: number; distance: number };

export type Range = { startIso: string; endIso: string };

/**
 * A repeat caller counts once per Mon–Sun week: rows sharing a phone hash in
 * the same week collapse to the earliest, which also decides whether it counts
 * as busy or distance. Rows with no phone always count on their own.
 */
export function tally(rows: DeclinedRow[]): Tally {
  const sorted = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const seen = new Set<string>();
  const out: Tally = { total: 0, busy: 0, distance: 0 };

  for (const row of sorted) {
    if (row.phone_hash) {
      const key = `${mondayDateKey(new Date(row.created_at))}:${row.phone_hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.total += 1;
    out[row.reason] += 1;
  }
  return out;
}

export function inRange(rows: DeclinedRow[], range: Range): DeclinedRow[] {
  const start = Date.parse(range.startIso);
  const end = Date.parse(range.endIso);
  return rows.filter((r) => {
    const t = Date.parse(r.created_at);
    return t >= start && t < end;
  });
}

export function thisWeek(now: Date): Range {
  return weekRange(now, "this");
}

/** The Mon–Sun week before the one `range` starts. */
export function weekBefore(range: Range): Range {
  // One hour before Monday 00:00 is Sunday 23:00 of the previous week under
  // either UTC offset, so weekRange() resolves it without any DST arithmetic.
  return weekRange(new Date(Date.parse(range.startIso) - 60 * 60 * 1000), "this");
}

/** The calendar month (Eastern) containing `now`, from the 1st up to `now`. */
export function monthToDate(now: Date): Range {
  const { y, m0 } = localParts(now);
  // Noon UTC on the 1st is the 1st in Eastern under either offset.
  const first = dayRange(new Date(Date.UTC(y, m0, 1, 16, 0, 0)));
  return { startIso: first.startIso, endIso: now.toISOString() };
}

export function weekKey(range: Range): string {
  return mondayDateKey(new Date(range.startIso));
}

/** "Mon, Nov 2 – Sun, Nov 8" style label for a Mon–Sun range. */
export function weekLabel(range: Range): string {
  const sunday = new Date(Date.parse(range.endIso) - 60 * 60 * 1000);
  return `${dayLabelFromKey(weekKey(range))} – ${dayLabelFromKey(localDateKey(sunday))}`;
}

export function formatSplit(t: Tally): string {
  return `busy ${t.busy}, distance ${t.distance}`;
}

/** The single-week verdict against the hiring line. */
export function thresholdLine(total: number): string {
  if (total >= HIRE_THRESHOLD) {
    return `At or over ${HIRE_THRESHOLD} for the week: that is the point to look at another van and plumber.`;
  }
  const short = HIRE_THRESHOLD - total;
  return `Under ${HIRE_THRESHOLD} for the week (${short} short).`;
}

function average(weeks: Tally[]): string {
  const sum = weeks.reduce((n, w) => n + w.total, 0);
  return (sum / weeks.length).toFixed(1);
}

/**
 * The Monday post to the schedule channel. Totals only: no notes, no numbers,
 * no who-logged-what.
 */
export function formatWeeklyReport(rows: DeclinedRow[], now: Date): string {
  const last = weekBefore(thisWeek(now));
  const weeks: Range[] = [last];
  while (weeks.length < 4) weeks.push(weekBefore(weeks[weeks.length - 1]));

  const lastTally = tally(inRange(rows, last));
  const fourWeeks = weeks.map((w) => tally(inRange(rows, w)));
  const mtd = tally(inRange(rows, monthToDate(now)));

  return [
    `*Turned-down calls* — last week (${weekLabel(last)})`,
    `*${lastTally.total}* turned down (${formatSplit(lastTally)})`,
    thresholdLine(lastTally.total),
    "",
    `4-week average: ${average(fourWeeks)} a week (hiring line is ${HIRE_THRESHOLD})`,
    `Month to date: ${mtd.total} (${formatSplit(mtd)})`,
  ].join("\n");
}

/** `/trinity declined week`: this week so far, and last week in full. */
export function formatWeekSummary(rows: DeclinedRow[], now: Date): string {
  const current = thisWeek(now);
  const last = weekBefore(current);
  const cur = tally(inRange(rows, current));
  const prev = tally(inRange(rows, last));
  return [
    `*Turned-down calls*`,
    `This week so far (${weekLabel(current)}): *${cur.total}* (${formatSplit(cur)})`,
    `Last week (${weekLabel(last)}): *${prev.total}* (${formatSplit(prev)}). ${thresholdLine(prev.total)}`,
  ].join("\n");
}

/** The earliest instant any report needs rows from. */
export function reportWindowStart(now: Date): string {
  let w = thisWeek(now);
  for (let i = 0; i < 4; i++) w = weekBefore(w);
  const month = monthToDate(now).startIso;
  return Date.parse(month) < Date.parse(w.startIso) ? month : w.startIso;
}

