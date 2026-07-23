import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertMock = vi.fn().mockResolvedValue({ error: null });
const fromMock = vi.fn(() => ({ upsert: upsertMock }));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseServerClient: () => ({ from: fromMock }),
}));

import { syncOneRecord } from "../syncService";

describe("syncOneRecord", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps and upserts a job payload into the jobs table", async () => {
    await syncOneRecord("jobs", "job.updated", {
      id: "j1",
      work_status: "scheduled",
      tags: [],
    });

    expect(fromMock).toHaveBeenCalledWith("jobs");
    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({ id: "j1" }));
  });

  it("throws on an unknown resource type", async () => {
    await expect(syncOneRecord("widgets", "widget.updated", {})).rejects.toThrow(/widgets/);
  });
});
