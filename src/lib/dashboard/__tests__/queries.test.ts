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

import { getDashboardSnapshot, getWeekAheadSchedule } from "../queries";

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
// j7: user-canceled, INSIDE this week (07-24) with a large amount — canceled
//     jobs must NOT inflate booked revenue, so it stays out of EXPECTED_THIS_WEEK.
const EXPECTED_THIS_WEEK = 35000; // j1 (20000) + j2 (15000); j7 canceled -> excluded
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
      raw: {
        customer: { id: "c1" },
        address: { street: "12 Elm St", city: "Troy" },
        job_fields: { job_type: { name: "Water Heater Repair" } },
      },
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
    // Canceled work INSIDE this week must NOT count toward booked revenue. Large
    // amount so a regression (summing it) would be obvious. Scheduled 07-24
    // (this week, not today) so it does not touch today's schedule/workload.
    {
      id: "j7",
      work_status: "user canceled",
      is_emergency: false,
      is_commercial: false,
      total_amount_cents: 88000,
      scheduled_start: "2026-07-24T09:00:00.000Z",
      scheduled_end: "2026-07-24T10:00:00.000Z",
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
            { id: "c1", first_name: "Alice", last_name: "Anderson", phone: "5185550142", address_line1: "1 Customer Rd", city: "Troy" },
            { id: "c2", first_name: "Bob", last_name: "Baker", phone: null, address_line1: "2 Customer Rd", city: "Albany" },
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
    // FIX 3: a job WITH coordinates exposes numeric distance + drive time.
    expect(entry.miles).toBeTypeOf("number");
    expect(entry.driveMinutes).toBeTypeOf("number");
    // The Slack digest reads these — all come out of the job's raw payload or
    // the customer record, with no new columns.
    expect(entry.address).toBe("12 Elm St, Troy");
    expect(entry.service).toBe("Water Heater Repair");
    expect(entry.customerPhone).toBe("5185550142");
    expect(entry.status).toBe("In Progress");
  });

  // The digest's two new lines both degrade rather than disappear: address falls
  // back job street -> customer street -> town, service falls back job type ->
  // description -> null.
  describe("address and service resolution", () => {
    const scheduleJob = (raw: unknown) => ({
      id: "jx",
      work_status: "scheduled",
      is_emergency: false,
      is_commercial: false,
      total_amount_cents: 0,
      scheduled_start: "2026-07-22T09:00:00.000Z",
      scheduled_end: "2026-07-22T10:00:00.000Z",
      technician_id: null,
      service_address_lat: null,
      service_address_lng: null,
      raw,
    });

    async function entryFor(raw: unknown) {
      fromMock.mockImplementation((table: string) => {
        if (table === "jobs") return makeQueryBuilder({ data: [scheduleJob(raw)], error: null });
        if (table === "customers") {
          return makeQueryBuilder({
            data: [
              {
                id: "c1",
                first_name: "Alice",
                last_name: "Anderson",
                phone: "5185550142",
                address_line1: "1 Customer Rd",
                city: "Troy",
              },
            ],
            error: null,
          });
        }
        return makeQueryBuilder({ data: [], error: null });
      });
      const snap = await getDashboardSnapshot(NOW);
      return snap.todaySchedule[0];
    }

    it("falls back to the customer's street when the job carries none", async () => {
      const entry = await entryFor({ customer: { id: "c1" }, address: { city: "Troy" } });
      expect(entry.address).toBe("1 Customer Rd, Troy");
    });

    it("shows the town alone when no street is known anywhere", async () => {
      const entry = await entryFor({ customer: { id: "c_missing" }, address: { city: "Albany" } });
      expect(entry.address).toBe("Albany");
    });

    it("returns null rather than an empty string when there is no address at all", async () => {
      const entry = await entryFor({ customer: { id: "c_missing" } });
      expect(entry.address).toBeNull();
    });

    it("falls back to the job description when no job type is set", async () => {
      const entry = await entryFor({ customer: { id: "c1" }, description: "Kitchen sink backing up" });
      expect(entry.service).toBe("Kitchen sink backing up");
    });

    it("keeps a long description to one truncated line — the digest must stay scannable", async () => {
      const entry = await entryFor({
        customer: { id: "c1" },
        description: `${"Customer reports water pooling under the basement stairs".repeat(3)}\nsecond line`,
      });
      expect(entry.service).not.toContain("\n");
      expect(entry.service!.length).toBeLessThanOrEqual(60);
      expect(entry.service!.endsWith("…")).toBe(true);
    });

    it("prefers the structured job type over the free-text description", async () => {
      const entry = await entryFor({
        customer: { id: "c1" },
        description: "long rambling note",
        job_fields: { job_type: { name: "Drain Cleaning" } },
      });
      expect(entry.service).toBe("Drain Cleaning");
    });

    it("returns null when a job has neither job type nor description", async () => {
      const entry = await entryFor({ customer: { id: "c1" } });
      expect(entry.service).toBeNull();
    });

    it("prefers the customer record's phone over the job's embedded snapshot", async () => {
      const entry = await entryFor({ customer: { id: "c1", mobile_number: "5180000000" } });
      expect(entry.customerPhone).toBe("5185550142");
    });

    it("falls back to the job's embedded customer number when the customer row is missing", async () => {
      const entry = await entryFor({ customer: { id: "c_missing", mobile_number: "(518) 555-0199" } });
      // Stored as digits — the renderer owns display formatting.
      expect(entry.customerPhone).toBe("5185550199");
    });

    it("prefers mobile over home and work — it is the number a tech can text", async () => {
      const entry = await entryFor({
        customer: { id: "c_missing", mobile_number: "5181111111", home_number: "5182222222", work_number: "5183333333" },
      });
      expect(entry.customerPhone).toBe("5181111111");
    });

    it("returns null rather than an empty string when no number exists anywhere", async () => {
      const entry = await entryFor({ customer: { id: "c_missing" } });
      expect(entry.customerPhone).toBeNull();
    });
  });

  // HCP's work_status enum has no "en route"; only work_timestamps.on_my_way_at
  // distinguishes a dispatched job from one still sitting on the board.
  describe("job status labels", () => {
    const statusJob = (work_status: string | null, work_timestamps?: unknown) => ({
      id: "js",
      work_status,
      is_emergency: false,
      is_commercial: false,
      total_amount_cents: 0,
      scheduled_start: "2026-07-22T09:00:00.000Z",
      scheduled_end: "2026-07-22T10:00:00.000Z",
      technician_id: null,
      service_address_lat: null,
      service_address_lng: null,
      raw: { customer: { id: "c1" }, work_timestamps },
    });

    async function statusFor(work_status: string | null, work_timestamps?: unknown) {
      fromMock.mockImplementation((table: string) => {
        if (table === "jobs") {
          return makeQueryBuilder({ data: [statusJob(work_status, work_timestamps)], error: null });
        }
        return makeQueryBuilder({ data: [], error: null });
      });
      const snap = await getDashboardSnapshot(NOW);
      return snap.todaySchedule[0]?.status ?? null;
    }

    it("titles the live HCP statuses", async () => {
      expect(await statusFor("scheduled")).toBe("Scheduled");
      expect(await statusFor("in progress")).toBe("In Progress");
      expect(await statusFor("needs scheduling")).toBe("Needs Scheduling");
    });

    it("collapses both complete variants into one label — the rating is not dispatch news", async () => {
      expect(await statusFor("complete rated")).toBe("Completed");
      expect(await statusFor("complete unrated")).toBe("Completed");
    });

    it("upgrades a scheduled job to En Route once the tech taps On My Way", async () => {
      expect(await statusFor("scheduled", { on_my_way_at: "2026-07-22T08:40:00.000Z" })).toBe("En Route");
    });

    it("stays Scheduled when on_my_way_at is null rather than merely absent", async () => {
      expect(await statusFor("scheduled", { on_my_way_at: null, started_at: null })).toBe("Scheduled");
    });

    it("omits an unrecognized or missing status instead of echoing raw HCP casing", async () => {
      expect(await statusFor("some new hcp status")).toBeNull();
      expect(await statusFor(null)).toBeNull();
    });
  });

  // FIX 2: canceled jobs (j7, user canceled, this week) must not inflate revenue.
  it("excludes canceled jobs from booked revenue even when in-window", async () => {
    const snap = await getDashboardSnapshot(NOW);
    // j7 sits inside this week with an 88000 amount; if it were summed the total
    // would be 123000. Booked revenue must stay at j1 + j2 only.
    expect(snap.revenueBookedThisWeekCents).toBe(EXPECTED_THIS_WEEK);
  });

  // FIX 1: town-first zone resolution must work even when coordinates are null.
  it("resolves zone from a known town when coordinates are missing", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "jobs") {
        return makeQueryBuilder({
          data: [
            {
              id: "jn",
              work_status: "scheduled",
              is_emergency: false,
              is_commercial: false,
              total_amount_cents: 0,
              scheduled_start: "2026-07-22T09:00:00.000Z",
              scheduled_end: "2026-07-22T10:00:00.000Z",
              technician_id: null,
              service_address_lat: null,
              service_address_lng: null,
              raw: { customer: { id: "c2" }, address: { city: "Albany" } },
            },
          ],
          error: null,
        });
      }
      if (table === "customers") {
        return makeQueryBuilder({
          data: [{ id: "c2", first_name: "Bob", last_name: "Baker", city: "Albany" }],
          error: null,
        });
      }
      return makeQueryBuilder({ data: [], error: null });
    });

    const snap = await getDashboardSnapshot(NOW);
    expect(snap.todaySchedule).toHaveLength(1);
    const [entry] = snap.todaySchedule;
    // Known town "Albany" -> "Albany Zone", NOT "Unknown", despite null coords.
    expect(entry.zone).toBe("Albany Zone");
    expect(entry.miles).toBeNull();
    expect(entry.driveMinutes).toBeNull();
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

  // Task 14: canceled jobs must not appear in the schedule dispatchers read,
  // but technicianWorkload must keep counting them -- it reads the unfiltered
  // todayJobs array, not the filtered schedule. All jobs below are scheduled
  // on "today" (07-22, day window 04:00Z-07-22 -> 04:00Z-07-23 in EDT).
  describe("canceled-job filtering (today's schedule)", () => {
    beforeEach(() => {
      fromMock.mockImplementation((table: string) => {
        if (table === "jobs") {
          return makeQueryBuilder({
            data: [
              {
                id: "j_scheduled",
                work_status: "scheduled",
                is_emergency: false,
                is_commercial: false,
                total_amount_cents: 1000,
                scheduled_start: "2026-07-22T08:00:00.000Z",
                scheduled_end: "2026-07-22T09:00:00.000Z",
                technician_id: "t1",
                service_address_lat: null,
                service_address_lng: null,
                raw: {},
              },
              {
                id: "j_in_progress",
                work_status: "in progress",
                is_emergency: false,
                is_commercial: false,
                total_amount_cents: 1000,
                scheduled_start: "2026-07-22T09:00:00.000Z",
                scheduled_end: "2026-07-22T10:00:00.000Z",
                technician_id: "t1",
                service_address_lat: null,
                service_address_lng: null,
                raw: {},
              },
              {
                id: "j_complete_rated",
                work_status: "complete rated",
                is_emergency: false,
                is_commercial: false,
                total_amount_cents: 1000,
                scheduled_start: "2026-07-22T10:00:00.000Z",
                scheduled_end: "2026-07-22T11:00:00.000Z",
                technician_id: "t2",
                service_address_lat: null,
                service_address_lng: null,
                raw: {},
              },
              {
                id: "j_complete_unrated",
                work_status: "complete unrated",
                is_emergency: false,
                is_commercial: false,
                total_amount_cents: 1000,
                scheduled_start: "2026-07-22T11:00:00.000Z",
                scheduled_end: "2026-07-22T12:00:00.000Z",
                technician_id: "t2",
                service_address_lat: null,
                service_address_lng: null,
                raw: {},
              },
              // Unknown/null status is NOT cancellation -- must stay included.
              {
                id: "j_null_status",
                work_status: null,
                is_emergency: false,
                is_commercial: false,
                total_amount_cents: 1000,
                scheduled_start: "2026-07-22T12:00:00.000Z",
                scheduled_end: "2026-07-22T13:00:00.000Z",
                technician_id: "t1",
                service_address_lat: null,
                service_address_lng: null,
                raw: {},
              },
              {
                id: "j_pro_canceled",
                work_status: "pro canceled",
                is_emergency: false,
                is_commercial: false,
                total_amount_cents: 5000,
                scheduled_start: "2026-07-22T13:00:00.000Z",
                scheduled_end: "2026-07-22T14:00:00.000Z",
                technician_id: "t1",
                service_address_lat: null,
                service_address_lng: null,
                raw: {},
              },
              {
                id: "j_user_canceled",
                work_status: "user canceled",
                is_emergency: false,
                is_commercial: false,
                total_amount_cents: 5000,
                scheduled_start: "2026-07-22T14:00:00.000Z",
                scheduled_end: "2026-07-22T15:00:00.000Z",
                technician_id: "t2",
                service_address_lat: null,
                service_address_lng: null,
                raw: {},
              },
              // Case-insensitivity: mixed-case must still be excluded.
              {
                id: "j_pro_canceled_mixed_case",
                work_status: "Pro Canceled",
                is_emergency: false,
                is_commercial: false,
                total_amount_cents: 5000,
                scheduled_start: "2026-07-22T15:00:00.000Z",
                scheduled_end: "2026-07-22T16:00:00.000Z",
                technician_id: "t1",
                service_address_lat: null,
                service_address_lng: null,
                raw: {},
              },
            ],
            error: null,
          });
        }
        return makeQueryBuilder({ data: [], error: null });
      });
    });

    it("excludes canceled jobs from today's schedule while including null-status jobs", async () => {
      const snap = await getDashboardSnapshot(NOW);
      expect(snap.todaySchedule.map((r) => r.id)).toEqual([
        "j_scheduled",
        "j_in_progress",
        "j_complete_rated",
        "j_complete_unrated",
        "j_null_status",
      ]);
    });

    it("keeps technicianWorkload counting canceled jobs -- it reads the unfiltered todayJobs array", async () => {
      const snap = await getDashboardSnapshot(NOW);
      // 8 jobs today total, split t1 (5: scheduled, in_progress, null_status,
      // pro_canceled, pro_canceled_mixed_case) and t2 (3: complete_rated,
      // complete_unrated, user_canceled). Workload must count ALL of them,
      // including the 3 canceled jobs the schedule dropped.
      const byTech = new Map(snap.technicianWorkload.map((w) => [w.technicianId, w.jobCount]));
      expect(byTech.get("t1")).toBe(5);
      expect(byTech.get("t2")).toBe(3);
      expect(snap.technicianWorkload.reduce((s, w) => s + w.jobCount, 0)).toBe(8);
    });
  });
});

