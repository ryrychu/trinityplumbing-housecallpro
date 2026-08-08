import { describe, it, expect, vi, beforeEach } from "vitest";

const { getScheduleDaysMock, renderDigestMock, estimatesMock, invoicesMock } = vi.hoisted(() => ({
  getScheduleDaysMock: vi.fn(),
  renderDigestMock: vi.fn(),
  estimatesMock: vi.fn(),
  invoicesMock: vi.fn(),
}));

vi.mock("@/lib/dashboard/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard/queries")>()),
  getScheduleDays: getScheduleDaysMock,
}));
vi.mock("@/lib/notifications/digest", () => ({ renderDigest: renderDigestMock }));
vi.mock("@/lib/mobile/money", () => ({
  listOpenEstimates: estimatesMock,
  listUnpaidInvoices: invoicesMock,
}));

import { renderCommand, HELP_TEXT } from "../commands";

const SAT = new Date("2026-08-08T12:00:00Z");

describe("renderCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getScheduleDaysMock.mockResolvedValue([{ dateKey: "2026-08-09", rows: [] }]);
    renderDigestMock.mockResolvedValue("*Today — Sat Aug 8* — 2 jobs");
    estimatesMock.mockResolvedValue([]);
    invoicesMock.mockResolvedValue([]);
  });

  // today and week must be the SAME string the 6am cron and the /admin button
  // send, which is what renderDigest exists to guarantee.
  it("renders today through renderDigest, not a second implementation", async () => {
    const out = await renderCommand({ kind: "today" }, SAT);
    expect(renderDigestMock).toHaveBeenCalledWith("digest", SAT);
    expect(getScheduleDaysMock).not.toHaveBeenCalled();
    expect(out).toBe("*Today — Sat Aug 8* — 2 jobs");
  });

  it("renders week through renderDigest", async () => {
    renderDigestMock.mockResolvedValue("*Week ahead* — 9 jobs");
    const out = await renderCommand({ kind: "week" }, SAT);
    expect(renderDigestMock).toHaveBeenCalledWith("week", SAT);
    expect(out).toBe("*Week ahead* — 9 jobs");
  });

  it("asks getScheduleDays for a one-day window for tomorrow", async () => {
    await renderCommand({ kind: "tomorrow" }, SAT);
    expect(getScheduleDaysMock).toHaveBeenCalledWith(expect.any(Date), 1);
  });

  it("asks getScheduleDays for a seven-day window for next week", async () => {
    getScheduleDaysMock.mockResolvedValue([{ dateKey: "2026-08-10", rows: [] }]);
    await renderCommand({ kind: "nextWeek" }, SAT);
    expect(getScheduleDaysMock).toHaveBeenCalledWith(expect.any(Date), 7);
  });

  it("titles a tomorrow result with its date", async () => {
    const out = await renderCommand({ kind: "tomorrow" }, SAT);
    expect(out).toContain("*Tomorrow — Sun Aug 9*");
  });

  it("renders money from both money queries", async () => {
    estimatesMock.mockResolvedValue([
      { id: "e1", customerId: "c1", customerName: "Devon Robinson", amountCents: 120000, status: null },
    ]);
    const out = await renderCommand({ kind: "money" }, SAT);
    expect(estimatesMock).toHaveBeenCalled();
    expect(invoicesMock).toHaveBeenCalledWith(SAT);
    expect(out).toContain("*Money*");
    expect(out).toContain("Devon Robinson");
  });

  it("renders help without touching the database", async () => {
    const out = await renderCommand({ kind: "help" }, SAT);
    expect(out).toBe(HELP_TEXT);
    expect(getScheduleDaysMock).not.toHaveBeenCalled();
    expect(renderDigestMock).not.toHaveBeenCalled();
  });

  it("lists every supported subcommand in the help text", () => {
    for (const word of ["today", "tomorrow", "week", "next week", "money"]) {
      expect(HELP_TEXT).toContain(word);
    }
  });
});
