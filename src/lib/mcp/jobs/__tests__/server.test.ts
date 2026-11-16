import { describe, it, expect, vi, afterEach } from "vitest";
import { CUSTOMER_HIT, SYNCED_AT, connect, stubDeps, text } from "./fixtures";

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

  it("finds customers and stamps the customers sync time", async () => {
    const queries: string[] = [];
    const { deps, freshnessCalls } = stubDeps({
      searchCustomers: async (q) => {
        queries.push(q);
        return [CUSTOMER_HIT];
      },
    });
    const client = await connect(deps);
    const body = JSON.parse(text(await client.callTool({ name: "find_customer", arguments: { query: "pat" } })));
    expect(queries).toEqual(["pat"]);
    expect(body).toMatchObject({ query: "pat", count: 1, dataAsOf: SYNCED_AT });
    expect(body.customers[0]).toEqual(CUSTOMER_HIT);
    expect(freshnessCalls).toEqual([["customers"]]);
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
