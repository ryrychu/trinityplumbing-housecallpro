import { describe, it, expect } from "vitest";
import { weekRange, dayRange } from "../week";

describe("weekRange", () => {
  it("returns Monday..Monday for 'this' week given a Wednesday", () => {
    // 2026-07-22 is a Wednesday.
    const { startIso, endIso } = weekRange(new Date("2026-07-22T14:00:00Z"), "this");
    expect(startIso).toBe("2026-07-20T00:00:00.000Z"); // Mon
    expect(endIso).toBe("2026-07-27T00:00:00.000Z");   // next Mon (exclusive)
  });

  it("treats Sunday as the last day of the current week, not the first", () => {
    // 2026-07-26 is a Sunday.
    const { startIso, endIso } = weekRange(new Date("2026-07-26T23:00:00Z"), "this");
    expect(startIso).toBe("2026-07-20T00:00:00.000Z");
    expect(endIso).toBe("2026-07-27T00:00:00.000Z");
  });

  it("returns the following Mon..Mon for 'next'", () => {
    const { startIso, endIso } = weekRange(new Date("2026-07-22T14:00:00Z"), "next");
    expect(startIso).toBe("2026-07-27T00:00:00.000Z");
    expect(endIso).toBe("2026-08-03T00:00:00.000Z");
  });
});

describe("dayRange", () => {
  it("returns today 00:00 to tomorrow 00:00", () => {
    const { startIso, endIso } = dayRange(new Date("2026-07-22T14:00:00Z"));
    expect(startIso).toBe("2026-07-22T00:00:00.000Z");
    expect(endIso).toBe("2026-07-23T00:00:00.000Z");
  });
});
