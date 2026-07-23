// Geocoding for the Geographic Scheduling Assistant. HCP addresses have no
// coordinates (Task 0), so we geocode street/city/state/zip -> lat/lng via the
// free US Census geocoder (no API key) and cache results in `geocode_cache`.
//
// Deliberately generic: callers supply the rows and which fields to populate,
// so this module has no dependency on Housecall Pro resource shapes.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AddressParts {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface Coords {
  lat: number;
  lng: number;
}

export interface GeocodeTarget {
  row: Record<string, unknown>;
  parts: AddressParts;
  latField: string;
  lngField: string;
}

// A run-wide cap on how many *network* geocode calls a single sync performs, so
// a large first backfill does not exceed the serverless function timeout. Cache
// hits are free and never counted. The cache fills over successive runs; the
// one-time bulk backfill is best run locally where there is no timeout.
export interface GeocodeBudget {
  remaining: number;
}

export interface GeocodeStats {
  attempted: number; // network calls made this pass
  cacheHits: number; // distinct addresses served from cache
  applied: number; // rows that received coordinates
  remaining: number; // geocodable addresses still uncached after this pass
}

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const CENSUS_BENCHMARK = "Public_AR_Current";
const GEOCODE_CONCURRENCY = 8;
const CENSUS_TIMEOUT_MS = 10_000;
const CACHE_IN_CHUNK = 200;

// A normalized cache key, or null when there is not enough address to geocode
// meaningfully (need a street plus at least a city or a zip).
export function normalizeAddressKey(a: AddressParts): string | null {
  const street = (a.street ?? "").trim();
  const city = (a.city ?? "").trim();
  const state = (a.state ?? "").trim();
  const zip = (a.zip ?? "").trim();
  if (!street) return null;
  if (!city && !zip) return null;
  return [street, city, state, zip].filter(Boolean).join(", ").toLowerCase();
}

function oneLine(a: AddressParts): string {
  return [a.street, a.city, a.state, a.zip]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

// Returns coordinates, or null for a definitive "no match" (HTTP 200 with an
// empty match list). THROWS on transient failures (network, non-200, timeout)
// so the caller can leave the address uncached and retry on the next run.
export async function geocodeViaCensus(a: AddressParts): Promise<Coords | null> {
  const address = oneLine(a);
  if (!address) return null;

  const url = `${CENSUS_URL}?address=${encodeURIComponent(address)}&benchmark=${CENSUS_BENCHMARK}&format=json`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(CENSUS_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Census geocoder error ${res.status}`);
  }

  const json = (await res.json()) as {
    result?: { addressMatches?: Array<{ coordinates?: { x?: number; y?: number } }> };
  };
  const coords = json.result?.addressMatches?.[0]?.coordinates;
  if (!coords || typeof coords.x !== "number" || typeof coords.y !== "number") {
    return null; // definitive no-match
  }
  return { lat: coords.y, lng: coords.x }; // Census: x = longitude, y = latitude
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Cache-first geocoding for a batch of rows. Fills each target's lat/lng fields
// in place. Only cache misses hit the network, capped by `budget.remaining`
// across the whole run (mutated as calls are spent).
export async function enrichRowsWithGeocode(
  supabase: SupabaseClient,
  targets: GeocodeTarget[],
  budget: GeocodeBudget
): Promise<GeocodeStats> {
  const stats: GeocodeStats = { attempted: 0, cacheHits: 0, applied: 0, remaining: 0 };

  // 1. Key each target; drop those without enough address to geocode.
  const keyed = targets
    .map((t) => ({ t, key: normalizeAddressKey(t.parts) }))
    .filter((x): x is { t: GeocodeTarget; key: string } => x.key !== null);
  if (keyed.length === 0) return stats;

  const distinctKeys = Array.from(new Set(keyed.map((x) => x.key)));
  const partsByKey = new Map<string, AddressParts>();
  for (const { t, key } of keyed) if (!partsByKey.has(key)) partsByKey.set(key, t.parts);

  // 2. Batch-load the cache for these keys.
  const coordsByKey = new Map<string, Coords | null>();
  for (const keys of chunk(distinctKeys, CACHE_IN_CHUNK)) {
    const { data } = await supabase
      .from("geocode_cache")
      .select("address_key, lat, lng, status")
      .in("address_key", keys);
    for (const r of (data ?? []) as Array<{
      address_key: string;
      lat: number | null;
      lng: number | null;
      status: string;
    }>) {
      coordsByKey.set(
        r.address_key,
        r.status === "found" && r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null
      );
    }
  }

  // 3. Geocode misses, up to the run budget.
  const misses = distinctKeys.filter((k) => !coordsByKey.has(k));
  stats.cacheHits = distinctKeys.length - misses.length;
  const toGeocode = misses.slice(0, Math.max(0, budget.remaining));
  stats.attempted = toGeocode.length;
  stats.remaining = misses.length - toGeocode.length;
  budget.remaining -= toGeocode.length;

  const newRows: Array<{
    address_key: string;
    lat: number | null;
    lng: number | null;
    status: string;
    geocoded_at: string;
  }> = [];
  const nowIso = new Date().toISOString();

  await mapWithConcurrency(toGeocode, GEOCODE_CONCURRENCY, async (key) => {
    const parts = partsByKey.get(key);
    if (!parts) return;
    try {
      const coords = await geocodeViaCensus(parts);
      coordsByKey.set(key, coords);
      newRows.push({
        address_key: key,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        status: coords ? "found" : "not_found",
        geocoded_at: nowIso,
      });
    } catch {
      // Transient failure — leave uncached so the next run retries.
    }
  });

  // 4. Persist newly geocoded results.
  if (newRows.length > 0) {
    await supabase.from("geocode_cache").upsert(newRows);
  }

  // 5. Apply coordinates to rows.
  for (const { t, key } of keyed) {
    const coords = coordsByKey.get(key);
    if (coords) {
      t.row[t.latField] = coords.lat;
      t.row[t.lngField] = coords.lng;
      stats.applied++;
    }
  }

  return stats;
}
