import { describe, it, expect, vi, beforeEach } from "vitest";

const { orMock, supabaseMock } = vi.hoisted(() => ({ orMock: vi.fn(), supabaseMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { searchCustomers, getCustomerDetail } from "../customers";

beforeEach(() => {
  vi.clearAllMocks();
  orMock.mockReturnValue({
    limit: () =>
      Promise.resolve({
        data: [
          {
            id: "cus_1",
            first_name: "Margaret",
            last_name: "Kowalski",
            company: null,
            phone: "5185550142",
            address_line1: "14 Sliter Rd",
            city: "Averill Park",
          },
        ],
        error: null,
      }),
  });
  supabaseMock.mockReturnValue({ from: () => ({ select: () => ({ or: orMock }) }) });
});

describe("searchCustomers", () => {
  it("returns a formatted hit", async () => {
    const hits = await searchCustomers("kowalski");
    expect(hits).toEqual([
      {
        id: "cus_1",
        name: "Margaret Kowalski",
        phone: "5185550142",
        address: "14 Sliter Rd, Averill Park",
      },
    ]);
  });

  // The whole point of forgiving search: a typed-out phone number must reach
  // the digits stored in the column.
  it("searches phone columns with the digits, not the punctuation", async () => {
    await searchCustomers("(518) 555-0142");
    expect(orMock.mock.calls[0][0]).toContain("5185550142");
    expect(orMock.mock.calls[0][0]).not.toContain("(518)");
  });

  // The stored `phone` column's format is not guaranteed to be bare digits --
  // mapCustomer stores mobile_number verbatim, and other parts of the
  // codebase (slack/format.ts) explicitly assume it may carry punctuation.
  // A plain digit-substring match alone would return zero hits against a
  // punctuated column, silently, for every phone search. The separator-
  // tolerant pattern (`%` between each digit) must ride along in the same
  // filter so either storage shape matches.
  it("also includes a separator-tolerant pattern so a punctuated stored number still matches", async () => {
    await searchCustomers("5185550142");
    const filter = orMock.mock.calls[0][0];
    expect(filter).toContain("phone.ilike.%5185550142%");
    expect(filter).toContain("phone.ilike.%5%1%8%5%5%5%0%1%4%2%");
  });

  // Below the selectivity floor the tolerant pattern is skipped -- "518%5%1%8%"
  // would match almost anything and turn a 3-digit prefix search into a
  // near-unfiltered scan.
  it("omits the tolerant pattern for a short digit prefix", async () => {
    await searchCustomers("518");
    const filter = orMock.mock.calls[0][0];
    expect(filter).toContain("phone.ilike.%518%");
    expect(filter).not.toContain("5%1%8");
  });

  // A customer record stored with a punctuated phone number (the format
  // mapCustomer actually writes) must still come back with a normalized,
  // dialable digit string in the hit -- this is what makes tel: links work
  // regardless of how HCP happened to format the source data.
  it("normalizes a punctuated stored phone number in the result", async () => {
    orMock.mockReturnValue({
      limit: () =>
        Promise.resolve({
          data: [
            {
              id: "cus_9",
              first_name: "John",
              last_name: "Smith",
              company: null,
              phone: "(518) 555-0142",
              address_line1: null,
              city: null,
            },
          ],
          error: null,
        }),
    });
    const hits = await searchCustomers("smith");
    expect(hits[0].phone).toBe("5185550142");
  });

  it("searches name, company and address for a text query", async () => {
    await searchCustomers("sliter");
    const filter = orMock.mock.calls[0][0];
    for (const col of ["first_name", "last_name", "company", "address_line1", "city"]) {
      expect(filter).toContain(col);
    }
  });

  // A comma is PostgREST's `or()` separator; letting one through would corrupt
  // the filter and could widen the query beyond what was asked for.
  it("strips characters that would break the PostgREST filter", async () => {
    await searchCustomers("smith,*(");
    expect(orMock.mock.calls[0][0]).not.toContain(",*(");
  });

  it("returns nothing for a blank query rather than every customer", async () => {
    expect(await searchCustomers("   ")).toEqual([]);
    expect(orMock).not.toHaveBeenCalled();
  });

  // `%` and `_` are ilike metacharacters, not punctuation someone would type
  // in a name. Left unstripped, sanitize("%") is still truthy ("%"), so the
  // blank-query guard would pass it through and `first_name.ilike.%%%`
  // matches every row -- the exact "1,497 rows on a keystroke" failure the
  // guard exists to prevent, just reached through a different character.
  it("treats a query of only ilike metacharacters as blank", async () => {
    expect(await searchCustomers("%")).toEqual([]);
    expect(await searchCustomers("_")).toEqual([]);
    expect(orMock).not.toHaveBeenCalled();
  });
});

describe("getCustomerDetail", () => {
  const CUSTOMER = {
    id: "cus_1",
    first_name: "Margaret",
    last_name: "Kowalski",
    company: null,
    phone: "5185550142",
    email: "margaret@example.com",
    address_line1: "14 Sliter Rd",
    city: "Averill Park",
  };

  // Mirrors the two-table shape getCustomerDetail actually calls:
  // customers.select().eq().maybeSingle(), then jobs.select().eq().order().range().
  function mockSupabase(customer: unknown, jobs: unknown[]) {
    supabaseMock.mockReturnValue({
      from: (table: string) =>
        table === "customers"
          ? { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: customer, error: null }) }) }) }
          : {
              select: () => ({
                eq: () => ({
                  order: () => ({ range: () => Promise.resolve({ data: jobs, error: null }) }),
                }),
              }),
            },
    });
  }

  beforeEach(() => vi.clearAllMocks());

  // The live canceled statuses are "pro canceled" and "user canceled" -- with
  // a space, not an underscore. Getting that string wrong (as HCP's
  // work_status field has bitten this codebase before) would silently let
  // canceled work inflate lifetime value.
  it("excludes canceled jobs from lifetime value but keeps them in history", async () => {
    mockSupabase(CUSTOMER, [
      { id: "job_1", work_status: "complete rated", scheduled_start: "2026-01-03T00:00:00Z", total_amount_cents: 10_000, raw: {} },
      { id: "job_2", work_status: "pro canceled", scheduled_start: "2026-01-02T00:00:00Z", total_amount_cents: 5_000, raw: {} },
      { id: "job_3", work_status: "user canceled", scheduled_start: "2026-01-01T00:00:00Z", total_amount_cents: 7_000, raw: {} },
    ]);

    const detail = await getCustomerDetail("cus_1");

    expect(detail?.lifetimeCents).toBe(10_000);
    // Canceled work never happened financially, but it still shows in history
    // -- a dispatcher looking at "what happened with this customer" needs the
    // canceled visit on the record, just not counted as revenue.
    expect(detail?.jobs).toHaveLength(3);
  });

  // A customer's history and the job detail screen one tap away render the
  // same job. Passing work_status through raw made history read "complete
  // rated" / "pro canceled" / "in progress" while the job screen read
  // "Completed" / "Canceled" / "In Progress" -- the exact drift the shared
  // scheduleStatus() mapper exists to prevent. Fixtures use live HCP strings.
  it("maps history statuses to scheduleStatus() display labels, not raw HCP strings", async () => {
    mockSupabase(CUSTOMER, [
      { id: "job_1", work_status: "complete rated", scheduled_start: "2026-01-05T00:00:00Z", total_amount_cents: 10_000, raw: {} },
      { id: "job_2", work_status: "pro canceled", scheduled_start: "2026-01-04T00:00:00Z", total_amount_cents: 5_000, raw: {} },
      { id: "job_3", work_status: "in progress", scheduled_start: "2026-01-03T00:00:00Z", total_amount_cents: 7_000, raw: {} },
      { id: "job_4", work_status: "needs scheduling", scheduled_start: null, total_amount_cents: null, raw: {} },
    ]);

    const detail = await getCustomerDetail("cus_1");

    expect(detail?.jobs.map((j) => j.status)).toEqual([
      "Completed",
      "Canceled",
      "In Progress",
      "Needs Scheduling",
    ]);
  });

  // "En Route" has no work_status of its own -- it is derived from
  // raw.work_timestamps.on_my_way_at. History must show it for the same reason
  // the schedule does: the tech is already driving.
  it("derives En Route from the on-my-way timestamp", async () => {
    mockSupabase(CUSTOMER, [
      {
        id: "job_1",
        work_status: "scheduled",
        scheduled_start: "2026-01-05T00:00:00Z",
        total_amount_cents: 10_000,
        raw: { work_timestamps: { on_my_way_at: "2026-01-05T11:40:00Z" } },
      },
    ]);

    expect((await getCustomerDetail("cus_1"))?.jobs[0].status).toBe("En Route");
  });

  // scheduleStatus() returns null for a status it does not recognise rather
  // than echoing it. StatusPill renders nothing for null, so an unmapped value
  // disappears instead of showing lowercase HCP noise among title-cased pills.
  it("returns null for an unmapped status rather than echoing it raw", async () => {
    mockSupabase(CUSTOMER, [
      { id: "job_1", work_status: "some future hcp status", scheduled_start: null, total_amount_cents: null, raw: {} },
    ]);

    expect((await getCustomerDetail("cus_1"))?.jobs[0].status).toBeNull();
  });

  it("returns zero lifetime value and an empty history for a customer with no jobs", async () => {
    mockSupabase(CUSTOMER, []);

    const detail = await getCustomerDetail("cus_1");

    expect(detail?.lifetimeCents).toBe(0);
    expect(detail?.jobs).toEqual([]);
  });

  // A typo'd or deleted customer id must read as "not found" to the caller,
  // not throw and not fabricate a zeroed-out detail record.
  it("returns null for an unknown customer id", async () => {
    mockSupabase(null, []);

    expect(await getCustomerDetail("cus_nope")).toBeNull();
  });
});
