// Counting and wording for declined calls. Pure: rows and a clock in, numbers
// and strings out, so the rules Dave's hiring decision rests on are testable
// without a database or Slack.
//
// Rows come from two places: forwards into #declined-calls (reason null, since
// a forward carries no reason and this does not guess one) and
// `/trinity declined busy|distance` entries. They are counted together.
//
// Weeks are Trinity's Mon–Sun in America/New_York, taken from
// src/lib/dashboard/week.ts so this count and the schedule digests can never
// disagree about which week a Sunday-night call belongs to.
import { weekRange, dayRange, localParts } from "@/lib/dashboard/week";
import { localDateKey, mondayDateKey } from "@/lib/notifications/schedule";
import type { DeclinedReason } from "./parse";

/** About this many a week means another van and another plumber. */
export const HIRE_THRESHOLD = 15;

const TZ = "America/New_York";

export type DeclinedRow = {
  created_at: string;
  /** null for a #declined-calls forward. */
  reason: DeclinedReason | null;
  phone_hash: string | null;
};

/** busy and distance count command entries only; the rest are channel forwards. */
export type Tally = { total: number; busy: number; distance: number };

export type Range = { startIso: string; endIso: string };

/**
 * A repeat caller counts once per Mon–Sun week: rows sharing a phone hash in
 * the same week collapse to the earliest, whichever source it came from. So a
 * call both forwarded and logged with /trinity counts once. Rows with no
 * phone always count on their own.
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
    if (row.reason) out[row.reason] += 1;
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
  // 16:00 UTC on the 1st is the 1st in Eastern under either offset.
  const first = dayRange(new Date(Date.UTC(y, m0, 1, 16, 0, 0)));
  return { startIso: first.startIso, endIso: now.toISOString() };
}

export function weekKey(range: Range): string {
  return mondayDateKey(new Date(range.startIso));
}

function monthDay(dateKey: string): { month: string; day: number } {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return {
    month: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" }).format(d),
    day: d.getUTCDate(),
  };
}

/** "Nov 2–8", or "Oct 26–Nov 1" across a month end. */
export function weekLabel(range: Range): string {
  const mon = monthDay(weekKey(range));
  const sun = monthDay(localDateKey(new Date(Date.parse(range.endIso) - 60 * 60 * 1000)));
  return mon.month === sun.month
    ? `${mon.month} ${mon.day}–${sun.day}`
    : `${mon.month} ${mon.day}–${sun.month} ${sun.day}`;
}

function monthName(now: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "long" }).format(now);
}

function calls(n: number): string {
  return `${n} ${n === 1 ? "call" : "calls"} declined`;
}

/** The single-week verdict against the hiring line. */
export function thresholdLine(total: number): string {
  if (total >= HIRE_THRESHOLD) {
    return `At or over ${HIRE_THRESHOLD} for the week: time to look at another van and plumber.`;
  }
  return `Under ${HIRE_THRESHOLD} for the week (${HIRE_THRESHOLD - total} short).`;
}

// Only when /trinity entries were counted: forwards have no reason, so the
// split covers just the entries that do.
function commandLine(t: Tally): string | null {
  const logged = t.busy + t.distance;
  if (logged === 0) return null;
  return `Includes ${logged} logged with /trinity declined (busy ${t.busy}, distance ${t.distance}).`;
}

/** The earliest instant the weekly report needs rows from. */
export function reportWindowStart(now: Date): string {
  let w = thisWeek(now);
  for (let i = 0; i < 4; i++) w = weekBefore(w);
  const month = monthToDate(now).startIso;
  return Date.parse(month) < Date.parse(w.startIso) ? month : w.startIso;
}

/**
 * The Monday post to #declined-calls. Totals only: no names, numbers, notes or
 * who logged what.
 */
export function formatWeeklyReport(rows: DeclinedRow[], now: Date): string {
  const last = weekBefore(thisWeek(now));
  const weeks: Range[] = [last];
  while (weeks.length < 4) weeks.push(weekBefore(weeks[weeks.length - 1]));

  const lastTally = tally(inRange(rows, last));
  const average = weeks.reduce((n, w) => n + tally(inRange(rows, w)).total, 0) / weeks.length;
  const mtd = tally(inRange(rows, monthToDate(now)));

  return [
    `*Last week (${weekLabel(last)}): ${calls(lastTally.total)}.* ${thresholdLine(lastTally.total)}`,
    commandLine(lastTally),
    `4-week average: ${average.toFixed(1)} a week.`,
    `${monthName(now)} so far: ${mtd.total}.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** `/trinity declined week`: this week so far, and last week in full. */
export function formatWeekSummary(rows: DeclinedRow[], now: Date): string {
  const current = thisWeek(now);
  const last = weekBefore(current);
  const cur = tally(inRange(rows, current));
  const prev = tally(inRange(rows, last));
  return [
    `This week so far (${weekLabel(current)}): ${calls(cur.total)}.`,
    commandLine(cur),
    `Last week (${weekLabel(last)}): ${calls(prev.total)}. ${thresholdLine(prev.total)}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** The one-line running total after logging or undoing. */
export function runningTotal(rows: DeclinedRow[], now: Date): string {
  return `This week so far: ${calls(tally(inRange(rows, thisWeek(now))).total)}.`;
}
