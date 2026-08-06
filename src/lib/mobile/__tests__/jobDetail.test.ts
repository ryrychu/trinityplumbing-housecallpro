import { describe, it, expect, vi, beforeEach } from "vitest";

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { getJobDetail } from "../jobDetail";

const JOB = {
  id: "job_3417",
  work_status: "scheduled",
  total_amount_cents: 248_000,
  scheduled_start: "2026-08-06T12:00:00Z",
  scheduled_end: "2026-08-06T14:00:00Z",
  technician_id: "tech_1",
  service_address_lat: 42.63,
  service_address_lng: -73.55,
  raw: {
    customer: { id: "cus_1", mobile_number: "(518) 555-0142" },
    address: { street: "14 Sliter Rd", city: "Averill Park" },
    job_fields: { job_type: { name: "Water Heater Replacement" } },
    work_timestamps: { on_my_way_at: "2026-08-06T11:40:00Z" },
    notes: [{ content: "Dog is friendly but loud.", created_by: "Ryan", created_at: "2026-07-30T15:00:00Z" }],
  },
};

function mockTables(tables: Record<string, { data: unknown; error: unknown }>) {
  supabaseMock.mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(tables[table] ?? { data: null, error: null }),
          limit: () => Promise.resolve(tables[table] ?? { data: [], error: null }),
        }),
      }),
    }),
  });
}

describe("getJobDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for an unknown job", async () => {
    mockTables({ jobs: { data: null, error: null } });
    expect(await getJobDetail("job_nope")).toBeNull();
  });

  it("maps the job's core fields", async () => {
    mockTables({
      jobs: { data: JOB, error: null },
      customers: { data: { id: "cus_1", first_name: "Margaret", last_name: "Kowalski", phone: "5185550142", address_line1: "14 Sliter Rd", city: "Averill Park" }, error: null },
      technicians: { data: { id: "tech_1", first_name: "Dylan", last_name: "R" }, error: null },
      invoices: { data: [], error: null },
    });

    const detail = await getJobDetail("job_3417");

    expect(detail?.customerName).toBe("Margaret Kowalski");
    expect(detail?.technicianName).toBe("Dylan R");
    expect(detail?.address).toBe("14 Sliter Rd, Averill Park");
    expect(detail?.service).toBe("Water Heater Replacement");
    expect(detail?.amountCents).toBe(248_000);
  });

  // HCP's work_status says "scheduled" here; on_my_way_at is what makes it
  // En Route. Reading only work_status would lose the state entirely.
  it("reports En Route when HCP stamped on_my_way_at", async () => {
    mockTables({
      jobs: { data: JOB, error: null },
      customers: { data: null, error: null },
      technicians: { data: null, error: null },
      invoices: { data: [], error: null },
    });
    expect((await getJobDetail("job_3417"))?.status).toBe("En Route");
  });

  it("stores the customer phone as digits for a tel: link", async () => {
    mockTables({
      jobs: { data: JOB, error: null },
      customers: { data: null, error: null },
      technicians: { data: null, error: null },
      invoices: { data: [], error: null },
    });
    expect((await getJobDetail("job_3417"))?.customerPhone).toBe("5185550142");
  });

  it("links the invoice, which HCP does populate with job_id", async () => {
    mockTables({
      jobs: { data: JOB, error: null },
      customers: { data: null, error: null },
      technicians: { data: null, error: null },
      invoices: { data: [{ id: "inv_4482", status: "open", amount_cents: 248_000 }], error: null },
    });
    expect((await getJobDetail("job_3417"))?.invoice).toEqual({
      id: "inv_4482",
      status: "open",
      amountCents: 248_000,
    });
  });

  it("returns notes oldest-first from the raw payload", async () => {
    mockTables({
      jobs: { data: JOB, error: null },
      customers: { data: null, error: null },
      technicians: { data: null, error: null },
      invoices: { data: [], error: null },
    });
    const notes = (await getJobDetail("job_3417"))?.notes;
    expect(notes).toHaveLength(1);
    expect(notes?.[0].content).toBe("Dog is friendly but loud.");
    expect(notes?.[0].author).toBe("Ryan");
  });
});
