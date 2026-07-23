import { describe, it, expect } from "vitest";
import { mapCustomer, mapJob } from "../mappers";

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
