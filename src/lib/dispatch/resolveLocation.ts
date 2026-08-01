// Turning what a dispatcher types into coordinates.
//
// Two strategies, in order, because the two things they might type behave very
// differently:
//
//   1. A bare town ("Delmar") — resolved to the mean coordinate of jobs
//      Trinity has already done there. The Census one-line geocoder is built
//      for street addresses and is unreliable on a town alone, and a static
//      town→lat/lng table would be one more list to maintain. Every town
//      Trinity actually serves already has dozens of geocoded jobs in it, so
//      the data to answer this is sitting in the table for free — and a town
//      with no history correctly resolves to nothing.
//
//   2. A full street address ("12 Elm St, Delmar") — geocoded through the
//      existing cached Census path, so a repeat lookup of the same address
//      costs nothing and the cache is shared with the sync.
import { getSupabaseServerClient } from "@/lib/supabase/client";
import { geocodeViaCensus, normalizeAddressKey } from "@/lib/geo/geocode";
import type { Coords } from "./nearby";

export interface ResolvedLocation {
  coords: Coords;
  // What the resolution actually keyed on, echoed back so the UI can show
  // "Delmar (from 34 past jobs)" rather than implying an exact address match.
  label: string;
  via: "town" | "address";
  // Town resolution only: how many past jobs formed the centroid. Surfaced
  // because a centroid from two jobs is a much weaker claim than one from
  // fifty, and the dispatcher should be able to see which they got.
  sampleSize?: number;
}

// PostgREST caps responses at 1000 rows; jobs are well past that, so the town
// lookup must not be a bare select. It filters server-side on the city inside
// `raw`, which keeps the result small enough to never page.
const TOWN_SAMPLE_CAP = 500;

async function resolveTown(town: string): Promise<ResolvedLocation | null> {
  const supabase = getSupabaseServerClient();

  // ->> extracts the city as text so the comparison is a plain string match.
  // `ilike` rather than `eq` because HCP stores whatever was typed at booking:
  // "delmar", "Delmar", "DELMAR" all occur.
  const { data, error } = await supabase
    .from("jobs")
    .select("service_address_lat, service_address_lng, raw->address->>city")
    .ilike("raw->address->>city", town)
    .not("service_address_lat", "is", null)
    .limit(TOWN_SAMPLE_CAP);

  if (error) {
    throw new Error(`Town lookup failed: ${error.message}`);
  }

  const points = (data ?? []) as Array<{
    service_address_lat: number | null;
    service_address_lng: number | null;
  }>;
  const usable = points.filter(
    (p) => p.service_address_lat != null && p.service_address_lng != null
  );
  if (usable.length === 0) return null;

  // Mean of the points. Averaging raw degrees is wrong near the poles and
  // across the antimeridian; at Trinity's latitude, over a single town, it is
  // accurate to well under the rounding this feature reports.
  const lat = usable.reduce((s, p) => s + (p.service_address_lat as number), 0) / usable.length;
  const lng = usable.reduce((s, p) => s + (p.service_address_lng as number), 0) / usable.length;

  return {
    coords: { lat, lng },
    label: town,
    via: "town",
    sampleSize: usable.length,
  };
}

// Splits "12 Elm St, Delmar, NY" into the parts the geocoder wants. A bare
// street with no comma is geocoded as-is with New York assumed — Trinity's
// service area spans NY, MA and VT, but a dispatcher who omits the state is
// almost always talking about the home state.
function toAddressParts(query: string) {
  const bits = query.split(",").map((s) => s.trim()).filter(Boolean);
  if (bits.length === 1) return { street: bits[0], city: null, state: "NY", zip: null };
  const [street, city, ...rest] = bits;
  const tail = rest.join(" ").trim();
  // "NY 12054" or "NY" or "12054"
  const zip = tail.match(/\b\d{5}\b/)?.[0] ?? null;
  const state = tail.replace(/\b\d{5}\b/, "").trim() || "NY";
  return { street, city: city ?? null, state, zip };
}

export async function resolveLocation(query: string): Promise<ResolvedLocation | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // A bare town first — no network call, and it is what gets typed most.
  // Anything with a comma or a leading house number is an address, not a town.
  const looksLikeAddress = trimmed.includes(",") || /^\d/.test(trimmed);
  if (!looksLikeAddress) {
    const town = await resolveTown(trimmed);
    if (town) return town;
  }

  const parts = toAddressParts(trimmed);
  // normalizeAddressKey encodes the geocoder's real minimum (a street plus a
  // city or zip). Checking it here means an unresolvable query returns null
  // instead of burning a network call to find that out.
  if (!normalizeAddressKey(parts)) {
    // Last resort for something like "Elm Street" with no town: try it as a
    // town name anyway, in case it is one we did not recognize as such.
    return looksLikeAddress ? null : resolveTown(trimmed);
  }

  const coords = await geocodeViaCensus(parts);
  if (!coords) return null;

  return { coords, label: trimmed, via: "address" };
}
