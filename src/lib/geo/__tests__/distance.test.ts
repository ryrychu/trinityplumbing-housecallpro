import { describe, it, expect } from "vitest";
import { distanceFromAverillPark } from "../distance";

describe("distanceFromAverillPark", () => {
  it("returns ~0 miles for Averill Park itself", () => {
    const result = distanceFromAverillPark(42.6337, -73.5504);
    expect(result.miles).toBeCloseTo(0, 1);
  });

  it("returns a positive distance and drive time for a location ~12 miles away", () => {
    // Albany, NY is roughly 12 miles west of Averill Park.
    const result = distanceFromAverillPark(42.6526, -73.7562);
    expect(result.miles).toBeGreaterThan(8);
    expect(result.miles).toBeLessThan(16);
    expect(result.driveMinutes).toBeGreaterThan(0);
  });
});
