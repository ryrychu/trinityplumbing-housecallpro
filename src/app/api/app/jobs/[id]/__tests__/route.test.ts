import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobDetail } from "@/lib/mobile/jobDetail";

const { jobDetailMock } = vi.hoisted(() => ({ jobDetailMock: vi.fn() }));
vi.mock("@/lib/mobile/jobDetail", () => ({ getJobDetail: jobDetailMock }));

import { GET } from "../route";

const DETAIL: JobDetail = {
  id: "job_3417",
  customerId: "cus_1",
  customerName: "Margaret Kowalski",
  customerPhone: "5185550142",
  scheduledStart: "2026-08-06T12:00:00Z",
  scheduledEnd: "2026-08-06T14:00:00Z",
  address: "14 Sliter Rd, Averill Park",
  technicianName: "Dylan R",
  service: "Water Heater Replacement",
  status: "En Route",
  amountCents: 248_000,
  invoice: null,
  notes: [],
};

describe("GET /api/app/jobs/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the job detail envelope", async () => {
    jobDetailMock.mockResolvedValue(DETAIL);

    const res = await GET(new Request("https://example.com/api/app/jobs/job_3417"), {
      params: { id: "job_3417" },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(DETAIL);
    expect(Date.parse(body.generated_at)).not.toBeNaN();
    expect(jobDetailMock).toHaveBeenCalledWith("job_3417");
  });

  // A typo'd or deleted job id must read as "not found", not as an empty
  // detail screen that looks like a job with nothing on it.
  it("returns 404 when the job does not exist", async () => {
    jobDetailMock.mockResolvedValue(null);

    const res = await GET(new Request("https://example.com/api/app/jobs/job_nope"), {
      params: { id: "job_nope" },
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  // A dead Supabase must surface as an error, not as a quiet 404 that reads
  // as "this job doesn't exist" when really the query never ran.
  it("surfaces a query failure with its cause", async () => {
    jobDetailMock.mockRejectedValue(new Error("supabase unreachable"));

    const res = await GET(new Request("https://example.com/api/app/jobs/job_3417"), {
      params: { id: "job_3417" },
    });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/supabase unreachable/);
  });
});
