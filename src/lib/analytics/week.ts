// Which Mon–Sun weeks a traffic report covers, as the YYYY-MM-DD dates GA4
// takes. Built on the same America/New_York week arithmetic as the declined
// calls post, so DST never shifts a day between weeks.
//
// GA4 reads these dates in each property's own reporting time zone, which
// should be set to Eastern (GA4 Admin → Property details).
import { localDateKey } from "@/lib/notifications/schedule";
import { thisWeek, weekBefore, weekKey, weekLabel, type Range } from "@/lib/declined/tally";

export type ReportWeek = { startDate: string; endDate: string; label: string; key: string };
export type ReportWeeks = { week: ReportWeek; previousWeek: ReportWeek };

function toWeek(range: Range): ReportWeek {
  // An hour before the exclusive end is late Sunday under either UTC offset.
  const sunday = localDateKey(new Date(Date.parse(range.endIso) - 60 * 60 * 1000));
  return { startDate: weekKey(range), endDate: sunday, label: weekLabel(range), key: weekKey(range) };
}

/** weeksAgo 0 is the last full Mon–Sun week before `now`; previousWeek is the one before it. */
export function reportWeeks(now: Date, weeksAgo = 0): ReportWeeks {
  let week = weekBefore(thisWeek(now));
  for (let i = 0; i < weeksAgo; i++) week = weekBefore(week);
  return { week: toWeek(week), previousWeek: toWeek(weekBefore(week)) };
}
