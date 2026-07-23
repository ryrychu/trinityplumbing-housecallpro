import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertMock = vi.fn().mockResolvedValue({ error: null });
// sync_cursors read: from("sync_cursors").select(...) resolves to no cursors, so
// every resource does a full backfill in this test.
const selectMock = vi.fn().mockResolvedValue({ data: [], error: null });
const fromMock = vi.fn(() => ({ upsert: upsertMock, select: selectMock }));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseServerClient: () => ({ from: fromMock }),
}));

vi.mock("@/lib/housecall/client", () => ({
  HousecallClient: vi.fn().mockImplementation(function () {
    return {
      listCustomers: vi.fn().mockResolvedValue({ items: [{ id: "c1" }], page: 1, totalPages: 1 }),
      listEmployees: vi.fn().mockResolvedValue({ items: [{ id: "e1" }], page: 1, totalPages: 1 }),
      listJobs: vi.fn().mockResolvedValue({ items: [{ id: "j1", tags: [] }], page: 1, totalPages: 1 }),
      listEstimates: vi.fn().mockResolvedValue({ items: [{ id: "es1" }], page: 1, totalPages: 1 }),
      listInvoices: vi.fn().mockResolvedValue({ items: [{ id: "i1" }], page: 1, totalPages: 1 }),
    };
  }),
}));

import { GET } from "../route";

describe("GET /api/cron/sync", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
    vi.clearAllMocks();
  });

  it("rejects requests without the correct cron secret", async () => {
    const req = new Request("https://example.com/api/cron/sync");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("upserts every resource type when authorized", async () => {
    const req = new Request("https://example.com/api/cron/sync", {
      headers: { Authorization: "Bearer test-cron-secret" },
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(fromMock).toHaveBeenCalledWith("customers");
    expect(fromMock).toHaveBeenCalledWith("technicians");
    expect(fromMock).toHaveBeenCalledWith("jobs");
    expect(fromMock).toHaveBeenCalledWith("estimates");
    expect(fromMock).toHaveBeenCalledWith("invoices");
  });
});
