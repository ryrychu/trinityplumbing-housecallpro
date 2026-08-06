import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CustomerDetail } from "@/lib/mobile/customers";

const { customerDetailMock } = vi.hoisted(() => ({ customerDetailMock: vi.fn() }));
vi.mock("@/lib/mobile/customers", () => ({ getCustomerDetail: customerDetailMock }));

import { GET } from "../route";

const DETAIL: CustomerDetail = {
  id: "cus_1",
  name: "Margaret Kowalski",
  phone: "5185550142",
  address: "14 Sliter Rd, Averill Park",
  company: null,
  email: "margaret@example.com",
  lifetimeCents: 248_000,
  jobs: [
    {
      id: "job_3417",
      scheduledStart: "2026-08-06T12:00:00Z",
      service: "Water Heater Replacement",
      status: "completed",
      amountCents: 248_000,
    },
  ],
};

describe("GET /api/app/customers/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the customer detail envelope", async () => {
    customerDetailMock.mockResolvedValue(DETAIL);

    const res = await GET(new Request("https://example.com/api/app/customers/cus_1"), {
      params: { id: "cus_1" },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(DETAIL);
    expect(Date.parse(body.generated_at)).not.toBeNaN();
    expect(customerDetailMock).toHaveBeenCalledWith("cus_1");
  });

  // A typo'd or deleted customer id must read as "not found", not as an
  // empty detail screen that looks like a customer with no history.
  it("returns 404 when the customer does not exist", async () => {
    customerDetailMock.mockResolvedValue(null);

    const res = await GET(new Request("https://example.com/api/app/customers/cus_nope"), {
      params: { id: "cus_nope" },
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  // A dead Supabase must surface as an error, not as a quiet 404 that reads
  // as "this customer doesn't exist" when really the query never ran.
  it("surfaces a query failure with its cause", async () => {
    customerDetailMock.mockRejectedValue(new Error("supabase unreachable"));

    const res = await GET(new Request("https://example.com/api/app/customers/cus_1"), {
      params: { id: "cus_1" },
    });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/supabase unreachable/);
  });
});
