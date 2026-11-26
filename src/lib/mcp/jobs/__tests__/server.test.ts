import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CUSTOMER_CANDIDATE,
  GYM_CUSTOMER,
  NOW,
  SYNCED_AT,
  connect,
  gymJobs,
  jobCandidate,
  scheduleRow,
  stubDeps,
  text,
} from "./fixtures";
import { SERVER_INSTRUCTIONS, type JobsDeps } from "../server";

afterEach(() => vi.restoreAllMocks());

describe("createJobsMcpServer: customers and jobs", () => {
  it("marks every tool read-only", async () => {
    const client = await connect(stubDeps().deps);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("returns a customer's history with dates and money", async () => {
    const { deps, freshnessCalls } = stubDeps();
    const client = await connect(deps);
    const body = JSON.parse(
      text(await client.callTool({ name: "get_customer_history", arguments: { customerId: "cus_1" } }))
    );
    expect(body.found).toBe(true);
    expect(body.customer).toMatchObject({ id: "cus_1", name: "Pat Example", email: "pat@example.com" });
    expect(body).toMatchObject({ lifetime: "$525.00", lifetimeCents: 52500, jobCount: 2 });
    expect(body.jobs[0]).toEqual({
      id: "job_1",
      date: "2026-11-10",
      scheduledStart: "2026-11-10T14:30:00Z",
      service: "Drain cleaning",
      status: "Completed",
      amount: "$175.00",
      amountCents: 17500,
    });
    expect(body.jobs[1]).toMatchObject({ date: null, amount: "n/a", amountCents: null });
    expect(freshnessCalls).toEqual([["customers", "jobs"]]);
  });

  it("says when a customer doesn't exist, without an error", async () => {
    const client = await connect(stubDeps().deps);
    const res = await client.callTool({ name: "get_customer_history", arguments: { customerId: "nope" } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(text(res));
    expect(body.found).toBe(false);
    expect(body.note).toMatch(/find_customer/);
  });

  it("returns one job with its local time, invoice and notes", async () => {
    const { deps, freshnessCalls } = stubDeps();
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "get_job", arguments: { jobId: "job_1" } })));
    expect(body.found).toBe(true);
    expect(body.job).toMatchObject({
      id: "job_1",
      customerName: "Pat Example",
      technician: "Dan Tech",
      date: "2026-11-10",
      time: "9:30 AM",
      amount: "$175.00",
      amountCents: 17500,
      invoice: { id: "inv_1", status: "paid", amount: "$175.00", amountCents: 17500 },
    });
    expect(body.job.notes).toEqual([
      { content: "Cabled the main line.", author: "Dan Tech", createdAt: "2026-11-10T16:05:00Z" },
    ]);
    expect(freshnessCalls).toEqual([["jobs", "invoices"]]);
  });

  it("says when a job doesn't exist, without an error", async () => {
    const client = await connect(stubDeps().deps);
    const res = await client.callTool({ name: "get_job", arguments: { jobId: "nope" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res)).found).toBe(false);
  });

  it("hides the raw error when a query fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = stubDeps({
      getCustomerDetail: async () => {
        throw new Error("customers query failed: Pat Example, 12 Elm St");
      },
    });
    const client = await connect(deps);
    const res = await client.callTool({ name: "get_customer_history", arguments: { customerId: "cus_1" } });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toMatch(/Pat Example|Elm/);
    expect(text(res)).toMatch(/Try again/);
  });

  it("still answers when the sync time can't be read", async () => {
    const { deps } = stubDeps({ mirrorSyncedAt: async () => null });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "find_customer", arguments: { query: "pat" } })));
    expect(body.dataAsOf).toBeNull();
  });
});

