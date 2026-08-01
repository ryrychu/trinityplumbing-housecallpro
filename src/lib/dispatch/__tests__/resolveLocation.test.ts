import { describe, it, expect, vi, beforeEach } from "vitest";

const { ilikeMock, geocodeViaCensusMock } = vi.hoisted(() => ({
  ilikeMock: vi.fn(),
  geocodeViaCensusMock: vi.fn(),
}));

// The town query chains .select().ilike().not().limit(); only the terminal
// limit() resolves, so each link returns the same builder object.
vi.mock("@/lib/supabase/client", () => {
  const builder = {
    select: () => builder,
    ilike: (...args: unknown[]) => {
      ilikeMock(...args);
      return builder;
    },
    not: () => builder,
    limit: () => ilikeMock.mock.results.at(-1)?.value,
  };
  return { getSupabaseServerClient: () => ({ from: () => builder }) };
});

vi.mock("@/lib/geo/geocode", async (importOriginal) => ({
  // normalizeAddressKey stays real — it encodes the geocoder's actual minimum,
  // and a mock of it would let a query through that production would reject.
  ...(await importOriginal<typeof import("@/lib/geo/geocode")>()),
  geocodeViaCensus: geocodeViaCensusMock,
}));

import { resolveLocation } from "../resolveLocation";

function townReturns(rows: Array<{ lat: number; lng: number }>) {
  ilikeMock.mockReturnValue({
    data: rows.map((r) => ({ service_address_lat: r.lat, service_address_lng: r.lng })),
    error: null,
  });
}

describe("resolveLocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    geocodeViaCensusMock.mockResolvedValue(null);
  });

  describe("a bare town", () => {
    it("averages the coordinates of past jobs there", async () => {
      townReturns([
        { lat: 42.6, lng: -73.8 },
        { lat: 42.8, lng: -73.6 },
      ]);

      const out = await resolveLocation("Delmar");

      expect(out).toMatchObject({ via: "town", label: "Delmar", sampleSize: 2 });
      expect(out?.coords.lat).toBeCloseTo(42.7, 5);
      expect(out?.coords.lng).toBeCloseTo(-73.7, 5);
    });

    // The town is whatever was typed at booking, so casing varies in the data.
    it("matches case-insensitively", async () => {
      townReturns([{ lat: 42.6, lng: -73.8 }]);

      await resolveLocation("DELMAR");

      expect(ilikeMock).toHaveBeenCalledWith("raw->address->>city", "DELMAR");
    });

    // Never geocoding a town is the point: it costs a network call and the
    // Census one-line endpoint is unreliable without a street.
    it("does not fall through to the geocoder when the town is known", async () => {
      townReturns([{ lat: 42.6, lng: -73.8 }]);

      await resolveLocation("Delmar");

      expect(geocodeViaCensusMock).not.toHaveBeenCalled();
    });

    // "We have never worked there" is a real answer, not an error.
    it("returns null for a town with no history", async () => {
      townReturns([]);
      expect(await resolveLocation("Nowhere")).toBeNull();
    });

    it("ignores rows whose coordinates never resolved", async () => {
      ilikeMock.mockReturnValue({
        data: [
          { service_address_lat: null, service_address_lng: null },
          { service_address_lat: 42.6, service_address_lng: -73.8 },
        ],
        error: null,
      });

      const out = await resolveLocation("Delmar");

      expect(out?.sampleSize).toBe(1);
      expect(out?.coords.lat).toBeCloseTo(42.6, 5);
    });
  });

  describe("a street address", () => {
    it("geocodes it rather than treating it as a town", async () => {
      geocodeViaCensusMock.mockResolvedValue({ lat: 42.62, lng: -73.83 });

      const out = await resolveLocation("12 Elm St, Delmar, NY 12054");

      expect(out).toMatchObject({ via: "address", coords: { lat: 42.62, lng: -73.83 } });
      expect(geocodeViaCensusMock).toHaveBeenCalledWith({
        street: "12 Elm St",
        city: "Delmar",
        state: "NY",
        zip: "12054",
      });
      expect(ilikeMock).not.toHaveBeenCalled();
    });

    it("assumes New York when no state is given", async () => {
      geocodeViaCensusMock.mockResolvedValue({ lat: 1, lng: 2 });

      await resolveLocation("12 Elm St, Delmar");

      expect(geocodeViaCensusMock).toHaveBeenCalledWith(
        expect.objectContaining({ state: "NY", zip: null })
      );
    });

    // A leading house number means an address even without a comma.
    it("treats a leading house number as an address", async () => {
      await resolveLocation("12 Elm Street");
      expect(ilikeMock).not.toHaveBeenCalled();
    });

    it("returns null when the geocoder finds no match", async () => {
      geocodeViaCensusMock.mockResolvedValue(null);
      expect(await resolveLocation("999 Nonexistent Rd, Delmar")).toBeNull();
    });
  });

  it("returns null for an empty query without touching the database", async () => {
    expect(await resolveLocation("   ")).toBeNull();
    expect(ilikeMock).not.toHaveBeenCalled();
    expect(geocodeViaCensusMock).not.toHaveBeenCalled();
  });

  it("surfaces a database failure instead of reporting 'town not found'", async () => {
    ilikeMock.mockReturnValue({ data: null, error: { message: "connection refused" } });
    await expect(resolveLocation("Delmar")).rejects.toThrow(/connection refused/);
  });
});
