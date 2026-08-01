import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";

const { getScheduleDaysMock } = vi.hoisted(() => ({
  getScheduleDaysMock: vi.fn(),
}));

vi.mock("@/lib/dashboard/queries", () => ({
  getScheduleDays: getScheduleDaysMock,
}));

import { findNearbyWork, describeDay, detourMinutes } from "../nearby";

// Averill Park is the shop. Delmar is ~14 mi SW of it; these are real enough
// coordinates that the mile arithmetic below means something.
const DELMAR = { lat: 42.6231, lng: -73.8332 };
const DELMAR_NEIGHBOUR = { lat: 42.6265, lng: -73.8401 }; // ~0.4 mi from DELMAR
const TROY = { lat: 42.7284, lng: -73.6918 }; // ~13 mi NE of Delmar

function row(over: Partial<TodayScheduleRow> & { id: string }): TodayScheduleRow {
  return {
    scheduledStart: "2026-08-03T14:00:00Z", // 10:00 EDT
    customerName: "A Customer",
    technicianName: "Dan",
    zone: "Albany Zone",
    compass: "SW",
    miles: null,
    driveMinutes: null,
    address: "9 Oak Ave, Delmar",
    service: "Drain Cleaning",
    customerPhone: null,
    status: "Scheduled",
    lat: DELMAR_NEIGHBOUR.lat,
    lng: DELMAR_NEIGHBOUR.lng,
    ...over,
  };
}

describe("findNearbyWork", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps jobs inside the radius and drops those outside it", async () => {
    getScheduleDaysMock.mockResolvedValue([
      { dateKey: "2026-08-03", rows: [row({ id: "near" }), row({ id: "far", ...TROY })] },
    ]);

    const [day] = await findNearbyWork(DELMAR, { radiusMiles: 5 });

    expect(day.jobs.map((j) => j.id)).toEqual(["near"]);
    // totalJobs counts the whole day, not just the matches — a day already
    // carrying other work is a worse candidate even when one job is close.
    expect(day.totalJobs).toBe(2);
  });

  it("reports the distance to each nearby job", async () => {
    getScheduleDaysMock.mockResolvedValue([{ dateKey: "2026-08-03", rows: [row({ id: "a" })] }]);

    const [day] = await findNearbyWork(DELMAR, { radiusMiles: 5 });

    expect(day.jobs[0].milesAway).toBeLessThan(1);
    expect(day.nearestMiles).toBe(day.jobs[0].milesAway);
  });

  // ~200 of 3,038 live jobs never geocoded. Treating those as distant would
  // silently hide a genuine neighbour.
  it("skips jobs with no coordinates rather than assuming they are far", async () => {
    getScheduleDaysMock.mockResolvedValue([
      { dateKey: "2026-08-03", rows: [row({ id: "nocoords", lat: null, lng: null })] },
    ]);

    const [day] = await findNearbyWork(DELMAR, { radiusMiles: 50 });

    expect(day.jobs).toHaveLength(0);
    expect(day.nearestMiles).toBeNull();
    expect(day.totalJobs).toBe(1); // still counted as booked work
  });

  it("returns every day in the horizon, including empty ones", async () => {
    getScheduleDaysMock.mockResolvedValue([
      { dateKey: "2026-08-03", rows: [row({ id: "a" })] },
      { dateKey: "2026-08-04", rows: [] },
    ]);

    const days = await findNearbyWork(DELMAR, {});

    expect(days.map((d) => d.dateKey)).toEqual(["2026-08-03", "2026-08-04"]);
    expect(days[1].nearestMiles).toBeNull();
  });

  it("sorts a day's nearby jobs by time, not by distance", async () => {
    getScheduleDaysMock.mockResolvedValue([
      {
        dateKey: "2026-08-03",
        rows: [
          row({ id: "later", scheduledStart: "2026-08-03T20:00:00Z" }),
          row({ id: "earlier", scheduledStart: "2026-08-03T12:00:00Z" }),
        ],
      },
    ]);

    const [day] = await findNearbyWork(DELMAR, { radiusMiles: 5 });

    expect(day.jobs.map((j) => j.id)).toEqual(["earlier", "later"]);
  });

  it("passes the horizon through to the schedule query", async () => {
    getScheduleDaysMock.mockResolvedValue([]);
    const now = new Date("2026-08-01T12:00:00Z");

    await findNearbyWork(DELMAR, { days: 21, now });

    expect(getScheduleDaysMock).toHaveBeenCalledWith(now, 21);
  });
});

describe("describeDay", () => {
  const base = { dateKey: "2026-08-03", nearestMiles: 0.4, totalJobs: 1 }; // Monday

  it("phrases a morning day the way the roadmap asks for", () => {
    const out = describeDay({ ...base, jobs: [{ ...row({ id: "a" }), milesAway: 0.4 }] });
    expect(out).toBe("Already working in Delmar Monday morning");
  });

  it("says afternoon for an afternoon job", () => {
    const job = { ...row({ id: "a", scheduledStart: "2026-08-03T18:00:00Z" }), milesAway: 0.4 };
    expect(describeDay({ ...base, jobs: [job] })).toContain("Monday afternoon");
  });

  // A day with work at both ends is not "the morning" — saying so would send a
  // dispatcher looking for a gap that is already taken.
  it("says through the day when work spans both halves", () => {
    const jobs = [
      { ...row({ id: "am", scheduledStart: "2026-08-03T13:00:00Z" }), milesAway: 0.4 },
      { ...row({ id: "pm", scheduledStart: "2026-08-03T19:00:00Z" }), milesAway: 0.5 },
    ];
    expect(describeDay({ ...base, jobs })).toContain("through the day");
  });

  it("names up to two towns", () => {
    const jobs = [
      { ...row({ id: "a", address: "1 Elm St, Delmar" }), milesAway: 0.4 },
      { ...row({ id: "b", address: "2 Oak Ave, Slingerlands" }), milesAway: 2 },
    ];
    expect(describeDay({ ...base, jobs })).toContain("Delmar and Slingerlands");
  });

  it("is null when nothing is nearby, so the UI has nothing to render", () => {
    expect(describeDay({ ...base, jobs: [], nearestMiles: null })).toBeNull();
  });

  it("falls back to 'the area' when no job carries an address", () => {
    const jobs = [{ ...row({ id: "a", address: null }), milesAway: 0.4 }];
    expect(describeDay({ ...base, jobs })).toContain("in the area");
  });
});

describe("detourMinutes", () => {
  it("converts the nearest distance at the module's average speed", () => {
    // 16 mi at 32 mph = 30 min.
    expect(detourMinutes({ dateKey: "x", jobs: [], nearestMiles: 16, totalJobs: 0 })).toBe(30);
  });

  it("is null when there is nothing nearby", () => {
    expect(detourMinutes({ dateKey: "x", jobs: [], nearestMiles: null, totalJobs: 0 })).toBeNull();
  });
});
