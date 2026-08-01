// "Are we already going near there?" — the Geographic Scheduling Assistant's
// recommendation layer, and the roadmap's own example: *"Already working in
// Delmar Tuesday afternoon."*
//
// Deliberately NOT a route optimizer. The live account has zero jobs in
// `needs scheduling` (the go-live status census sums to exactly 3,038 across
// the six other statuses), so there is no queue of unscheduled work for a
// batch optimizer to arrange. Trinity schedules at the moment of booking,
// which means the useful shape is a lookup for whoever is on the phone: given
// where the customer is, which of the next N days already has work nearby.
import { getScheduleDays, type TodayScheduleRow } from "@/lib/dashboard/queries";
import { milesBetween, driveMinutesForMiles } from "@/lib/geo/distance";
import { localParts } from "@/lib/dashboard/week";

export interface Coords {
  lat: number;
  lng: number;
}

export interface NearbyJob extends TodayScheduleRow {
  // Straight-line miles from the searched location to this job.
  milesAway: number;
}

export interface NearbyDay {
  dateKey: string;
  // Nearby jobs only, in time order. A day with none is still returned when
  // `includeEmpty` is set, so the caller can show "nothing near there yet".
  jobs: NearbyJob[];
  // Distance of the closest job that day, or null when there are none. This is
  // what ranks the days.
  nearestMiles: number | null;
  // Every job scheduled that day, near or not. A day already carrying six jobs
  // is a bad day to add a seventh even if one of them is close, and that is
  // invisible if only the nearby ones are counted.
  totalJobs: number;
}

// Far enough that a detour is still worth it on Trinity's roads, tight enough
// that "nearby" keeps meaning something. Tunable per query.
export const DEFAULT_RADIUS_MILES = 12;
export const DEFAULT_HORIZON_DAYS = 14;

export interface NearbyOptions {
  radiusMiles?: number;
  days?: number;
  now?: Date;
}

export async function findNearbyWork(
  target: Coords,
  opts: NearbyOptions = {}
): Promise<NearbyDay[]> {
  const radius = opts.radiusMiles ?? DEFAULT_RADIUS_MILES;
  const days = opts.days ?? DEFAULT_HORIZON_DAYS;
  const now = opts.now ?? new Date();

  const schedule = await getScheduleDays(now, days);

  return schedule.map(({ dateKey, rows }) => {
    const jobs: NearbyJob[] = [];
    for (const row of rows) {
      // A job without coordinates is skipped rather than assumed far: ~200 of
      // 3,038 jobs never geocoded (no street, or a definitive Census no-match),
      // and silently treating those as distant would hide real neighbours.
      // They still count toward totalJobs below.
      if (row.lat == null || row.lng == null) continue;
      const miles = milesBetween(target.lat, target.lng, row.lat, row.lng);
      if (miles <= radius) {
        jobs.push({ ...row, milesAway: Math.round(miles * 10) / 10 });
      }
    }
    jobs.sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
    return {
      dateKey,
      jobs,
      nearestMiles: jobs.length === 0 ? null : Math.min(...jobs.map((j) => j.milesAway)),
      totalJobs: rows.length,
    };
  });
}

// A one-line summary of a day, in the roadmap's own phrasing: "Already working
// in Delmar Tuesday afternoon." Built here rather than in the UI so the Slack
// digest can reuse it verbatim if this ever becomes a notification.
export function describeDay(day: NearbyDay): string | null {
  if (day.jobs.length === 0) return null;

  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
  }).format(new Date(`${day.dateKey}T12:00:00Z`));

  const towns = Array.from(
    new Set(
      day.jobs
        .map((j) => j.address?.split(",").pop()?.trim())
        .filter((t): t is string => !!t)
    )
  );
  const where = towns.length === 0 ? "the area" : towns.slice(0, 2).join(" and ");

  // Morning/afternoon rather than a clock time: the answer to "when could we
  // fit this in" is a half-day, and quoting "1:30 PM" invites treating an
  // existing appointment's exact slot as the one on offer.
  const halves = new Set(
    day.jobs.map((j) => {
      if (!j.scheduledStart) return "sometime";
      return localParts(new Date(j.scheduledStart)).hour < 12 ? "morning" : "afternoon";
    })
  );
  const when = halves.size === 1 ? Array.from(halves)[0] : "through the day";

  return `Already working in ${where} ${weekday} ${when}`;
}

// Drive time from the searched location to the closest job that day. Uses the
// same crude average-speed model as the rest of the geo module, which is
// honest about being a starting estimate rather than a routing result.
export function detourMinutes(day: NearbyDay): number | null {
  return day.nearestMiles == null ? null : driveMinutesForMiles(day.nearestMiles);
}
