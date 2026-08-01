import { describe, it, expect } from "vitest";
import {
  localDateKey,
  mondayDateKey,
  isDailyDigestDue,
  isWeeklyLookaheadDue,
} from "../schedule";

describe("localDateKey", () => {
  it("uses the LOCAL date, not the UTC date", () => {
    // 2026-07-29 21:00 EDT is 2026-07-30 01:00 UTC. Keying the digest dedupe on
    // the UTC date would roll over at 8pm local and admit a second digest.
    expect(localDateKey(new Date("2026-07-30T01:00:00Z"))).toBe("2026-07-29");
  });

  it("pads month and day", () => {
    expect(localDateKey(new Date("2026-03-09T15:00:00Z"))).toBe("2026-03-09");
  });
});

describe("mondayDateKey", () => {
  it("returns the same Monday for any day in that local week", () => {
    // Mon 2026-07-27 .. Sun 2026-08-02, all 15:00Z (= 11:00 EDT, same local day)
    expect(mondayDateKey(new Date("2026-07-27T15:00:00Z"))).toBe("2026-07-27");
    expect(mondayDateKey(new Date("2026-07-30T15:00:00Z"))).toBe("2026-07-27");
    expect(mondayDateKey(new Date("2026-08-02T15:00:00Z"))).toBe("2026-07-27");
  });
});

describe("isDailyDigestDue", () => {
  it("is true at 06:00 EDT on a weekday (summer, UTC-4)", () => {
    expect(isDailyDigestDue(new Date("2026-07-29T10:00:00Z"))).toBe(true);
  });

  it("is true at 06:00 EST on a weekday (winter, UTC-5)", () => {
    // The same wall-clock 6am is a DIFFERENT UTC hour in winter. A hardcoded
    // cron hour is wrong for half the year; this is why timing lives here.
    expect(isDailyDigestDue(new Date("2026-01-14T11:00:00Z"))).toBe(true);
  });

  it("is false at 05:59 local", () => {
    expect(isDailyDigestDue(new Date("2026-07-29T09:59:00Z"))).toBe(false);
  });

  it("is true later in the morning so a missed 6:00 ping self-heals", () => {
    // 13:30Z = 09:30 EDT, inside the 06:00-12:00 catch-up window.
    expect(isDailyDigestDue(new Date("2026-07-29T13:30:00Z"))).toBe(true);
  });

  it("is false from noon local onward — no stale digest at bedtime", () => {
    expect(isDailyDigestDue(new Date("2026-07-29T16:00:00Z"))).toBe(false);
  });

  it("is true on Saturday and Sunday — weekend jobs get a digest too", () => {
    // Regression: these were gated off, so a Saturday job went unannounced and
    // the only weekend coverage was a Monday look-ahead five days old.
    expect(isDailyDigestDue(new Date("2026-08-01T10:00:00Z"))).toBe(true);
    expect(isDailyDigestDue(new Date("2026-08-02T10:00:00Z"))).toBe(true);
  });

  it("still respects the morning window on a weekend", () => {
    expect(isDailyDigestDue(new Date("2026-08-01T09:59:00Z"))).toBe(false); // 05:59 EDT
    expect(isDailyDigestDue(new Date("2026-08-01T16:00:00Z"))).toBe(false); // 12:00 EDT
  });

  it("is true on the DST spring-forward Monday", () => {
    // DST began Sun 2026-03-08; Mon 2026-03-09 06:00 EDT = 10:00Z
    expect(isDailyDigestDue(new Date("2026-03-09T10:00:00Z"))).toBe(true);
  });

  it("is true on the DST fall-back Monday", () => {
    // DST ended Sun 2026-11-01; Mon 2026-11-02 06:00 EST = 11:00Z
    expect(isDailyDigestDue(new Date("2026-11-02T11:00:00Z"))).toBe(true);
  });
});

describe("isWeeklyLookaheadDue", () => {
  it("is true Monday at 06:00 local", () => {
    expect(isWeeklyLookaheadDue(new Date("2026-07-27T10:00:00Z"))).toBe(true);
  });

  it("is false on other weekdays", () => {
    expect(isWeeklyLookaheadDue(new Date("2026-07-28T10:00:00Z"))).toBe(false);
  });

  it("is false before 06:00 Monday", () => {
    expect(isWeeklyLookaheadDue(new Date("2026-07-27T09:00:00Z"))).toBe(false);
  });
});
