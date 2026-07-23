import { describe, it, expect } from "vitest";
import { mapCustomer, mapJob, mapEstimate, mapInvoice } from "../mappers";

describe("mapCustomer", () => {
  it("flattens the first address into lat/lng and address fields", () => {
    const row = mapCustomer({
      id: "c1",
      first_name: "Jane",
      last_name: "Doe",
      email: "jane@example.com",
      addresses: [
        {
          street: "123 Main St",
          city: "Delmar",
          state: "NY",
          zip: "12054",
          latitude: 42.6217,
          longitude: -73.8365,
        },
      ],
    });

    expect(row.id).toBe("c1");
    expect(row.city).toBe("Delmar");
    expect(row.lat).toBe(42.6217);
    expect(row.lng).toBe(-73.8365);
  });
});

describe("mapJob", () => {
  it("flags a job as emergency based on its tags", () => {
    const row = mapJob({
      id: "j1",
      work_status: "scheduled",
      tags: [{ id: "t1", name: "Emergency" }],
      customer: { id: "c1" },
    });

    expect(row.is_emergency).toBe(true);
    expect(row.customer_id).toBe("c1");
  });

  it("flags a job as commercial based on its tags", () => {
    const row = mapJob({
      id: "j2",
      work_status: "scheduled",
      tags: [{ id: "t2", name: "Commercial" }],
    });

    expect(row.is_commercial).toBe(true);
  });
});

describe("mapEstimate", () => {
  // Live API (Task 0): estimates expose `work_status`, not `status`, and their
  // dollar amount lives on the first option's `total_amount` (cents), not on
  // the estimate itself.
  it("maps work_status into status and options[0].total_amount into amount_cents", () => {
    const row = mapEstimate({
      id: "e1",
      customer: { id: "c1" },
      work_status: "scheduled",
      options: [{ total_amount: 150000, approval_status: "pending" }],
    });

    expect(row.id).toBe("e1");
    expect(row.customer_id).toBe("c1");
    expect(row.status).toBe("scheduled");
    expect(row.amount_cents).toBe(150000);
  });

  it("defaults status and amount_cents to null when the fields are absent", () => {
    const row = mapEstimate({ id: "e2" });

    expect(row.status).toBeNull();
    expect(row.amount_cents).toBeNull();
    expect(row.job_id).toBeNull();
    expect(row.customer_id).toBeNull();
  });
});

describe("mapInvoice", () => {
  // Live API (Task 0): the invoice total field is `amount` (cents), not
  // `total_amount`.
  it("maps amount into amount_cents, job_id passthrough, and truncates due_at to a date", () => {
    const row = mapInvoice({
      id: "i1",
      // Live invoices (probe) carry job_id directly — unlike estimates, this is
      // the reliable invoice->job link, no derivation needed.
      job_id: "job_a955",
      customer: { id: "c1" },
      status: "pending",
      amount: 30000,
      due_at: "2026-08-01T00:00:00Z",
    });

    expect(row.id).toBe("i1");
    expect(row.job_id).toBe("job_a955");
    expect(row.customer_id).toBe("c1");
    expect(row.status).toBe("pending");
    expect(row.amount_cents).toBe(30000);
    expect(row.due_date).toBe("2026-08-01");
  });

  it("defaults amount_cents and due_date to null when absent", () => {
    const row = mapInvoice({ id: "i2" });

    expect(row.amount_cents).toBeNull();
    expect(row.due_date).toBeNull();
  });
});
