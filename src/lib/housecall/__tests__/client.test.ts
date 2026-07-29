import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HousecallClient } from "../client";

const originalFetch = global.fetch;

describe("HousecallClient", () => {
  beforeEach(() => {
    process.env.HOUSECALL_API_KEY = "test-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("sends the API key as a Bearer token", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ customers: [{ id: "c1" }], page: 1, total_pages: 1 }),
    });

    const client = new HousecallClient();
    await client.listCustomers();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://api.housecallpro.com/customers"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      })
    );
  });

  it("returns items, page, and totalPages from the response envelope", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ customers: [{ id: "c1" }, { id: "c2" }], page: 1, total_pages: 3 }),
    });

    const client = new HousecallClient();
    const result = await client.listCustomers();

    expect(result.items).toHaveLength(2);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(3);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid token",
    });

    const client = new HousecallClient();
    await expect(client.listCustomers()).rejects.toThrow(/401/);
  });

  it("throws immediately if HOUSECALL_API_KEY is not set", () => {
    delete process.env.HOUSECALL_API_KEY;
    expect(() => new HousecallClient()).toThrow(/HOUSECALL_API_KEY/);
  });

  // HCP omits attachments from list responses unless explicitly expanded
  // ("Only present if expanded with attachments" — OpenAPI Attachment schema).
  // Without this, every synced record carried no attachments key at all and the
  // attachments table could never populate from the cron path.
  it("expands attachments for jobs and customers", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jobs: [], customers: [], page: 1, total_pages: 1 }),
    });

    const client = new HousecallClient();
    await client.listJobs();
    await client.listCustomers();

    const urls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url).toContain("expand[]=attachments");
  });

  it("does not expand attachments for resources that carry none", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ estimates: [], invoices: [], leads: [], employees: [], page: 1, total_pages: 1 }),
    });

    const client = new HousecallClient();
    await client.listEstimates();
    await client.listInvoices();
    await client.listLeads();
    await client.listEmployees();

    for (const call of vi.mocked(global.fetch).mock.calls) {
      expect(String(call[0])).not.toContain("expand[]");
    }
  });

  it("listLeads fetches /leads with the leads resource key", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ leads: [{ id: "lead_1" }], page: 1, total_pages: 1 }),
    });

    const client = new HousecallClient();
    const result = await client.listLeads(1);

    expect(result.items).toEqual([{ id: "lead_1" }]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/leads"),
      expect.anything()
    );
  });

  describe("listPaidInvoicesSince", () => {
    it("requests only paid invoices at or after the watermark, newest first", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ invoices: [{ id: "inv_1" }], page: 1, total_pages: 1 }),
      });

      const client = new HousecallClient();
      const result = await client.listPaidInvoicesSince("2026-07-29T00:00:00Z");

      expect(result.items).toEqual([{ id: "inv_1" }]);
      const url = vi.mocked(global.fetch).mock.calls[0][0] as string;
      expect(url).toContain("/invoices?");
      // Array form, unencoded brackets. Bare `status=paid` returns 422
      // "must be an array" on the live API (probe, 2026-07-29).
      expect(url).toContain("status[]=paid");
      expect(url).toContain("paid_at_min=2026-07-29T00%3A00%3A00Z");
      expect(url).toContain("sort_by=paid_at");
      expect(url).toContain("sort_direction=desc");
    });

    it("omits paid_at_min entirely on a null watermark", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ invoices: [], page: 1, total_pages: 1 }),
      });

      await new HousecallClient().listPaidInvoicesSince(null);
      expect(vi.mocked(global.fetch).mock.calls[0][0]).not.toContain("paid_at_min");
    });
  });
});
