import { describe, it, expect, vi, beforeEach } from "vitest";

const { mirrorSyncedAtMock } = vi.hoisted(() => ({ mirrorSyncedAtMock: vi.fn() }));
vi.mock("../mirrorFreshness", async (importOriginal) => ({
  // staleAfterMinutes stays real -- it is pure, and the whole point of the
  // envelope is that the threshold it publishes is the route's actual one.
  ...(await importOriginal<typeof import("../mirrorFreshness")>()),
  mirrorSyncedAt: mirrorSyncedAtMock,
}));

import { appJson, appError } from "../envelope";

describe("appJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mirrorSyncedAtMock.mockResolvedValue("2026-08-06T13:48:00Z");
  });

  it("stamps generated_at on every payload", async () => {
    const body = await (await appJson({ jobs: [] }, ["jobs"])).json();
    expect(body.data).toEqual({ jobs: [] });
    expect(Date.parse(body.generated_at)).not.toBeNaN();
  });

  // The actual freshness signal. generated_at only ever says how long ago the
  // HTTP request happened, which is always seconds and never the question
  // anyone is asking.
  it("carries the mirror's age, not just the request time", async () => {
    const body = await (await appJson({}, ["jobs", "customers"])).json();

    expect(body.mirror_synced_at).toBe("2026-08-06T13:48:00Z");
    expect(mirrorSyncedAtMock).toHaveBeenCalledWith(["jobs", "customers"]);
  });

  // Route-declared, because "stale" means something different per screen: 45
  // minutes of missed 15-minute cron runs is broken, while invoices are
  // reconciled at most once every INVOICE_RECONCILE_HOURS by design.
  it("publishes a threshold derived from the declared resources", async () => {
    const jobs = await (await appJson({}, ["jobs"])).json();
    const money = await (await appJson({}, ["invoices", "estimates"])).json();

    expect(jobs.stale_after_minutes).toBe(45);
    expect(money.stale_after_minutes).toBeGreaterThan(20 * 60);
    // A screen is only as fresh as its stalest input: the invoice window has
    // to govern the mixed route, not the 15-minute one.
    expect(money.stale_after_minutes).toBeGreaterThan(jobs.stale_after_minutes);
  });

  // Degrading, not crashing and not claiming freshness we cannot support.
  it("reports a null mirror age when sync_cursors yields nothing", async () => {
    mirrorSyncedAtMock.mockResolvedValue(null);

    const body = await (await appJson({}, ["jobs"])).json();

    expect(body.mirror_synced_at).toBeNull();
    // The threshold still ships -- it is a property of the route, not of the
    // cursor table, and the client needs it the moment an age reappears.
    expect(body.stale_after_minutes).toBe(45);
  });

  // The service worker owns caching. Letting an intermediary cache these would
  // produce stale data the UI cannot detect or date.
  it("forbids HTTP caching so only the service worker caches", async () => {
    expect((await appJson({}, ["jobs"])).headers.get("cache-control")).toBe("no-store");
  });
});

describe("appError", () => {
  it("returns the message and status given", async () => {
    const res = appError("Job not found", 404);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Job not found");
  });
});
