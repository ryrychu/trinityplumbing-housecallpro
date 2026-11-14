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
  /** One-line description for the Monday list. Built in memory, never stored. */
  label?: string;
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
  return { startIso: monthStartIso(y, m0), endIso: now.toISOString() };
}

// Midnight Eastern on the 1st of month m0 (any integer; Date.UTC rolls -1 back
// to December of the year before). 16:00 UTC is the 1st in Eastern under
// either offset, so dayRange() finds that day's midnight without DST math.
function monthStartIso(y: number, m0: number): string {
  return dayRange(new Date(Date.UTC(y, m0, 1, 16, 0, 0))).startIso;
}

/** The whole calendar month (Eastern) before the one containing `now`. */
export function lastMonth(now: Date): Range {
  const { y, m0 } = localParts(now);
  return { startIso: monthStartIso(y, m0 - 1), endIso: monthStartIso(y, m0) };
}

/** The calendar month before the one `range` starts in. */
export function monthBefore(range: Range): Range {
  return lastMonth(new Date(range.startIso));
}

/** "2026-10", Eastern. The monthly post's claim key. */
export function monthKey(range: Range): string {
  const { y, m0 } = localParts(new Date(range.startIso));
  return `${y}-${String(m0 + 1).padStart(2, "0")}`;
}

/** "October 2026". */
export function monthLabel(range: Range): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "long", year: "numeric" }).format(
    new Date(range.startIso)
  );
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

/** At most this many calls are listed in the Monday post; the rest are summed up. */
export const LIST_MAX = 25;

function times(n: number): string {
  return n === 2 ? "called twice" : `called ${n} times`;
}

/**
 * One bullet per counted call, oldest first, with repeat callers (same phone
 * hash, same week) folded into their first entry. Same grouping as tally(),
 * so the list length always equals the total.
 */
export function callLines(rows: DeclinedRow[]): string[] {
  const sorted = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const entries: Array<{ label: string; count: number }> = [];
  const byKey = new Map<string, { label: string; count: number }>();

  for (const row of sorted) {
    const key = row.phone_hash ? `${mondayDateKey(new Date(row.created_at))}:${row.phone_hash}` : null;
    const existing = key ? byKey.get(key) : undefined;
    if (existing) {
      existing.count += 1;
      continue;
    }
    const entry = { label: row.label ?? "(no details)", count: 1 };
    entries.push(entry);
    if (key) byKey.set(key, entry);
  }

  const lines = entries.map((e) => `• ${e.label}${e.count > 1 ? ` (${times(e.count)})` : ""}`);
  if (lines.length <= LIST_MAX) return lines;
  return [...lines.slice(0, LIST_MAX), `… and ${lines.length - LIST_MAX} more`];
}

// The post body shared by the Monday report and its preview: a bold heading,
// one line per call in `week`, then the totals. The 4-week average is always
// over the four complete weeks ending with last week.
function formatCallReport(rows: DeclinedRow[], now: Date, week: Range, heading: (count: string) => string): string {
  const last = weekBefore(thisWeek(now));
  const weeks: Range[] = [last];
  while (weeks.length < 4) weeks.push(weekBefore(weeks[weeks.length - 1]));

  const weekRows = inRange(rows, week);
  const weekTally = tally(weekRows);
  const average = weeks.reduce((n, w) => n + tally(inRange(rows, w)).total, 0) / weeks.length;
  const mtd = tally(inRange(rows, monthToDate(now)));

  return [
    heading(calls(weekTally.total)),
    ...callLines(weekRows),
    `${thresholdLine(weekTally.total)} 4-week average: ${average.toFixed(1)} a week. ${monthName(now)} so far: ${mtd.total}.`,
  ].join("\n");
}

/**
 * The Monday post to #declined-calls, in the estimates-channel style: a bold
 * count, one line per call, then the totals. Customer details are fine here
 * (Dave's call); they come from the forwarded messages, in memory only.
 */
export function formatWeeklyReport(rows: DeclinedRow[], now: Date): string {
  const last = weekBefore(thisWeek(now));
  return formatCallReport(rows, now, last, (n) => `*${n} last week (${weekLabel(last)})*`);
}

/** `/trinity declined preview`: the same post for this week so far, Monday to now. */
export function formatPreview(rows: DeclinedRow[], now: Date): string {
  const current = thisWeek(now);
  const soFar = { startIso: current.startIso, endIso: now.toISOString() };
  return formatCallReport(rows, now, soFar, (n) => `*Preview: ${n} this week so far (${weekLabel(current)})*`);
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

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Calls a week over `range`, so a month reads against the 15-a-week line.
function perWeek(total: number, range: Range): string {
  const weeks = (Date.parse(range.endIso) - Date.parse(range.startIso)) / WEEK_MS;
  return weeks > 0 ? (total / weeks).toFixed(1) : "0.0";
}

/** "Up 4 from September (19)." against the month before. */
export function comparisonLine(current: number, previous: number, previousName: string): string {
  const diff = current - previous;
  if (diff === 0) return `Same as ${previousName} (${previous}).`;
  return `${diff > 0 ? "Up" : "Down"} ${Math.abs(diff)} from ${previousName} (${previous}).`;
}

/**
 * The post on the 1st to the monthly channel: last month's calls, one line
 * each (same lines and 25-line cap as the Monday post), then the change from
 * the month before and the weekly rate. Counting is the Monday post's: a
 * repeat caller counts once per Mon–Sun week, so a month is never less than
 * the sum of its whole weeks.
 */
export function formatMonthlyReport(rows: DeclinedRow[], now: Date): string {
  const month = lastMonth(now);
  const prior = monthBefore(month);
  const monthRows = inRange(rows, month);
  const total = tally(monthRows).total;
  const previous = tally(inRange(rows, prior)).total;
  return [
    `*${calls(total)} last month (${monthLabel(month)})*`,
    ...callLines(monthRows),
    `${comparisonLine(total, previous, monthName(new Date(prior.startIso)))} About ${perWeek(total, month)} a week.`,
  ].join("\n");
}

/** `/trinity declined preview month`: this month so far, the 1st to now. */
export function formatMonthPreview(rows: DeclinedRow[], now: Date): string {
  const soFar = monthToDate(now);
  const prior = monthBefore(soFar);
  const monthRows = inRange(rows, soFar);
  const total = tally(monthRows).total;
  return [
    `*Preview: ${calls(total)} this month so far (${monthLabel(soFar)})*`,
    ...callLines(monthRows),
    `${monthName(new Date(prior.startIso))} in full: ${tally(inRange(rows, prior)).total}. About ${perWeek(total, soFar)} a week so far.`,
  ].join("\n");
}
