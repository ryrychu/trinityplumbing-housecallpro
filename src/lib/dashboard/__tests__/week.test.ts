import { describe, it, expect } from "vitest";
import { weekRange, dayRange } from "../week";

// Boundaries are America/New_York local midnight expressed as UTC instants.
// July 2026 is EDT (UTC−4), so local midnight is 04:00 UTC.
describe("weekRange", () => {
  it("returns Monday..Monday for 'this' week given a Wednesday", () => {
    // 2026-07-22 is a Wednesday.
    const { startIso, endIso } = weekRange(new Date("2026-07-22T14:00:00Z"), "this");
    expect(startIso).toBe("2026-07-20T04:00:00.000Z"); // Mon (ET midnight)
    expect(endIso).toBe("2026-07-27T04:00:00.000Z");   // next Mon (exclusive)
  });

  it("treats Sunday as the last day of the current week, not the first", () => {
    // 2026-07-26 is a Sunday.
    const { startIso, endIso } = weekRange(new Date("2026-07-26T23:00:00Z"), "this");
    expect(startIso).toBe("2026-07-20T04:00:00.000Z");
    expect(endIso).toBe("2026-07-27T04:00:00.000Z");
  });

  it("returns the following Mon..Mon for 'next'", () => {
    const { startIso, endIso } = weekRange(new Date("2026-07-22T14:00:00Z"), "next");
    expect(startIso).toBe("2026-07-27T04:00:00.000Z");
    expect(endIso).toBe("2026-08-03T04:00:00.000Z");
  });
});

describe("dayRange", () => {
  it("returns today 00:00 to tomorrow 00:00 (ET), as UTC instants", () => {
    const { startIso, endIso } = dayRange(new Date("2026-07-22T14:00:00Z"));
    expect(startIso).toBe("2026-07-22T04:00:00.000Z");
    expect(endIso).toBe("2026-07-23T04:00:00.000Z");
  });

  // DST-awareness: January 2026 is EST (UTC−5), so local midnight is 05:00 UTC,
  // proving the boundary is derived from the offset on that calendar day.
  it("uses the winter (EST) offset for a January date", () => {
    const { startIso, endIso } = dayRange(new Date("2026-01-15T14:00:00Z"));
    expect(startIso).toBe("2026-01-15T05:00:00.000Z");
    expect(endIso).toBe("2026-01-16T05:00:00.000Z");
  });
});
