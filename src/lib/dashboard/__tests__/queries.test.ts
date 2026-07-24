import { describe, it, expect, vi, beforeEach } from "vitest";

type QueryResult = { data: unknown[]; error: null };

function makeQueryBuilder(result: QueryResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lte: vi.fn(() => builder),
    // The real client pages with .range(); every fixture here is smaller than a
    // full page, so the first call returns everything and the loop terminates.
    range: vi.fn(() => builder),
    then: (resolve: (value: QueryResult) => unknown) => resolve(result),
  };
  return builder;
}

const fromMock = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseServerClient: () => ({ from: fromMock }),
}));

import { getDashboardSnapshot } from "../queries";

// Fixed clock for every test in this file: 2026-07-22 is a Wednesday, so
// this-week = Mon 07-20..Mon 07-27, next-week = 07-27..08-03, today = 07-22.
// All fixture dates below are chosen relative to this anchor so the window
// math is unambiguous and independent of the real wall-clock date.
const NOW = new Date("2026-07-22T12:00:00.000Z");

// j1: in-progress, scheduled + occurring TODAY (07-22), inside this week.
// j2: scheduled, inside this week (07-21) but not today.
// j3: complete, inside the PREVIOUS week (07-15) — must be excluded from
//     this-week revenue despite having an amount.
// j4: pro-canceled, also previous week (07-16) — excluded for the same reason.
// j5: scheduled, inside NEXT week (07-29).
const EXPECTED_THIS_WEEK = 35000; // j1 (20000) + j2 (15000)
const EXPECTED_NEXT_WEEK = 15000; // j5

function defaultJobs() {
  return [
    {
      id: "j1",
      work_status: "in progress",
      is_emergency: false,
      is_commercial: false,
      total_amount_cents: 20000,
      scheduled_start: "2026-07-22T09:00:00.000Z",
      scheduled_end: "2026-07-22T11:00:00.000Z",
      technician_id: "t1",
      service_address_lat: 42.7284,
      service_address_lng: -73.6918,
      raw: { customer: { id: "c1" }, address: { city: "Troy" } },
    },
    {
      id: "j2",
      work_status: "scheduled",
      is_emergency: true,
      is_commercial: false,
      total_amount_cents: 15000,
      scheduled_start: "2026-07-21T09:00:00.000Z",
      scheduled_end: "2026-07-21T10:30:00.000Z",
      technician_id: "t2",
      service_address_lat: 42.6526,
      service_address_lng: -73.7562,
      raw: { customer: { id: "c2" }, address: { city: "Albany" } },
    },
    // Completed work in a prior week must NOT count toward this-week revenue.
    {
      id: "j3",
      work_status: "complete rated",
      is_emergency: false,
      is_commercial: false,
      total_amount_cents: 99000,
      scheduled_start: "2026-07-15T09:00:00.000Z",
      scheduled_end: "2026-07-15T10:00:00.000Z",
      technician_id: "t1",
      service_address_lat: 42.7284,
      service_address_lng: -73.6918,
      raw: { customer: { id: "c1" }, address: { city: "Troy" } },
    },
    // Canceled work in a prior week must also be excluded.
    {
      id: "j4",
      work_status: "pro canceled",
      is_emergency: false,
      is_commercial: false,
      total_amount_cents: 77000,
      scheduled_start: "2026-07-16T09:00:00.000Z",
      scheduled_end: "2026-07-16T10:00:00.000Z",
      technician_id: "t2",
      service_address_lat: 42.6526,
      service_address_lng: -73.7562,
      raw: { customer: { id: "c2" }, address: { city: "Albany" } },
    },
    // Next week's booked revenue.
    {
      id: "j5",
      work_status: "scheduled",
      is_emergency: false,
      is_commercial: false,
      total_amount_cents: 15000,
      scheduled_start: "2026-07-29T09:00:00.000Z",
      scheduled_end: "2026-07-29T10:00:00.000Z",
      technician_id: "t2",
      service_address_lat: 42.6526,
      service_address_lng: -73.7562,
      raw: { customer: { id: "c2" }, address: { city: "Albany" } },
    },
  ];
}

