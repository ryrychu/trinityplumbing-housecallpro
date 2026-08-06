import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CustomerDetail } from "@/lib/mobile/customers";

const { customerDetailMock } = vi.hoisted(() => ({ customerDetailMock: vi.fn() }));
vi.mock("@/lib/mobile/customers", () => ({ getCustomerDetail: customerDetailMock }));

// Signed in by default so the existing cases exercise the real handler. The
// implementation survives vi.clearAllMocks() (which clears calls, not impls),
// and the refusal case below overrides it per-test.
const { requireUserMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(async () => ({ id: "u1", email: "info@trinity.plumbing" })),
}));
vi.mock("@/lib/mobile/session", () => ({ requireUser: requireUserMock }));
// The freshness stamp on this screen is only as honest as the resource list
// the route declares, so that list is asserted rather than assumed.
const { mirrorSyncedAtMock } = vi.hoisted(() => ({
  mirrorSyncedAtMock: vi.fn(async () => "2026-08-06T13:48:00Z"),
}));
vi.mock("@/lib/mobile/mirrorFreshness", async (importOriginal) => ({
  // staleAfterMinutes stays real: the threshold a route publishes must be
  // the one it would publish in production.
  ...(await importOriginal<typeof import("@/lib/mobile/mirrorFreshness")>()),
  mirrorSyncedAt: mirrorSyncedAtMock,
}));
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

  // The six /api/app/* handlers read through the service-role client and no
  // table has RLS, so before requireUser() the middleware matcher was the
  // only thing refusing an anonymous caller. Asserting the query module was
  // never reached is what makes this more than a status-code check: a 401
  // returned after the data had already been fetched would still be a leak
  // waiting on one more mistake.
  it("refuses an unauthenticated request without touching the data", async () => {
    requireUserMock.mockResolvedValueOnce(null);
    const res = await GET(new Request("https://example.com/api/app/customers/cus_1"), {
      params: { id: "cus_1" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/not signed in/i);
    expect(customerDetailMock).not.toHaveBeenCalled();
  });

  // A screen is only as fresh as its stalest input, so what this route
  // declares here decides what its stamp is allowed to claim.
  it("declares the resources its freshness stamp covers", async () => {
    customerDetailMock.mockResolvedValue(DETAIL);
    const res = await GET(new Request("https://example.com/api/app/customers/cus_1"), { params: { id: "cus_1" } });

    expect(mirrorSyncedAtMock).toHaveBeenCalledWith(["customers", "jobs"]);
    expect((await res.json()).mirror_synced_at).toBe("2026-08-06T13:48:00Z");
  });

  // Jobs and customers both ride the 15-minute cron, so this screen can
  // hold a tight threshold and have it actually mean something.
  it("publishes the short, cron-cadence staleness threshold", async () => {
    customerDetailMock.mockResolvedValue(DETAIL);
    const res = await GET(new Request("https://example.com/api/app/customers/cus_1"), { params: { id: "cus_1" } });

    expect((await res.json()).stale_after_minutes).toBe(45);
  });
});
