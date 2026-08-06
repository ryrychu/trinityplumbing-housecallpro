import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";

const { snapshotMock } = vi.hoisted(() => ({ snapshotMock: vi.fn() }));
vi.mock("@/lib/dashboard/queries", () => ({ getDashboardSnapshot: snapshotMock }));

// Signed in by default so the existing cases exercise the real handler. The
// implementation survives vi.clearAllMocks() (which clears calls, not impls),
// and the refusal case below overrides it per-test.
const { requireUserMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(async () => ({ id: "u1", email: "info@trinity.plumbing" })),
}));
vi.mock("@/lib/mobile/session", () => ({ requireUser: requireUserMock }));
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
      // Deliberately different from emergencyCallsToday below: emergencyCalls
      // is the all-time count (47, across 3,038 jobs). If the route regresses
      // to reading this field instead of the today-scoped one, the assertion
      // on body.data.emergencyCalls below catches it (47 !== 1).
      emergencyCalls: 47,
      emergencyCallsToday: 1,
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
    // Must be the today-scoped 1, not the all-time 47 -- see the mock comment
    // above. A screen headed "Today" showing a lifetime count is exactly the
    // bug this test guards against.
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

  // The six /api/app/* handlers read through the service-role client and no
  // table has RLS, so before requireUser() the middleware matcher was the
  // only thing refusing an anonymous caller. Asserting the query module was
  // never reached is what makes this more than a status-code check: a 401
  // returned after the data had already been fetched would still be a leak
  // waiting on one more mistake.
  it("refuses an unauthenticated request without touching the data", async () => {
    requireUserMock.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/not signed in/i);
    expect(snapshotMock).not.toHaveBeenCalled();
  });
});