describe("getDashboardSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockImplementation((table: string) => {
      if (table === "jobs") {
        // Status strings are the LIVE HCP values (go-live Step 2 census), not
        // invented ones — "in progress" with a space, never "in_progress".
        // Fixtures using the underscored form let the old bug pass tests while
        // the dashboard reported 0 against the real account.
        return makeQueryBuilder({ data: defaultJobs(), error: null });
      }
      if (table === "estimates") {
        // `status` stores the live HCP `work_status`; option approval state lives
        // in raw.options[].approval_status (Task 0). Open = not won/canceled, no
        // option approved, and at least one option still awaiting a response.
        return makeQueryBuilder({
          data: [
            // OPEN + upcoming: awaiting a response, not won/canceled, scheduled
            // for a date on/after "today" (07-22).
            {
              id: "e1",
              status: "needs scheduling",
              raw: { options: [{ approval_status: null }], scheduled_start: "2026-07-25T00:00:00.000Z" },
            },
            // won -> not open (converted to a job).
            { id: "e2", status: "created job from estimate", raw: { options: [{ approval_status: null }] } },
            // dead -> not open (only expired options, none awaiting).
            { id: "e3", status: "complete rated", raw: { options: [{ approval_status: "expired" }] } },
            // accepted -> not open (an option is approved).
            { id: "e4", status: "scheduled", raw: { options: [{ approval_status: "approved" }, { approval_status: null }] } },
            // OPEN but NOT upcoming: one option awaiting, none approved, but its
            // scheduled_start is in the past relative to "today".
            {
              id: "e5",
              status: "in progress",
              raw: { options: [{ approval_status: null }, { approval_status: "declined" }], scheduled_start: "2026-07-10T00:00:00.000Z" },
            },
          ],
          error: null,
        });
      }
      if (table === "invoices") {
        // Live HCP invoice statuses are paid/canceled/voided/open. There is no
        // "pending" — "open" is the unpaid state the card counts.
        return makeQueryBuilder({
          data: [
            { id: "i1", status: "open", amount_cents: 30000 },
            { id: "i2", status: "paid", amount_cents: 40000 },
            { id: "i3", status: "voided", amount_cents: 50000 },
          ],
          error: null,
        });
      }
      if (table === "customers") {
        return makeQueryBuilder({
          data: [
            { id: "c1", first_name: "Alice", last_name: "Anderson", city: "Troy" },
            { id: "c2", first_name: "Bob", last_name: "Baker", city: "Albany" },
          ],
          error: null,
        });
      }
      if (table === "technicians") {
        return makeQueryBuilder({
          data: [
            { id: "t1", first_name: "Tom", last_name: "Tech" },
            { id: "t2", first_name: "Tina", last_name: "Trades" },
          ],
          error: null,
        });
      }
      return makeQueryBuilder({ data: [], error: null });
    });
  });

  it("counts jobs in progress and emergency calls", async () => {
    const snapshot = await getDashboardSnapshot(NOW);
    expect(snapshot.jobsInProgress).toBe(1);
    expect(snapshot.emergencyCalls).toBe(1);
  });

  it("counts open estimates (awaiting a response, not won/canceled), pending invoices, and upcoming estimates", async () => {
    const snapshot = await getDashboardSnapshot(NOW);
    expect(snapshot.openEstimates).toBe(2); // e1 + e5
    expect(snapshot.pendingInvoices).toBe(1);
    expect(snapshot.upcomingEstimates).toBe(1); // e1 only — e5's date is in the past
  });

  // Regression guard: PostgREST returns at most 1000 rows per request. Before
  // pagination the dashboard read only the first page and under-reported every
  // count (19 jobs in progress instead of 91 against the live account).
  it("pages past the 1000-row cap instead of truncating", async () => {
    const job = (id: string) => ({
      id,
      work_status: "in progress",
      is_emergency: false,
      is_commercial: false,
      total_amount_cents: 100,
      scheduled_start: "2026-07-22T00:00:00.000Z",
      scheduled_end: "2026-07-22T00:30:00.000Z",
      technician_id: null,
      service_address_lat: null,
      service_address_lng: null,
      raw: {},
    });
    const fullPage = Array.from({ length: 1000 }, (_, i) => job(`p${i}`));
    const lastPage = [job("p1000")];

    let jobsCall = 0;
    fromMock.mockImplementation((table: string) => {
      if (table === "jobs") {
        const builder = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          gte: vi.fn(() => builder),
          lte: vi.fn(() => builder),
          range: vi.fn(() => builder),
          then: (resolve: (value: QueryResult) => unknown) =>
            resolve({ data: jobsCall++ === 0 ? fullPage : lastPage, error: null }),
        };
        return builder;
      }
      return makeQueryBuilder({ data: [], error: null });
    });

    const snapshot = await getDashboardSnapshot(NOW);
    expect(jobsCall).toBe(2); // a second page was actually requested
    expect(snapshot.jobsInProgress).toBe(1001);
    expect(snapshot.revenueBookedThisWeekCents).toBe(100100);
  });

  it("date-scopes revenue booked to the current Mon-Sun week", async () => {
    const snap = await getDashboardSnapshot(NOW);
    expect(snap.revenueBookedThisWeekCents).toBe(EXPECTED_THIS_WEEK);
  });

  it("sums revenue scheduled for next week", async () => {
    const snap = await getDashboardSnapshot(NOW);
    expect(snap.revenueScheduledNextWeekCents).toBe(EXPECTED_NEXT_WEEK);
  });

  it("builds today's schedule with zone/compass per job", async () => {
    const snap = await getDashboardSnapshot(NOW);
    expect(Array.isArray(snap.todaySchedule)).toBe(true);
    // Only j1 is scheduled on 07-22 ("today"); j2 is this-week but not today.
    expect(snap.todaySchedule).toHaveLength(1);
    const [entry] = snap.todaySchedule;
    expect(entry.id).toBe("j1");
    expect(entry.scheduledStart).toBe("2026-07-22T09:00:00.000Z");
    expect(entry.customerName).toBe("Alice Anderson");
    expect(entry.technicianName).toBe("Tom Tech");
    expect(entry.zone).toBeTypeOf("string");
    expect(entry.compass).toBeTypeOf("string");
    // Town-based resolution: "Troy" maps to a known zone.
    expect(entry.zone).toBe("Albany Zone");
  });

  it("aggregates technician workload for today", async () => {
    const snap = await getDashboardSnapshot(NOW);
    expect(Array.isArray(snap.technicianWorkload)).toBe(true);
    // Only j1 (technician t1) falls on "today".
    expect(snap.technicianWorkload).toHaveLength(1);
    const [entry] = snap.technicianWorkload;
    expect(entry.technicianId).toBe("t1");
    expect(entry.technicianName).toBe("Tom Tech");
    expect(entry.jobCount).toBe(1);
    expect(entry.scheduledHours).toBe(2); // 09:00 -> 11:00
  });
});
