import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";

const { snapshotMock } = vi.hoisted(() => ({ snapshotMock: vi.fn() }));
vi.mock("@/lib/dashboard/queries", () => ({ getDashboardSnapshot: snapshotMock }));

import { GET } from "../route";

const row = (over: Partial<TodayScheduleRow> = {}): TodayScheduleRow => ({
  id: "job_1",
  scheduledStart: "2026-08-06T12:00:00Z",
  customerName: "M. Kowalski",
  technicianName: "Dylan",
  zone: "Averill Park",
  compass: "",
  miles: 2.1,
  driveMinutes: 4,
  address: "14 Sliter Rd, Averill Park",
  service: "Water Heater Replacement",
  customerPhone: "5185550142",
  status: "In Progress",
  lat: 42.63,
  lng: -73.55,
  ...over,
});

describe("GET /api/app/today", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshotMock.mockResolvedValue({
      jobsInProgress: 3,
      emergencyCalls: 1,
      commercialJobs: 0,
      openEstimates: 12,
      pendingInvoices: 25,
      upcomingEstimates: 4,
      revenueBookedThisWeekCents: 1_450_000,
      revenueScheduledNextWeekCents: 920_000,
      todaySchedule: [row(), row({ id: "job_2", status: "Scheduled" })],
      technicianWorkload: [],
    });
  });

  it("returns the counters and today's jobs", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.jobsInProgress).toBe(3);
    expect(body.data.emergencyCalls).toBe(1);
    expect(body.data.pendingInvoices).toBe(25);
    expect(body.data.jobs).toHaveLength(2);
    expect(Date.parse(body.generated_at)).not.toBeNaN();
  });

  // The counters this screen shows are the ones getDashboardSnapshot already
  // computes. Recomputing them here is how two surfaces silently disagree.
  it("delegates entirely to getDashboardSnapshot", async () => {
    await GET();
    expect(snapshotMock).toHaveBeenCalledTimes(1);
  });

  // A dead Supabase must not render as an empty, normal-looking day.
  it("surfaces a query failure with its cause", async () => {
    snapshotMock.mockRejectedValue(new Error("supabase unreachable"));
    const res = await GET();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/supabase unreachable/);
  });
});
