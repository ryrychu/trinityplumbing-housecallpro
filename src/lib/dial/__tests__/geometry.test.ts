import { describe, it, expect } from "vitest";
import { buildDial, outerRingFor } from "../geometry";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";

const AVERILL_PARK = { lat: 42.6337, lng: -73.5504 };

function job(over: Partial<TodayScheduleRow> = {}): TodayScheduleRow {
  return {
    id: "job_1",
    scheduledStart: "2026-08-06T12:00:00Z",
    customerName: "Margaret Kowalski",
    technicianName: "Dylan",
    zone: "Albany Zone",
    compass: "N",
    miles: 5,
    driveMinutes: 9,
    address: "14 Sliter Rd, Averill Park",
    service: "Water Heater Replacement",
    customerPhone: "5185550142",
    status: "Scheduled",
    lat: AVERILL_PARK.lat + 0.1,
    lng: AVERILL_PARK.lng,
    ...over,
  };
}

describe("outerRingFor", () => {
  it("keeps a close-in day on a tight field instead of a 45-mile one", () => {
    // Every job inside Averill Park should not be drawn on a field where the
    // whole cluster collapses into the middle eighth of the plot.
    expect(outerRingFor(4)).toBe(15);
    expect(outerRingFor(15)).toBe(15);
  });

  it("steps up the ladder as the day reaches further out", () => {
    expect(outerRingFor(15.1)).toBe(30);
    expect(outerRingFor(41)).toBe(45);
    // Glens Falls (~46 mi) is a regular North Route destination.
    expect(outerRingFor(46)).toBe(60);
  });

  it("extends past the ladder rather than clipping a very distant job", () => {
    expect(outerRingFor(140)).toBe(150);
  });
});

describe("buildDial", () => {
  it("puts a job due north straight up, scaled by distance", () => {
    const { marks, outerMiles } = buildDial([
      job({ lat: AVERILL_PARK.lat + 0.1, lng: AVERILL_PARK.lng, miles: 7.5 }),
    ]);
    expect(outerMiles).toBe(15);
    expect(marks[0].x).toBeCloseTo(0, 6);
    // y is screen-down, so due north is negative.
    expect(marks[0].y).toBeCloseTo(-0.5, 6);
    expect(marks[0].bearingDeg).toBeCloseTo(0, 6);
  });

  it("puts a job due south straight down", () => {
    const { marks } = buildDial([
      job({ lat: AVERILL_PARK.lat - 0.1, lng: AVERILL_PARK.lng, miles: 15 }),
    ]);
    expect(marks[0].x).toBeCloseTo(0, 6);
    expect(marks[0].y).toBeCloseTo(1, 6);
  });

  it("puts an easterly job to the right and a westerly job to the left", () => {
    const east = buildDial([job({ lng: AVERILL_PARK.lng + 0.4, lat: AVERILL_PARK.lat })]);
    const west = buildDial([job({ lng: AVERILL_PARK.lng - 0.4, lat: AVERILL_PARK.lat })]);
    expect(east.marks[0].x).toBeGreaterThan(0);
    expect(west.marks[0].x).toBeLessThan(0);
  });

  it("counts jobs it cannot place rather than silently dropping them", () => {
    // A town-only job resolves a zone through zoneForTown but never geocoded,
    // so it has no bearing and no distance. The dial must say so out loud.
    const model = buildDial([
      job({ id: "a" }),
      job({ id: "b", lat: null, lng: null, miles: null, compass: "" }),
      job({ id: "c", lat: null, lng: null, miles: null, compass: "" }),
    ]);
    expect(model.marks).toHaveLength(1);
    expect(model.unplotted).toBe(2);
  });

  it("flags exactly one farthest job to carry the direct label", () => {
    const model = buildDial([
      job({ id: "near", miles: 3 }),
      job({ id: "far", miles: 41 }),
      job({ id: "mid", miles: 12 }),
    ]);
    expect(model.farthest?.id).toBe("far");
    expect(model.marks.filter((m) => m.farthest)).toHaveLength(1);
  });

  it("clamps a job past the outer ring onto the edge instead of off the plot", () => {
    const model = buildDial([job({ miles: 5 }), job({ id: "x", miles: 400 })]);
    const radius = (m: { x: number; y: number }) => Math.hypot(m.x, m.y);
    expect(Math.max(...model.marks.map(radius))).toBeLessThanOrEqual(1);
  });

  it("marks out-of-area work, which is the dial's one status meaning", () => {
    const model = buildDial([
      job({ id: "in", zone: "Albany Zone" }),
      job({ id: "out", zone: "Outside Service Area", miles: 60 }),
    ]);
    expect(model.marks.find((m) => m.id === "in")?.outside).toBe(false);
    expect(model.marks.find((m) => m.id === "out")?.outside).toBe(true);
  });

  it("counts the zones in play so the summary can state the day's spread", () => {
    const model = buildDial([
      job({ id: "a", zone: "Albany Zone" }),
      job({ id: "b", zone: "Albany Zone" }),
      job({ id: "c", zone: "North Route" }),
    ]);
    expect(model.zoneCount).toBe(2);
  });

  it("survives a day with no jobs at all", () => {
    const model = buildDial([]);
    expect(model.marks).toEqual([]);
    expect(model.farthest).toBeNull();
    expect(model.unplotted).toBe(0);
    expect(model.outerMiles).toBe(15);
  });
});
