import { describe, it, expect, vi } from "vitest";
import { fetchTrafficReport, reportRequests, type GaPort } from "../fetch";
import { GaApiError, type GaReport } from "../google";
import { SITE_EVENTS } from "../report";
import { WEEKS, siteData } from "./fixtures";

const PROPERTIES = [
  { site: "Trinity Plumbing", propertyId: "111" },
  { site: "Albany Rooter", propertyId: "222" },
  { site: "Troy Water Heaters", propertyId: "333" },
];

/** Answers each request from siteData(), by which report it asks for. */
function answer(body: Record<string, unknown>): GaReport {
  const data = siteData();
  const dims = (body.dimensions as { name: string }[] | undefined)?.map((d) => d.name) ?? [];
  if (dims.includes("eventName")) return data.events;
  if (dims.includes("sessionDefaultChannelGroup")) return data.sources;
  return data.totals;
}

function port(over: Partial<GaPort> = {}): GaPort & { runReport: ReturnType<typeof vi.fn> } {
  return {
    token: vi.fn(async () => "ya29.test-token"),
    runReport: vi.fn(async (_token: string, _id: string, body: Record<string, unknown>) => answer(body)),
    ...over,
  } as GaPort & { runReport: ReturnType<typeof vi.fn> };
}

describe("reportRequests", () => {
  const r = reportRequests(WEEKS);

  it("asks for visitors and visits for both weeks, named so rows can be told apart", () => {
    expect(r.totals).toEqual({
      dateRanges: [
        { startDate: "2026-11-16", endDate: "2026-11-22", name: "this_week" },
        { startDate: "2026-11-09", endDate: "2026-11-15", name: "last_week" },
      ],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }],
    });
  });

  it("asks for visits by channel for the report week only", () => {
    expect(r.sources).toMatchObject({
      dateRanges: [{ startDate: "2026-11-16", endDate: "2026-11-22" }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    });
  });

  it("asks for exactly the site events, both weeks", () => {
    expect(r.events).toMatchObject({
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }],
      dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: [...SITE_EVENTS] } } },
    });
    expect(r.events.dateRanges).toEqual(r.totals.dateRanges);
    expect([...SITE_EVENTS].sort()).toEqual(["booking_click", "email_click", "generate_lead", "phone_click"]);
  });
});

describe("fetchTrafficReport", () => {
  it("gets one token and three reports per property", async () => {
    const ga = port();
    const report = await fetchTrafficReport(PROPERTIES, WEEKS, ga);
    expect(ga.token).toHaveBeenCalledTimes(1);
    expect(ga.runReport).toHaveBeenCalledTimes(9);
    expect(new Set(ga.runReport.mock.calls.map((c) => c[1]))).toEqual(new Set(["111", "222", "333"]));
    expect(ga.runReport.mock.calls.every((c) => c[0] === "ya29.test-token")).toBe(true);
    expect(report.sites.every((s) => s.status === "ok")).toBe(true);
    expect(report.totals.visitors.thisWeek).toBe(620 * 3);
  });

  it("marks one failing property unavailable and still reports the rest", async () => {
    const ga = port({
      runReport: vi.fn(async (_t: string, id: string, body: Record<string, unknown>) => {
        if (id === "222") throw new GaApiError("runReport", "PERMISSION_DENIED");
        return answer(body);
      }),
    });
    const report = await fetchTrafficReport(PROPERTIES, WEEKS, ga);
    expect(report.sites.map((s) => [s.site, s.status])).toEqual([
      ["Trinity Plumbing", "ok"],
      ["Troy Water Heaters", "ok"],
      ["Albany Rooter", "unavailable"],
    ]);
    expect(report.sites[2]).toEqual({ site: "Albany Rooter", propertyId: "222", status: "unavailable", reason: "PERMISSION_DENIED" });
    expect(report.unavailableCount).toBe(1);
    expect(report.totals.visitors.thisWeek).toBe(620 * 2);
  });

  it("reports an unexpected error as unknown_error, never its message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ga = port({
      runReport: vi.fn(async () => {
        throw new Error("something with private details");
      }),
    });
    const report = await fetchTrafficReport(PROPERTIES.slice(0, 1), WEEKS, ga);
    expect(report.sites[0]).toMatchObject({ status: "unavailable", reason: "unknown_error" });
    expect(JSON.stringify(report)).not.toContain("private details");
    vi.restoreAllMocks();
  });

  it("throws when the token can't be had, since then no site can load", async () => {
    const ga = port({ token: vi.fn(async () => { throw new GaApiError("token", "invalid_grant"); }) });
    await expect(fetchTrafficReport(PROPERTIES, WEEKS, ga)).rejects.toThrow(/invalid_grant/);
    expect(ga.runReport).not.toHaveBeenCalled();
  });
});
