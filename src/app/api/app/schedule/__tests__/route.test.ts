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

  it("shifts a week forward when offset=1", async () => {
    await GET(request("?offset=1"));
    const [anchor, count] = scheduleDaysMock.mock.calls[0];
    expect(count).toBe(7);
    expect(anchor).toBeInstanceOf(Date);
  });

  // Unbounded user input reaching a date constructor is how you get an
  // Invalid Date and a 500 on a screen that should never fail.
  it("clamps a nonsense offset instead of throwing", async () => {
    const res = await GET(request("?offset=banana"));
    expect(res.status).toBe(200);
  });

  it("returns the technician list for the filter", async () => {
    const body = await (await GET(request())).json();
    expect(body.data.technicians).toEqual([{ id: "t1", name: "Dylan R" }]);
  });
});
