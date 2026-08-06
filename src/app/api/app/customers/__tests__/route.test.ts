import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CustomerHit } from "@/lib/mobile/customers";

const { searchCustomersMock } = vi.hoisted(() => ({ searchCustomersMock: vi.fn() }));
vi.mock("@/lib/mobile/customers", () => ({ searchCustomers: searchCustomersMock }));

import { GET } from "../route";

const HIT: CustomerHit = {
  id: "cus_1",
  name: "Margaret Kowalski",
  phone: "5185550142",
  address: "14 Sliter Rd, Averill Park",
};

const request = (qs = "") => new Request(`https://example.com/api/app/customers${qs}`);

describe("GET /api/app/customers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the search results envelope", async () => {
    searchCustomersMock.mockResolvedValue([HIT]);

    const res = await GET(request("?q=kowalski"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ query: "kowalski", hits: [HIT] });
    expect(Date.parse(body.generated_at)).not.toBeNaN();
    expect(searchCustomersMock).toHaveBeenCalledWith("kowalski");
  });

  // No `q` param must reach searchCustomers as "" rather than throw, so a bare
  // GET behaves like an empty search instead of a 500.
  it("passes an empty string when q is missing", async () => {
    searchCustomersMock.mockResolvedValue([]);

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ query: "", hits: [] });
    expect(searchCustomersMock).toHaveBeenCalledWith("");
  });

  // A dead Supabase must surface as an error, not as a quiet empty result set
  // that reads as "no matches" when really the query never ran.
  it("surfaces a query failure with its cause", async () => {
    searchCustomersMock.mockRejectedValue(new Error("supabase unreachable"));

    const res = await GET(request("?q=kowalski"));

    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/supabase unreachable/);
  });
});
