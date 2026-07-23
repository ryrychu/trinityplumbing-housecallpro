import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeAddressKey,
  geocodeViaCensus,
  enrichRowsWithGeocode,
  type GeocodeTarget,
} from "../geocode";

const originalFetch = global.fetch;

const FULL = { street: "123 Main St", city: "Delmar", state: "NY", zip: "12054" };
const FULL_KEY = "123 main st, delmar, ny, 12054";

describe("normalizeAddressKey", () => {
  it("builds a lowercased canonical key from full parts", () => {
    expect(normalizeAddressKey(FULL)).toBe(FULL_KEY);
  });

  it("returns null without a street", () => {
    expect(normalizeAddressKey({ city: "Delmar", state: "NY", zip: "12054" })).toBeNull();
  });

  it("returns null with a street but neither city nor zip", () => {
    expect(normalizeAddressKey({ street: "123 Main St", state: "NY" })).toBeNull();
  });

  it("accepts a street plus a zip (no city)", () => {
    expect(normalizeAddressKey({ street: "123 Main St", zip: "12054" })).toBe("123 main st, 12054");
  });
});

function censusMatch(x: number, y: number) {
  return { ok: true, json: async () => ({ result: { addressMatches: [{ coordinates: { x, y } }] } }) };
}
function censusNoMatch() {
  return { ok: true, json: async () => ({ result: { addressMatches: [] } }) };
}

describe("geocodeViaCensus", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("maps Census coordinates (x=lng, y=lat) into lat/lng", async () => {
    global.fetch = vi.fn().mockResolvedValue(censusMatch(-73.8365, 42.6217));
    const coords = await geocodeViaCensus(FULL);
    expect(coords).toEqual({ lat: 42.6217, lng: -73.8365 });
  });

  it("returns null for a definitive no-match (empty matches)", async () => {
    global.fetch = vi.fn().mockResolvedValue(censusNoMatch());
    expect(await geocodeViaCensus(FULL)).toBeNull();
  });

  it("throws on a non-ok response (transient)", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(geocodeViaCensus(FULL)).rejects.toThrow(/503/);
  });
});

// Minimal Supabase mock: from().select().in() resolves cache rows; from().upsert()
// captures written cache rows.
function makeSupabaseMock(cacheRows: unknown[], upsertSpy: (rows: unknown) => void) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn(async () => ({ data: cacheRows, error: null })),
      })),
      upsert: vi.fn(async (rows: unknown) => {
        upsertSpy(rows);
        return { error: null };
      }),
    })),
  } as unknown as SupabaseClient;
}

function target(row: Record<string, unknown>): GeocodeTarget {
  return { row, parts: FULL, latField: "lat", lngField: "lng" };
}

describe("enrichRowsWithGeocode", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("applies cached coordinates without hitting the network", async () => {
    global.fetch = vi.fn();
    const supabase = makeSupabaseMock(
      [{ address_key: FULL_KEY, lat: 1.1, lng: 2.2, status: "found" }],
      () => {}
    );
    const row: Record<string, unknown> = { id: "c1", lat: null, lng: null };
    const budget = { remaining: 5 };

    const stats = await enrichRowsWithGeocode(supabase, [target(row)], budget);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(row.lat).toBe(1.1);
    expect(row.lng).toBe(2.2);
    expect(stats.cacheHits).toBe(1);
    expect(stats.attempted).toBe(0);
    expect(budget.remaining).toBe(5);
  });

  it("geocodes a cache miss, writes the cache, and applies the result", async () => {
    global.fetch = vi.fn().mockResolvedValue(censusMatch(-73.8365, 42.6217));
    let written: unknown;
    const supabase = makeSupabaseMock([], (rows) => (written = rows));
    const row: Record<string, unknown> = { id: "c1", lat: null, lng: null };
    const budget = { remaining: 5 };

    const stats = await enrichRowsWithGeocode(supabase, [target(row)], budget);

    expect(row.lat).toBe(42.6217);
    expect(row.lng).toBe(-73.8365);
    expect(stats.attempted).toBe(1);
    expect(stats.applied).toBe(1);
    expect(budget.remaining).toBe(4);
    expect(written).toEqual([
      expect.objectContaining({ address_key: FULL_KEY, lat: 42.6217, lng: -73.8365, status: "found" }),
    ]);
  });

  it("caps network calls at the run budget, leaving the rest for next run", async () => {
    global.fetch = vi.fn().mockResolvedValue(censusMatch(-73.8, 42.6));
    const supabase = makeSupabaseMock([], () => {});
    const rowA: Record<string, unknown> = { id: "a", lat: null };
    const rowB: Record<string, unknown> = { id: "b", lat: null };
    const budget = { remaining: 1 };

    const stats = await enrichRowsWithGeocode(
      supabase,
      [
        { row: rowA, parts: { street: "1 A St", city: "Albany", state: "NY", zip: "12207" }, latField: "lat", lngField: "lng" },
        { row: rowB, parts: { street: "2 B St", city: "Troy", state: "NY", zip: "12180" }, latField: "lat", lngField: "lng" },
      ],
      budget
    );

    expect(stats.attempted).toBe(1);
    expect(stats.remaining).toBe(1);
    expect(budget.remaining).toBe(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not apply coordinates for a cached not_found address", async () => {
    global.fetch = vi.fn();
    const supabase = makeSupabaseMock(
      [{ address_key: FULL_KEY, lat: null, lng: null, status: "not_found" }],
      () => {}
    );
    const row: Record<string, unknown> = { id: "c1", lat: null, lng: null };

    const stats = await enrichRowsWithGeocode(supabase, [target(row)], { remaining: 5 });

    expect(row.lat).toBeNull();
    expect(stats.applied).toBe(0);
    expect(stats.cacheHits).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("skips targets without enough address and never touches the DB", async () => {
    const fromSpy = vi.fn();
    const supabase = { from: fromSpy } as unknown as SupabaseClient;
    const row: Record<string, unknown> = { id: "c1" };

    const stats = await enrichRowsWithGeocode(
      supabase,
      [{ row, parts: { city: "Delmar" }, latField: "lat", lngField: "lng" }],
      { remaining: 5 }
    );

    expect(fromSpy).not.toHaveBeenCalled();
    expect(stats.attempted).toBe(0);
    expect(stats.applied).toBe(0);
  });
});