describe("getWeekAheadSchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns seven day buckets, Monday first, with jobs in their local day", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "jobs") {
        return makeQueryBuilder({
          data: [
            {
              id: "job_1",
              work_status: "scheduled",
              is_emergency: false,
              is_commercial: false,
              total_amount_cents: 10000,
              scheduled_start: "2026-07-27T12:00:00.000Z", // Mon 08:00 EDT
              scheduled_end: "2026-07-27T13:00:00.000Z",
              technician_id: "t1",
              service_address_lat: null,
              service_address_lng: null,
              raw: { customer: { id: "c1" }, address: { city: "Troy" } },
            },
            {
              id: "job_2",
              work_status: "scheduled",
              is_emergency: false,
              is_commercial: false,
              total_amount_cents: 10000,
              scheduled_start: "2026-07-29T20:00:00.000Z", // Wed 16:00 EDT
              scheduled_end: "2026-07-29T21:00:00.000Z",
              technician_id: "t2",
              service_address_lat: null,
              service_address_lng: null,
              raw: { customer: { id: "c2" }, address: { city: "Albany" } },
            },
          ],
          error: null,
        });
      }
      if (table === "customers") {
        return makeQueryBuilder({
          data: [
            { id: "c1", first_name: "Alice", last_name: "Anderson", phone: "5185550142", address_line1: "1 Customer Rd", city: "Troy" },
            { id: "c2", first_name: "Bob", last_name: "Baker", phone: null, address_line1: "2 Customer Rd", city: "Albany" },
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

    const days = await getWeekAheadSchedule(new Date("2026-07-27T10:00:00Z"));

    expect(days).toHaveLength(7);
    expect(days[0].dateKey).toBe("2026-07-27");
    expect(days[6].dateKey).toBe("2026-08-02");
    expect(days[0].rows.map((r) => r.id)).toEqual(["job_1"]);
    expect(days[2].rows.map((r) => r.id)).toEqual(["job_2"]);
    expect(days[1].rows).toEqual([]);
    // Rows share the exact shape buildScheduleRow produces for the dashboard.
    expect(days[0].rows[0].customerName).toBe("Alice Anderson");
    expect(days[0].rows[0].technicianName).toBe("Tom Tech");
  });

  it("returns seven empty-but-present days when there are no jobs at all", async () => {
    fromMock.mockImplementation(() => makeQueryBuilder({ data: [], error: null }));

    const days = await getWeekAheadSchedule(new Date("2026-07-27T10:00:00Z"));

    expect(days).toHaveLength(7);
    expect(days.map((d) => d.dateKey)).toEqual([
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
    for (const d of days) {
      expect(d.rows).toEqual([]);
    }
  });

  // Task 14 (owner decision, 2026-07-30): canceled jobs must be filtered from
  // the digest, matching getDashboardSnapshot's todaySchedule. This reverses
  // the prior "must match by including canceled jobs" behavior -- that parity
  // requirement now cuts the other way: BOTH surfaces exclude cancellations,
  // via the same isCanceledJob predicate, so they cannot drift apart.
  it("excludes canceled jobs (case-insensitively) but includes null-status jobs, matching getDashboardSnapshot's todaySchedule", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "jobs") {
        return makeQueryBuilder({
          data: [
            {
              id: "job_scheduled",
              work_status: "scheduled",
              is_emergency: false,
              is_commercial: false,
              total_amount_cents: 5000,
              scheduled_start: "2026-07-27T12:00:00.000Z", // Mon 08:00 EDT
              scheduled_end: "2026-07-27T13:00:00.000Z",
              technician_id: null,
              service_address_lat: null,
              service_address_lng: null,
              raw: {},
            },
            {
              id: "job_null_status",
              work_status: null,
              is_emergency: false,
              is_commercial: false,
              total_amount_cents: 5000,
              scheduled_start: "2026-07-27T13:00:00.000Z",
              scheduled_end: "2026-07-27T14:00:00.000Z",
              technician_id: null,
              service_address_lat: null,
              service_address_lng: null,
              raw: {},
            },
            {
              id: "job_user_canceled",
              work_status: "user canceled",
              is_emergency: false,
              is_commercial: false,
              total_amount_cents: 5000,
              scheduled_start: "2026-07-27T14:00:00.000Z",
              scheduled_end: "2026-07-27T15:00:00.000Z",
              technician_id: null,
              service_address_lat: null,
              service_address_lng: null,
              raw: {},
            },
            {
              id: "job_pro_canceled_mixed_case",
              work_status: "Pro Canceled",
              is_emergency: false,
              is_commercial: false,
              total_amount_cents: 5000,
              scheduled_start: "2026-07-27T15:00:00.000Z",
              scheduled_end: "2026-07-27T16:00:00.000Z",
              technician_id: null,
              service_address_lat: null,
              service_address_lng: null,
              raw: {},
            },
          ],
          error: null,
        });
      }
      return makeQueryBuilder({ data: [], error: null });
    });

    const days = await getWeekAheadSchedule(new Date("2026-07-27T10:00:00Z"));
    expect(days[0].rows.map((r) => r.id)).toEqual(["job_scheduled", "job_null_status"]);
  });

  // DST regression: 2026-11-01 is the fall-back Sunday (clocks EDT -> EST at
  // 2am local), always the LAST day of a Monday-start week. A job scheduled
  // just before local midnight on that Sunday must still land in Sunday's
  // bucket (dateKey 2026-11-01), not spill into Monday 11-02.
  it("buckets correctly across the fall-back DST transition (week of 2026-10-26)", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "jobs") {
        return makeQueryBuilder({
          data: [
            {
              id: "job_fallback_sun",
              work_status: "scheduled",
              is_emergency: false,
              is_commercial: false,
              total_amount_cents: 1000,
              // 2026-11-01T23:30:00 EST == 2026-11-02T04:30:00Z. Late Sunday
              // night, well after the 2am transition, still calendar-day Sunday.
              scheduled_start: "2026-11-02T04:30:00.000Z",
              scheduled_end: "2026-11-02T05:00:00.000Z",
              technician_id: null,
              service_address_lat: null,
              service_address_lng: null,
              raw: {},
            },
          ],
          error: null,
        });
      }
      return makeQueryBuilder({ data: [], error: null });
    });

    const days = await getWeekAheadSchedule(new Date("2026-10-28T12:00:00Z")); // Wed in that week

    expect(days.map((d) => d.dateKey)).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
    expect(days[6].rows.map((r) => r.id)).toEqual(["job_fallback_sun"]);
  });

  // DST regression: 2026-03-08 is the spring-forward Sunday (EST -> EDT at
  // 2am local, a 23-hour day), again the last day of its Monday-start week.
  it("buckets correctly across the spring-forward DST transition (week of 2026-03-02)", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "jobs") {
        return makeQueryBuilder({
          data: [
            {
              id: "job_springfwd_sun",
              work_status: "scheduled",
              is_emergency: false,
              is_commercial: false,
              total_amount_cents: 1000,
              // 2026-03-08T10:00:00 EDT (post-transition) == 2026-03-08T14:00:00Z.
              scheduled_start: "2026-03-08T14:00:00.000Z",
              scheduled_end: "2026-03-08T15:00:00.000Z",
              technician_id: null,
              service_address_lat: null,
              service_address_lng: null,
              raw: {},
            },
          ],
          error: null,
        });
      }
      return makeQueryBuilder({ data: [], error: null });
    });

    const days = await getWeekAheadSchedule(new Date("2026-03-04T12:00:00Z")); // Wed in that week

    expect(days.map((d) => d.dateKey)).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
    ]);
    expect(days[6].rows.map((r) => r.id)).toEqual(["job_springfwd_sun"]);
  });
});
