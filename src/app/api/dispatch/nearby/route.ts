import { NextResponse } from "next/server";
import { resolveLocation } from "@/lib/dispatch/resolveLocation";
import {
  findNearbyWork,
  describeDay,
  detourMinutes,
  DEFAULT_RADIUS_MILES,
  DEFAULT_HORIZON_DAYS,
} from "@/lib/dispatch/nearby";

// A town lookup is one indexed query; an address lookup adds a Census call.
// Both are well inside this, which exists only so a cold start plus a slow
// geocoder does not hit the interactive default.
export const maxDuration = 30;

const MAX_HORIZON_DAYS = 60;
const MAX_RADIUS_MILES = 100;

function clampNumber(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const query = (params.get("q") ?? "").trim();

  if (!query) {
    return NextResponse.json({ error: "Enter a town or address" }, { status: 400 });
  }

  const radiusMiles = clampNumber(params.get("radius"), DEFAULT_RADIUS_MILES, 1, MAX_RADIUS_MILES);
  const days = clampNumber(params.get("days"), DEFAULT_HORIZON_DAYS, 1, MAX_HORIZON_DAYS);

  let location;
  try {
    location = await resolveLocation(query);
  } catch (err) {
    return NextResponse.json(
      { error: `Lookup failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }

  if (!location) {
    // Said plainly, because the most common cause is a town Trinity has never
    // worked in — which is itself the answer to "are we already going there".
    return NextResponse.json(
      {
        error: `Couldn't place "${query}". No past jobs in that town, and it didn't geocode as an address — try a full street address.`,
      },
      { status: 404 }
    );
  }

  const rawDays = await findNearbyWork(location.coords, { radiusMiles, days });

  const withSummary = rawDays.map((d) => ({
    ...d,
    summary: describeDay(d),
    detourMinutes: detourMinutes(d),
  }));

  return NextResponse.json({
    location,
    radiusMiles,
    days,
    // Days with something nearby, closest first — the ranking a dispatcher
    // actually wants. The full span stays available for the calendar view.
    matches: withSummary.filter((d) => d.jobs.length > 0),
    all: withSummary,
  });
}
