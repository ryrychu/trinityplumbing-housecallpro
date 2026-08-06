import { describe, it, expect, vi, beforeEach } from "vitest";

const { scheduleDaysMock, supabaseMock } = vi.hoisted(() => ({
  scheduleDaysMock: vi.fn(),
  supabaseMock: vi.fn(),
}));

vi.mock("@/lib/dashboard/queries", () => ({ getScheduleDays: scheduleDaysMock }));
vi.mock("@/lib/supabase/client", () => ({ getSupabaseServerClient: supabaseMock }));

import { GET } from "../route";

const request = (qs = "") => new Request(`https://example.com/api/app/schedule${qs}`);

describe("GET /api/app/schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduleDaysMock.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({ dateKey: `2026-08-0${3 + i}`, rows: [] }))
    );
    supabaseMock.mockReturnValue({
      from: () => ({
        select: () => ({
          range: () =>
            Promise.resolve({
              data: [{ id: "t1", first_name: "Dylan", last_name: "R" }],
              error: null,
            }),
        }),
      }),
    });
  });

  it("returns seven days, empty ones included", async () => {
    const body = await (await GET(request())).json();
    expect(body.data.days).toHaveLength(7);
  });

  // An empty day must still render as a day. Dropping it would make a quiet
  // Sunday indistinguishable from a broken query.
  it("keeps a day with no jobs", async () => {
    const body = await (await GET(request())).json();
    expect(body.data.days.every((d: { rows: unknown[] }) => Array.isArray(d.rows))).toBe(true);
  });

  const DAY_MS = 24 * 60 * 60 * 1000;

  // Checking `anchor instanceof Date` alone can't fail if offset were ignored
  // entirely -- it would still be some Date. Assert the thing offset is for:
  // the anchor passed to getScheduleDays actually moves by whole weeks.
  it("advances the anchor by exactly one week per offset step, in either direction", async () => {
    await GET(request());
    await GET(request("?offset=1"));
    await GET(request("?offset=-1"));

    const [anchorZero, countZero] = scheduleDaysMock.mock.calls[0];
    const [anchorPlusOne, countPlusOne] = scheduleDaysMock.mock.calls[1];
    const [anchorMinusOne, countMinusOne] = scheduleDaysMock.mock.calls[2];

    expect(countZero).toBe(7);
    expect(countPlusOne).toBe(7);
    expect(countMinusOne).toBe(7);
    expect(anchorPlusOne.getTime() - anchorZero.getTime()).toBe(7 * DAY_MS);
    expect(anchorZero.getTime() - anchorMinusOne.getTime()).toBe(7 * DAY_MS);
  });

  // Unbounded user input reaching a date constructor is how you get an
  // Invalid Date and a 500 on a screen that should never fail. Asserting the
  // clamped value (not just a 200) confirms "banana" actually resolved to
  // week 0 rather than, say, NaN happening to still produce a 200.
  it("clamps a nonsense offset instead of throwing", async () => {
    const res = await GET(request("?offset=banana"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.offset).toBe(0);
  });

  it("returns the technician list for the filter", async () => {
    const body = await (await GET(request())).json();
    expect(body.data.technicians).toEqual([{ id: "t1", name: "Dylan R" }]);
  });

  describe("technician dedup", () => {
    // The filter dropdown offers technicianName as the only handle a row can
    // be matched on (TodayScheduleRow carries no technician id). Two rows for
    // "Dylan R" would give the dropdown two options that filter identically --
    // that reads as a bug, not a feature, so listTechnicians collapses them.
    it("collapses two technicians who share a display name into one dropdown entry", async () => {
      supabaseMock.mockReturnValue({
        from: () => ({
          select: () => ({
            range: () =>
              Promise.resolve({
                data: [
                  { id: "t1", first_name: "Dylan", last_name: "R" },
                  // Different id, same rendered name modulo case -- the
                  // normalization the dedup key is supposed to catch.
                  { id: "t2", first_name: "DYLAN", last_name: "r" },
                ],
                error: null,
              }),
          }),
        }),
      });

      const body = await (await GET(request())).json();
      expect(body.data.technicians).toEqual([{ id: "t1", name: "Dylan R" }]);
    });

    // The other direction matters just as much: dedup keyed on the wrong
    // thing (or too aggressive) could drop a genuinely distinct technician.
    it("keeps two technicians with genuinely different names", async () => {
      supabaseMock.mockReturnValue({
        from: () => ({
          select: () => ({
            range: () =>
              Promise.resolve({
                data: [
                  { id: "t1", first_name: "Dylan", last_name: "R" },
                  { id: "t2", first_name: "Sam", last_name: "K" },
                ],
                error: null,
              }),
          }),
        }),
      });

      const body = await (await GET(request())).json();
      expect(body.data.technicians).toEqual([
        { id: "t1", name: "Dylan R" },
        { id: "t2", name: "Sam K" },
      ]);
    });
  });
});