describe("get_schedule", () => {
  function recording() {
    const calls: { anchor: string; days: number }[] = [];
    const getScheduleDays: JobsDeps["getScheduleDays"] = async (anchor, days) => {
      calls.push({ anchor: anchor.toISOString(), days });
      return [
        {
          dateKey: "2026-11-17",
          rows: [
            scheduleRow({ id: "job_a", technicianName: "Dan Tech" }),
            scheduleRow({ id: "job_b", technicianName: "Mike Other", scheduledStart: null }),
          ],
        },
        { dateKey: "2026-11-18", rows: [] },
      ];
    };
    return { calls, getScheduleDays };
  }

  it("defaults to 7 days from now", async () => {
    const { calls, getScheduleDays } = recording();
    const { deps, freshnessCalls } = stubDeps({ getScheduleDays });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "get_schedule", arguments: {} })));
    expect(calls).toEqual([{ anchor: NOW.toISOString(), days: 7 }]);
    expect(body).toMatchObject({ days: 7, technician: null, totalJobs: 2, dataAsOf: SYNCED_AT });
    expect(freshnessCalls).toEqual([["jobs", "customers"]]);
  });

  it("anchors a start date inside that Eastern day and labels each day", async () => {
    const { calls, getScheduleDays } = recording();
    const client = await connect(stubDeps({ getScheduleDays }).deps);
    const body = JSON.parse(
      text(await client.callTool({ name: "get_schedule", arguments: { startDate: "2026-11-17", days: 2 } }))
    );
    expect(calls).toEqual([{ anchor: "2026-11-17T16:00:00.000Z", days: 2 }]);
    expect(body.startDate).toBe("2026-11-17");
    expect(body.schedule.map((d: { label: string }) => d.label)).toEqual(["Tue Nov 17", "Wed Nov 18"]);
    expect(body.schedule[0].jobs[0]).toEqual({
      id: "job_a",
      time: "9:30 AM",
      scheduledStart: "2026-11-17T14:30:00Z",
      customer: "Pat Example",
      phone: "5185550142",
      address: "12 Elm St, Averill Park",
      service: "Drain cleaning",
      technician: "Dan Tech",
      status: "Scheduled",
      zone: "Averill Park",
    });
    expect(body.schedule[0].jobs[1].time).toBe("Time TBD");
  });

  it("filters by technician name, case-insensitively", async () => {
    const { getScheduleDays } = recording();
    const client = await connect(stubDeps({ getScheduleDays }).deps);
    const body = JSON.parse(
      text(await client.callTool({ name: "get_schedule", arguments: { technician: "dan" } }))
    );
    expect(body.totalJobs).toBe(1);
    expect(body.schedule[0]).toMatchObject({ jobCount: 1 });
    expect(body.schedule[0].jobs[0].id).toBe("job_a");
  });

  it("rejects a date that doesn't exist without querying", async () => {
    const { calls, getScheduleDays } = recording();
    const client = await connect(stubDeps({ getScheduleDays }).deps);
    const res = await client.callTool({ name: "get_schedule", arguments: { startDate: "2026-02-30" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/isn't a real date/);
    expect(calls).toHaveLength(0);
  });

  it("refuses more than 14 days without querying", async () => {
    const { calls, getScheduleDays } = recording();
    const client = await connect(stubDeps({ getScheduleDays }).deps);
    const res = await client
      .callTool({ name: "get_schedule", arguments: { days: 30 } })
      .catch(() => ({ isError: true }));
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses a start date outside 2000-2099 without querying", async () => {
    const { calls, getScheduleDays } = recording();
    const client = await connect(stubDeps({ getScheduleDays }).deps);
    const res = await client
      .callTool({ name: "get_schedule", arguments: { startDate: "9999-12-25" } })
      .catch(() => ({ isError: true }));
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses a whitespace-only technician without querying", async () => {
    const { calls, getScheduleDays } = recording();
    const client = await connect(stubDeps({ getScheduleDays }).deps);
    const res = await client
      .callTool({ name: "get_schedule", arguments: { technician: "   " } })
      .catch(() => ({ isError: true }));
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("trims the technician before filtering and echoing", async () => {
    const { getScheduleDays } = recording();
    const client = await connect(stubDeps({ getScheduleDays }).deps);
    const body = JSON.parse(
      text(await client.callTool({ name: "get_schedule", arguments: { technician: " dan " } }))
    );
    expect(body.technician).toBe("dan");
    expect(body.totalJobs).toBe(1);
    expect(body.schedule[0].jobs[0].id).toBe("job_a");
  });

  it("hides the raw error when the schedule query fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(
      stubDeps({
        getScheduleDays: async () => {
          throw new Error("jobs query failed: Pat Example");
        },
      }).deps
    );
    const res = await client.callTool({ name: "get_schedule", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toMatch(/Pat Example/);
  });
});

describe("get_money_summary", () => {
  it("totals open estimates, unpaid invoices and revenue", async () => {
    const { deps, freshnessCalls } = stubDeps({
      listOpenEstimates: async () => [
        { id: "est_1", customerId: "cus_1", customerName: "Pat Example", amountCents: 125000, status: null },
      ],
      listUnpaidInvoices: async () => [
        { id: "inv_2", customerId: "cus_1", customerName: "Pat Example", amountCents: 40000, status: "open", dueDate: "2026-11-01", overdueDays: 16 },
        { id: "inv_3", customerId: null, customerName: null, amountCents: null, status: "open", dueDate: null, overdueDays: null },
      ],
      getRevenue: async () => ({ revenueBookedThisWeekCents: 350000, revenueScheduledNextWeekCents: 0 }),
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "get_money_summary", arguments: {} })));

    expect(body.openEstimates).toMatchObject({ count: 1, total: "$1,250.00", totalCents: 125000, missingAmountCount: 0 });
    expect(body.openEstimates.items[0]).toMatchObject({ id: "est_1", amount: "$1,250.00", amountCents: 125000 });
    expect(body.unpaidInvoices).toMatchObject({ count: 2, overdueCount: 1, total: "$400.00", totalCents: 40000, missingAmountCount: 1 });
    expect(body.unpaidInvoices.items[1]).toMatchObject({ id: "inv_3", amount: "n/a", amountCents: null });
    expect(body).toMatchObject({
      revenueBookedThisWeek: "$3,500.00",
      revenueBookedThisWeekCents: 350000,
      revenueScheduledNextWeek: "$0.00",
      revenueScheduledNextWeekCents: 0,
      dataAsOf: SYNCED_AT,
    });
    expect(freshnessCalls).toEqual([["estimates", "invoices", "jobs"]]);
  });

  it("hides the raw error when a money query fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(
      stubDeps({
        listUnpaidInvoices: async () => {
          throw new Error("invoices query failed: Pat Example");
        },
      }).deps
    );
    const res = await client.callTool({ name: "get_money_summary", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).not.toMatch(/Pat Example/);
  });

  it("registers exactly the seven tools", async () => {
    const client = await connect(stubDeps().deps);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "find_customer",
      "get_customer_history",
      "get_job",
      "get_money_summary",
      "get_schedule",
      "get_site_traffic",
      "search_jobs",
    ]);
  });
});

