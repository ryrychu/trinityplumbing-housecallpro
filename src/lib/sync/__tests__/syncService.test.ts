import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertMock = vi.fn().mockResolvedValue({ error: null });
const eqMock = vi.fn().mockResolvedValue({ error: null });
const deleteMock = vi.fn(() => ({ eq: eqMock }));

// The "attachments" table gets its own chain, distinct from `deleteMock`/`eqMock`,
// so that a cascade-delete of attachments (triggered when a customer/job row is
// deleted) doesn't get counted against assertions on the primary table's delete
// chain. Its `.eq()` is chainable (unlike the primary chain's single-shot `eq`)
// because syncOneRecord's attachment cascade calls `.eq().eq()`.
const attachmentsEqMock = vi.fn(() => attachmentsChain);
const attachmentsChain = Object.assign(Promise.resolve({ error: null }), {
  eq: attachmentsEqMock,
});
const attachmentsDeleteMock = vi.fn(() => attachmentsChain);
const attachmentsUpsertMock = vi.fn().mockResolvedValue({ error: null });

const fromMock = vi.fn((table: string) => {
  if (table === "attachments") {
    return { upsert: attachmentsUpsertMock, delete: attachmentsDeleteMock };
  }
  return { upsert: upsertMock, delete: deleteMock };
});

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseServerClient: () => ({ from: fromMock }),
}));

// Adapted from the task brief's helper: this file already wires a shared,
// table-aware `fromMock` via vi.mock above, so `installSupabaseMock` just
// hands back references to it rather than installing a second mock.
function installSupabaseMock() {
  return { upsert: upsertMock, eq: eqMock, del: deleteMock, from: fromMock };
}

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

describe("syncOneRecord leads + delete", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes a singular 'lead' resource to the leads table", async () => {
    const { upsert, from } = installSupabaseMock();
    await syncOneRecord("lead", "lead.created", { id: "lead_1" });
    expect(from).toHaveBeenCalledWith("leads");
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("routes 'pro' to the technicians table", async () => {
    const { from } = installSupabaseMock();
    await syncOneRecord("pro", "pro.updated", { id: "emp_1" });
    expect(from).toHaveBeenCalledWith("technicians");
  });

  it("deletes instead of upserting when action is 'deleted'", async () => {
    const { del, eq, from } = installSupabaseMock();
    await syncOneRecord("customer", "customer.deleted", { id: "c1" }, "deleted");
    expect(from).toHaveBeenCalledWith("customers");
    expect(del).toHaveBeenCalledOnce();
    expect(eq).toHaveBeenCalledWith("id", "c1");
  });
});
