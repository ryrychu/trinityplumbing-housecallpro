import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EstimateHit, InvoiceHit } from "@/lib/mobile/money";

const { openEstimatesMock, unpaidInvoicesMock } = vi.hoisted(() => ({
  openEstimatesMock: vi.fn(),
  unpaidInvoicesMock: vi.fn(),
}));
vi.mock("@/lib/mobile/money", () => ({
  listOpenEstimates: openEstimatesMock,
  listUnpaidInvoices: unpaidInvoicesMock,
}));

// Signed in by default so the cases below exercise the real handler. The
// implementation survives vi.clearAllMocks() (which clears calls, not impls),
// and the refusal case overrides it per-test.
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

const ESTIMATE: EstimateHit = {
  id: "est_1",
  customerName: "Margaret Kowalski",
  amountCents: 145_000,
  status: "pending",
};

// Live invoice statuses are paid / canceled / voided / open. `open` is the
// unpaid state -- there is no `pending` on an invoice, and a fixture that
// invented one is how a suite passes green while production reads zero.
const INVOICE: InvoiceHit = {
  id: "inv_1",
  customerName: "Dale Renner",
  amountCents: 42_000,
  status: "open",
  dueDate: "2026-07-30",
  overdueDays: 7,
};

describe("GET /api/app/money", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openEstimatesMock.mockResolvedValue([ESTIMATE]);
    unpaidInvoicesMock.mockResolvedValue([INVOICE]);
  });

  it("returns both segments with their totals", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.estimates).toEqual([ESTIMATE]);
    expect(body.data.invoices).toEqual([INVOICE]);
    expect(body.data.estimatesTotalCents).toBe(145_000);
    expect(body.data.invoicesTotalCents).toBe(42_000);
    expect(Date.parse(body.generated_at)).not.toBeNaN();
  });

  // A null amount is a real shape in the mirror; it must count as zero rather
  // than turn the whole total into NaN, which would render as "$NaN".
  it("treats a null amount as zero in the totals", async () => {
    openEstimatesMock.mockResolvedValue([ESTIMATE, { ...ESTIMATE, id: "est_2", amountCents: null }]);

    const body = await (await GET()).json();

    expect(body.data.estimatesTotalCents).toBe(145_000);
  });

  it("surfaces a query failure with its cause instead of an empty ledger", async () => {
    unpaidInvoicesMock.mockRejectedValue(new Error("supabase unreachable"));

    const res = await GET();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/supabase unreachable/);
  });

  // The six /api/app/* handlers read through the service-role client and no
  // table has RLS, so before requireUser() the middleware matcher was the only
  // thing refusing an anonymous caller. Asserting the query modules were never
  // reached is what makes this more than a status-code check.
  it("refuses an unauthenticated request without touching the data", async () => {
    requireUserMock.mockResolvedValueOnce(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/not signed in/i);
    expect(openEstimatesMock).not.toHaveBeenCalled();
    expect(unpaidInvoicesMock).not.toHaveBeenCalled();
  });

  // A screen is only as fresh as its stalest input, so what this route
  // declares here decides what its stamp is allowed to claim.
  it("declares the resources its freshness stamp covers", async () => {
    const res = await GET();

    expect(mirrorSyncedAtMock).toHaveBeenCalledWith(["invoices", "estimates"]);
    expect((await res.json()).mirror_synced_at).toBe("2026-08-06T13:48:00Z");
  });

  // Invoices reconcile at most once every INVOICE_RECONCILE_HOURS, and a
  // screen is only as fresh as its stalest input -- so invoices governs
  // here, not the 15-minute estimates cadence.
  it("publishes the long, invoice-reconcile staleness threshold", async () => {
    const res = await GET();

    expect((await res.json()).stale_after_minutes).toBeGreaterThan(20 * 60);
  });
});