describe("find_customer", () => {
  it("finds a customer by any saved address and says which words matched", async () => {
    const calls: Array<[string[], string | null]> = [];
    const { deps, freshnessCalls } = stubDeps({
      findCustomerCandidates: async (terms, phone) => {
        calls.push([terms, phone]);
        return { candidates: [CUSTOMER_CANDIDATE, GYM_CUSTOMER], capped: false };
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(
      text(await client.callTool({ name: "find_customer", arguments: { query: "planet fitness on aviation rd" } }))
    );

    expect(calls).toEqual([[["planet", "fitness", "aviation"], null]]);
    expect(body).toMatchObject({
      query: "planet fitness on aviation rd",
      terms: ["planet", "fitness", "aviation"],
      matchedTerms: ["aviation"],
      unmatchedTerms: ["planet", "fitness"],
      count: 1,
      truncated: false,
      dataAsOf: SYNCED_AT,
    });
    expect(body.customers).toEqual([
      {
        id: "cus_gym",
        name: "Kay Example",
        company: "Gymco",
        phone: null,
        address: "10 Main St, Albany",
        addressCount: 13,
        matchedAddresses: ["99 Aviation Road, Queensbury"],
        matched: [{ term: "aviation", on: "address" }],
      },
    ]);
    expect(body.note).toBe(
      'Nothing in Trinity\'s records mentions "planet", "fitness". These customers matched "aviation". Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer.'
    );
    expect(freshnessCalls).toEqual([["customers"]]);
  });

  it("still finds a customer by phone number", async () => {
    const calls: Array<[string[], string | null]> = [];
    const { deps } = stubDeps({
      findCustomerCandidates: async (terms, phone) => {
        calls.push([terms, phone]);
        return { candidates: [CUSTOMER_CANDIDATE], capped: false };
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "find_customer", arguments: { query: "518-555-0142" } })));
    expect(calls).toEqual([[[], "5185550142"]]);
    expect(body.terms).toEqual(["5185550142"]);
    expect(body.customers[0]).toMatchObject({ id: "cus_1", matched: [{ term: "5185550142", on: "phone" }] });
    expect(body.note).toBeUndefined();
  });

  it("flags results past the match cap", async () => {
    const { deps } = stubDeps({
      findCustomerCandidates: async () => ({
        candidates: Array.from({ length: 30 }, (_, i) => ({ ...CUSTOMER_CANDIDATE, id: `cus_${i}`, lastName: "Smith" })),
        capped: false,
      }),
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "find_customer", arguments: { query: "smith" } })));
    expect(body.count).toBe(25);
    expect(body.truncated).toBe(true);
    expect(body.note).toBe("Showing the first 25; ask the user for the customer's name or street to narrow it down.");
  });

  it("marks the result truncated and incomplete when a query hit its cap", async () => {
    const { deps } = stubDeps({
      findCustomerCandidates: async () => ({ candidates: [GYM_CUSTOMER], capped: true }),
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "find_customer", arguments: { query: "aviation" } })));
    expect(body.truncated).toBe(true);
    expect(body.note).toContain("this list may be incomplete; ask the user for the customer's name or street");
  });

  it("asks for something to search when the question is only filler, without querying", async () => {
    let queried = false;
    const { deps } = stubDeps({
      findCustomerCandidates: async () => {
        queried = true;
        return { candidates: [], capped: false };
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "find_customer", arguments: { query: "find the customer" } })));
    expect(queried).toBe(false);
    expect(body).toMatchObject({ count: 0, customers: [], note: "Give a name, business, street, town or phone number to search for." });
  });

  it("hides the raw error when the search fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = stubDeps({
      findCustomerCandidates: async () => {
        throw new Error("customer search failed: Pat Example, 12 Elm St");
      },
    });
    const client = await connect(deps);
    const res = await client.callTool({ name: "find_customer", arguments: { query: "pat" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Couldn't search customers just now. Try again in a minute.");
  });
});

