import { describe, it, expect, vi, beforeEach } from "vitest";

const { orMock, supabaseMock } = vi.hoisted(() => ({ orMock: vi.fn(), supabaseMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { searchCustomers } from "../customers";

beforeEach(() => {
  vi.clearAllMocks();
  orMock.mockReturnValue({
    limit: () =>
      Promise.resolve({
        data: [
          {
            id: "cus_1",
            first_name: "Margaret",
            last_name: "Kowalski",
            company: null,
            phone: "5185550142",
            address_line1: "14 Sliter Rd",
            city: "Averill Park",
          },
        ],
        error: null,
      }),
  });
  supabaseMock.mockReturnValue({ from: () => ({ select: () => ({ or: orMock }) }) });
});

describe("searchCustomers", () => {
  it("returns a formatted hit", async () => {
    const hits = await searchCustomers("kowalski");
    expect(hits).toEqual([
      {
        id: "cus_1",
        name: "Margaret Kowalski",
        phone: "5185550142",
        address: "14 Sliter Rd, Averill Park",
      },
    ]);
  });

  // The whole point of forgiving search: a typed-out phone number must reach
  // the digits stored in the column.
  it("searches phone columns with the digits, not the punctuation", async () => {
    await searchCustomers("(518) 555-0142");
    expect(orMock.mock.calls[0][0]).toContain("5185550142");
    expect(orMock.mock.calls[0][0]).not.toContain("(518)");
  });

  it("searches name, company and address for a text query", async () => {
    await searchCustomers("sliter");
    const filter = orMock.mock.calls[0][0];
    for (const col of ["first_name", "last_name", "company", "address_line1", "city"]) {
      expect(filter).toContain(col);
    }
  });

  // A comma is PostgREST's `or()` separator; letting one through would corrupt
  // the filter and could widen the query beyond what was asked for.
  it("strips characters that would break the PostgREST filter", async () => {
    await searchCustomers("smith,*(");
    expect(orMock.mock.calls[0][0]).not.toContain(",*(");
  });

  it("returns nothing for a blank query rather than every customer", async () => {
    expect(await searchCustomers("   ")).toEqual([]);
    expect(orMock).not.toHaveBeenCalled();
  });
});
