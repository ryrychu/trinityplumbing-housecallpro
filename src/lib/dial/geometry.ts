import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { bearingFromAverillPark, compassDirectionFromAverillPark } from "@/lib/geo/distance";

// The dispatch dial is a polar plot of the working day: angle is the job's true
// bearing from the shop in Averill Park, radius is its straight-line distance.
// Both are values the app already computes for every job, so the picture is a
// projection of the data rather than an illustration laid over it.
//
// It is an EMPHASIS chart, not a categorical one: every job wears the same
// recessive mark, and colour is spent only on the two things a dispatcher
// actually needs picked out of the field — the farthest job of the day, and
// anything outside the service area. Colouring marks by zone was the obvious
// first idea and it is wrong twice over: six zone hues exceed the three-series
// cap that all-pairs forms (scatter) can keep colourblind-separable, and the
// zone is already implied by where the mark sits.

export interface DialMark {
  id: string;
  /** Unit-circle position, x right / y down, each in -1..1. */
  x: number;
  y: number;
  miles: number;
  bearingDeg: number;
  compass: string;
  /** Outside the routine service radius — the one status meaning on the dial. */
  outside: boolean;
  /** The single farthest job of the day; carries the direct label. */
  farthest: boolean;
  job: TodayScheduleRow;
}

export interface DialModel {
  marks: DialMark[];
  /** Mile values for the three rings, innermost first. */
  rings: number[];
  /** Miles at the outer ring — the radius scale's maximum. */
  outerMiles: number;
  farthest: DialMark | null;
  /** Jobs the dial could not place because the address never geocoded. */
  unplotted: number;
  /** Distinct zones represented among the plotted jobs. */
  zoneCount: number;
}

const OUTSIDE_ZONE = "Outside Service Area";

// Round outer bounds, chosen so the three ring labels are always whole miles.
// The scale adapts to the day: a morning entirely inside Averill Park should
// not be drawn on a 45-mile field where every mark piles into the middle
// eighth of the plot.
const OUTER_LADDER = [15, 30, 45, 60, 90, 120];

export function outerRingFor(farthestMiles: number): number {
  return (
    OUTER_LADDER.find((v) => v >= farthestMiles) ?? Math.ceil(farthestMiles / 30) * 30
  );
}

export function buildDial(jobs: TodayScheduleRow[]): DialModel {
  // A job is plottable only with real coordinates. Town-only jobs still resolve
  // a zone (see zoneForTown) but have no bearing and no distance, so they are
  // counted out loud rather than quietly dropped — a dial showing five marks
  // for an eight-job day, with nothing saying so, is a lie by omission.
  const plottable = jobs.filter(
    (j) => j.lat != null && j.lng != null && j.miles != null
  );

  const farthestMiles = plottable.reduce((m, j) => Math.max(m, j.miles ?? 0), 0);
  const outerMiles = outerRingFor(farthestMiles);
  const rings = [outerMiles / 3, (outerMiles * 2) / 3, outerMiles];

  // Ties go to the first job of the day: `farthest` drives a single direct
  // label, and two labels stacked on one another would be worse than one.
  const farthestId =
    plottable.length > 0
      ? plottable.reduce((a, b) => ((b.miles ?? 0) > (a.miles ?? 0) ? b : a)).id
      : null;

  const marks: DialMark[] = plottable.map((job) => {
    const lat = job.lat as number;
    const lng = job.lng as number;
    const miles = job.miles as number;
    const bearingDeg = bearingFromAverillPark(lat, lng);
    const theta = (bearingDeg * Math.PI) / 180;
    // Radius is linear in miles, deliberately. A sqrt or log radius would
    // spread a close-in cluster out prettily and in doing so erase the fact
    // that the whole day is within ten minutes of the shop, which is exactly
    // what a dispatcher is looking at the dial to find out.
    const r = Math.min(1, miles / outerMiles);
    return {
      id: job.id,
      x: r * Math.sin(theta),
      y: -r * Math.cos(theta),
      miles,
      bearingDeg,
      compass: job.compass || compassDirectionFromAverillPark(lat, lng),
      outside: job.zone === OUTSIDE_ZONE,
      farthest: job.id === farthestId,
      job,
    };
  });

  return {
    marks,
    rings,
    outerMiles,
    farthest: marks.find((m) => m.farthest) ?? null,
    unplotted: jobs.length - plottable.length,
    zoneCount: new Set(plottable.map((j) => j.zone)).size,
  };
}