describe("search_jobs", () => {
  it("finds the gym's jobs by street and asks to confirm the business name", async () => {
    const calls: string[][] = [];
    const { deps, freshnessCalls } = stubDeps({
      findJobCandidates: async (terms) => {
        calls.push(terms);
        return { candidates: gymJobs(), capped: false };
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(
      text(
        await client.callTool({
          name: "search_jobs",
          arguments: { query: "find the jobs we did at planet fitness on aviation rd" },
        })
      )
    );

    expect(calls).toEqual([["planet", "fitness", "aviation"]]);
    expect(body).toMatchObject({
      terms: ["planet", "fitness", "aviation"],
      matchedTerms: ["aviation"],
      unmatchedTerms: ["planet", "fitness"],
      count: 10,
      truncated: false,
      dataAsOf: SYNCED_AT,
    });
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual(gymJobs().map((j) => j.id));
    expect(body.jobs[0]).toEqual({
      id: "job_g1",
      date: "2026-11-23",
      time: "1:00 PM",
      status: "Scheduled",
      service: "Commercial Service Call Fee",
      address: "99 Aviation Road, Queensbury",
      customer: "Kay Example",
      company: "Gymco",
      customerId: "cus_gym",
      amount: "$250.00",
      amountCents: 25000,
      matched: [{ term: "aviation", on: "job address" }],
    });
    expect(body.jobs[1].status).toBe("Completed");
    expect(body.note).toBe(
      'Nothing in Trinity\'s records mentions "planet", "fitness". These jobs matched "aviation". Show them to the user, say which words matched, and ask whether these are what they meant before treating them as the answer.'
    );
    expect(freshnessCalls).toEqual([["jobs", "customers"]]);
  });

  it("puts jobs matching more of the words first", async () => {
    const { deps } = stubDeps({
      findJobCandidates: async () => ({
        candidates: [
          ...gymJobs(),
          jobCandidate({ id: "job_p", scheduledStart: "2024-01-01T15:00:00Z", description: "Planet Fitness locker room" }),
        ],
        capped: false,
      }),
    });
    const client = await connect(deps);
    const body = JSON.parse(
      text(await client.callTool({ name: "search_jobs", arguments: { query: "planet fitness aviation" } }))
    );
    expect(body.jobs[0].id).toBe("job_p");
    expect(body.unmatchedTerms).toEqual([]);
    expect(body.note).toBeUndefined();
  });

  it("asks for another detail when nothing matches", async () => {
    const { deps } = stubDeps({ findJobCandidates: async () => ({ candidates: [jobCandidate({ id: "job_z" })], capped: false }) });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "search_jobs", arguments: { query: "zebra" } })));
    expect(body).toMatchObject({ count: 0, jobs: [], unmatchedTerms: ["zebra"] });
    expect(body.note).toBe(
      'Nothing in Trinity\'s records matched "zebra". Ask the user for another detail: the street or town, the customer\'s name, or roughly when the work was done.'
    );
  });

  it("caps at 50 jobs and says so", async () => {
    const { deps } = stubDeps({
      findJobCandidates: async () => ({
        candidates: Array.from({ length: 60 }, (_, i) => jobCandidate({ id: `job_${i}` })),
        capped: false,
      }),
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "search_jobs", arguments: { query: "aviation" } })));
    expect(body.count).toBe(50);
    expect(body.truncated).toBe(true);
    expect(body.note).toBe("Showing the first 50; ask the user for a date, house number or customer name to narrow it down.");
  });

  it("marks the result truncated and incomplete when a query hit its cap", async () => {
    const { deps } = stubDeps({
      findJobCandidates: async () => ({ candidates: gymJobs(), capped: true }),
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "search_jobs", arguments: { query: "aviation" } })));
    expect(body.truncated).toBe(true);
    expect(body.note).toContain("this list may be incomplete; ask the user for a date, house number or customer name");
  });

  it("asks for something to search when the question is only filler, without querying", async () => {
    let queried = false;
    const { deps } = stubDeps({
      findJobCandidates: async () => {
        queried = true;
        return { candidates: [], capped: false };
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "search_jobs", arguments: { query: "show me the jobs" } })));
    expect(queried).toBe(false);
    expect(body).toMatchObject({ count: 0, jobs: [], note: "Give a street, town, business or customer name, or kind of work to search for. To find jobs by phone number, use find_customer, then get_customer_history." });
  });

  it("hides the raw error when the search fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = stubDeps({
      findJobCandidates: async () => {
        throw new Error("job search failed: Kay Example, 99 Aviation Road");
      },
    });
    const client = await connect(deps);
    const res = await client.callTool({ name: "search_jobs", arguments: { query: "aviation" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Couldn't search jobs just now. Try again in a minute.");
  });
});

describe("server instructions", () => {
  it("tells ChatGPT to confirm partial matches with the user", async () => {
    const client = await connect(stubDeps().deps);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).toContain("unmatchedTerms");
    expect(SERVER_INSTRUCTIONS).toContain("search_jobs");
  });

  it("points website traffic questions at get_site_traffic", () => {
    expect(SERVER_INSTRUCTIONS).toContain("get_site_traffic");
  });
});
