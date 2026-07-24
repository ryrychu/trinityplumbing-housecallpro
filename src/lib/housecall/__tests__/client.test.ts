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
});
