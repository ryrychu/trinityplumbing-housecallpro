import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertMock = vi.fn().mockResolvedValue({ error: null });
const fromMock = vi.fn(() => ({ upsert: upsertMock }));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseServerClient: () => ({ from: fromMock }),
}));

const enrichMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/geo/geocode", () => ({
  enrichRowsWithGeocode: (...args: unknown[]) => enrichMock(...args),
}));

import { syncOneRecord } from "../syncService";

const JOB_WITH_ADDRESS = {
  id: "j1",
  work_status: "scheduled",
  tags: [],
  address: { street: "1 Main St", city: "Austin", state: "TX", zip: "78701" },
};

describe("syncOneRecord", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps and upserts a job payload into the jobs table", async () => {
    await syncOneRecord("jobs", "job.updated", {
      id: "j1",
      work_status: "scheduled",
      tags: [],
    });

    expect(fromMock).toHaveBeenCalledWith("jobs");
    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({ id: "j1" }));
  });

  it("throws on an unknown resource type", async () => {
    await expect(syncOneRecord("widgets", "widget.updated", {})).rejects.toThrow(/widgets/);
  });

  // Housecall Pro's webhook payload shape is undocumented; `resource` may arrive
  // singular. These pin that either spelling routes to the same table.
  it.each([
    ["job", "jobs"],
    ["customer", "customers"],
    ["employee", "technicians"],
    ["estimate", "estimates"],
    ["invoice", "invoices"],
  ])("routes singular resource %s to the %s table", async (resource, table) => {
    await syncOneRecord(resource, `${resource}.updated`, { id: "x1", tags: [] });

    expect(fromMock).toHaveBeenCalledWith(table);
  });

  it("accepts a capitalised resource value", async () => {
    await syncOneRecord("Job", "job.updated", { id: "j1", tags: [] });

    expect(fromMock).toHaveBeenCalledWith("jobs");
  });

  // Regression guard: TABLE_AND_MAPPER and GEOCODE_SPECS are keyed on the same
  // strings. If the singular alias were applied to only the table lookup, this
  // record would be upserted with no coordinates and nothing would report it.
  it("still geocodes when the resource arrives singular", async () => {
    await syncOneRecord("job", "job.updated", JOB_WITH_ADDRESS);

    expect(enrichMock).toHaveBeenCalledTimes(1);
    const targets = enrichMock.mock.calls[0][1] as Array<{ parts: { city?: string } }>;
    expect(targets).toHaveLength(1);
    expect(targets[0].parts.city).toBe("Austin");
  });
});
