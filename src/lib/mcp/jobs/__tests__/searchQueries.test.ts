import { describe, it, expect, vi, beforeEach } from "vitest";

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { findCustomerCandidates, findJobCandidates } from "../searchQueries";

interface Call {
  table: string;
  select?: string;
  or?: string;
  in?: [string, string[]];
  limit?: number;
}
type Reply = { data: unknown[] | null; error: { message: string } | null };

// A stand-in Supabase client: records each query and answers it with
// `respond`. Every builder method returns the builder; awaiting it resolves.
function fakeSupabase(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  supabaseMock.mockReturnValue({
    from(table: string) {
      const call: Call = { table };
      calls.push(call);
      const builder = {
        select(columns: string) {
          call.select = columns;
          return builder;
        },
        or(filter: string) {
          call.or = filter;
          return builder;
        },
        in(column: string, ids: string[]) {
          call.in = [column, ids];
          return builder;
        },
        limit(n: number) {
          call.limit = n;
          return builder;
        },
        then(resolve: (v: Reply) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(respond(call)).then(resolve, reject);
        },
      };
      return builder;
    },
  });
  return calls;
}

const JOB_ROW = {
  id: "job_1",
  customer_id: "cus_gym",
  scheduled_start: "2026-03-09T17:00:00Z",
  work_status: "complete rated",
  total_amount_cents: 25000,
  street: "99 Aviation Road",
  city: "Queensbury",
  description: "Replace toilet flange",
  job_type: null,
  on_my_way_at: null,
};

beforeEach(() => vi.clearAllMocks());

describe("findJobCandidates", () => {
  it("searches job fields and customer names, then attaches customers", async () => {
    const calls = fakeSupabase((c) => {
      if (c.table === "jobs" && c.or) return { data: [JOB_ROW], error: null };
      if (c.table === "customers" && c.or) return { data: [{ id: "cus_two" }], error: null };
      if (c.table === "jobs" && c.in) {
        return { data: [JOB_ROW, { ...JOB_ROW, id: "job_2", customer_id: "cus_two" }], error: null };
      }
      if (c.table === "customers" && c.in) {
        return {
          data: [
            { id: "cus_gym", first_name: "Kay ", last_name: "Example", company: "Gymco ", tags: ["planet fitness"] },
            { id: "cus_two", first_name: null, last_name: null, company: null, tags: null },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });

    const result = await findJobCandidates(["aviation"]);

    const jobSearch = calls.find((c) => c.table === "jobs" && c.or)!;
    expect(jobSearch.or).toBe(
      "raw->address->>street.ilike.%aviation%,raw->address->>city.ilike.%aviation%,raw->>description.ilike.%aviation%,raw->job_fields->job_type->>name.ilike.%aviation%"
    );
    expect(jobSearch.select).toContain("street:raw->address->>street");
    expect(jobSearch.select).toContain("on_my_way_at:raw->work_timestamps->>on_my_way_at");
    expect(jobSearch.limit).toBe(200);

    const customerSearch = calls.find((c) => c.table === "customers" && c.or)!;
    expect(customerSearch.or).toBe(
      "first_name.ilike.%aviation%,last_name.ilike.%aviation%,company.ilike.%aviation%,raw->>tags.ilike.%aviation%"
    );
    expect(customerSearch.limit).toBe(50);

    const theirJobs = calls.find((c) => c.table === "jobs" && c.in)!;
    expect(theirJobs.in).toEqual(["customer_id", ["cus_two"]]);
    expect(theirJobs.limit).toBe(300);

    // job_1 came back from both searches but appears once.
    expect(result.map((j) => j.id)).toEqual(["job_1", "job_2"]);
    expect(result[0]).toEqual({
      id: "job_1",
      customerId: "cus_gym",
      scheduledStart: "2026-03-09T17:00:00Z",
      workStatus: "complete rated",
      onMyWayAt: null,
      amountCents: 25000,
      street: "99 Aviation Road",
      city: "Queensbury",
      description: "Replace toilet flange",
      jobType: null,
      customer: { id: "cus_gym", name: "Kay Example", company: "Gymco", tags: ["planet fitness"] },
    });
    expect(result[1].customer).toEqual({ id: "cus_two", name: null, company: null, tags: [] });
  });

  it("skips the customer-jobs query when no customer matched", async () => {
    const calls = fakeSupabase((c) => (c.table === "jobs" && c.or ? { data: [JOB_ROW], error: null } : { data: [], error: null }));
    await findJobCandidates(["aviation"]);
    expect(calls.some((c) => c.table === "jobs" && c.in)).toBe(false);
  });

  it("throws on a query error", async () => {
    fakeSupabase((c) => (c.table === "jobs" ? { data: null, error: { message: "boom" } } : { data: [], error: null }));
    await expect(findJobCandidates(["aviation"])).rejects.toThrow("job search failed: boom");
  });

  it("does not query when there are no words", async () => {
    const calls = fakeSupabase(() => ({ data: [], error: null }));
    expect(await findJobCandidates([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("findCustomerCandidates", () => {
  const CUSTOMER_ROW = {
    id: "cus_gym",
    first_name: "Kay ",
    last_name: "Example",
    company: "Gymco ",
    phone: "5185550142",
    city: "Albany",
    notes: null,
    tags: ["planet fitness"],
    addresses: [
      { street: "10 Main St", city: "Albany", zip: "12205" },
      { street: "99 Aviation Road", city: "Queensbury" },
    ],
  };

  it("searches every saved address, tags and notes, one query per word", async () => {
    const calls = fakeSupabase(() => ({ data: [CUSTOMER_ROW], error: null }));
    const result = await findCustomerCandidates(["aviation", "gymco"], null);

    expect(calls).toHaveLength(2);
    expect(calls[0].or).toBe(
      "first_name.ilike.%aviation%,last_name.ilike.%aviation%,company.ilike.%aviation%,city.ilike.%aviation%,notes.ilike.%aviation%,raw->>addresses.ilike.%aviation%,raw->>tags.ilike.%aviation%"
    );
    expect(calls[0].select).toContain("addresses:raw->addresses");
    expect(calls[0].limit).toBe(50);

    // Same customer from both words appears once.
    expect(result).toEqual([
      {
        id: "cus_gym",
        firstName: "Kay ",
        lastName: "Example",
        company: "Gymco ",
        phone: "5185550142",
        city: "Albany",
        notes: null,
        tags: ["planet fitness"],
        addresses: [
          { street: "10 Main St", city: "Albany" },
          { street: "99 Aviation Road", city: "Queensbury" },
        ],
      },
    ]);
  });

  it("searches the phone the same two ways the mobile search does", async () => {
    const calls = fakeSupabase(() => ({ data: [], error: null }));
    await findCustomerCandidates([], "5185550142");
    expect(calls).toHaveLength(1);
    expect(calls[0].or).toBe("phone.ilike.%5185550142%,phone.ilike.%5%1%8%5%5%5%0%1%4%2%");
  });

  it("treats a missing or malformed address list as no addresses", async () => {
    fakeSupabase(() => ({ data: [{ ...CUSTOMER_ROW, addresses: null, tags: null }], error: null }));
    const [c] = await findCustomerCandidates(["gymco"], null);
    expect(c.addresses).toEqual([]);
    expect(c.tags).toEqual([]);
  });

  it("throws on a query error", async () => {
    fakeSupabase(() => ({ data: null, error: { message: "boom" } }));
    await expect(findCustomerCandidates(["gymco"], null)).rejects.toThrow("customer search failed: boom");
  });

  it("does not query when there is nothing to search", async () => {
    const calls = fakeSupabase(() => ({ data: [], error: null }));
    expect(await findCustomerCandidates([], null)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
