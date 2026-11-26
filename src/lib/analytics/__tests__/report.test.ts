import { describe, it, expect } from "vitest";
import { buildTrafficReport, change, siteTraffic, sourceLabel } from "../report";
import { WEEKS, eventsReport, okSite, siteData, sourcesReport, totalsReport } from "./fixtures";

describe("change", () => {
  it("rounds the week-over-week change to a whole percent", () => {
    expect(change(620, 574)).toEqual({ thisWeek: 620, lastWeek: 574, changePct: 8 });
    expect(change(140, 160)).toEqual({ thisWeek: 140, lastWeek: 160, changePct: -13 });
    expect(change(5, 5)).toEqual({ thisWeek: 5, lastWeek: 5, changePct: 0 });
  });

  it("has no percent when last week was zero", () => {
    expect(change(12, 0)).toEqual({ thisWeek: 12, lastWeek: 0, changePct: null });
    expect(change(0, 0)).toEqual({ thisWeek: 0, lastWeek: 0, changePct: null });
  });

  it("is -100% when this week dropped to zero", () => {
    expect(change(0, 40).changePct).toBe(-100);
  });
});

describe("siteTraffic", () => {
  it("reads visitors, visits, the top 3 sources and the four site actions", () => {
    expect(siteTraffic({ site: "Trinity Plumbing", propertyId: "1" }, siteData())).toEqual({
      site: "Trinity Plumbing",
      propertyId: "1",
      status: "ok",
      visitors: { thisWeek: 620, lastWeek: 574, changePct: 8 },
      visits: { thisWeek: 790, lastWeek: 752, changePct: 5 },
      topSources: [
        { channel: "Organic Search", label: "Google search", visits: 410 },
        { channel: "Direct", label: "Typed in or bookmarked", visits: 220 },
        { channel: "Organic Maps", label: "Maps", visits: 80 },
      ],
      actions: {
        phoneClicks: { thisWeek: 9, lastWeek: 6, changePct: 50 },
        bookingClicks: { thisWeek: 3, lastWeek: 3, changePct: 0 },
        formRequests: { thisWeek: 2, lastWeek: 0, changePct: null },
        emailClicks: { thisWeek: 1, lastWeek: 0, changePct: null },
      },
    });
  });

  it("finds columns by header name, whatever order GA returns them in", () => {
    const totals = totalsReport({ this: 10, last: 8 }, { this: 12, last: 9 });
    const swapped = {
      ...totals,
      metricHeaders: [{ name: "sessions" }, { name: "activeUsers" }],
      rows: totals.rows!.map((r) => ({ ...r, metricValues: [...r.metricValues!].reverse() })),
    };
    const s = siteTraffic({ site: "A", propertyId: "1" }, siteData({ totals: swapped }));
    expect(s.status === "ok" && s.visitors.thisWeek).toBe(10);
    expect(s.status === "ok" && s.visits.thisWeek).toBe(12);
  });

  it("counts zero for a week with no traffic at all (GA sends no rows)", () => {
    const s = siteTraffic(
      { site: "New Site", propertyId: "1" },
      { totals: { rows: [] }, sources: {}, events: { rows: [] } }
    );
    expect(s).toMatchObject({
      status: "ok",
      visitors: { thisWeek: 0, lastWeek: 0, changePct: null },
      topSources: [],
      actions: { phoneClicks: { thisWeek: 0 }, formRequests: { thisWeek: 0 } },
    });
  });

  it("ignores events it doesn't report on", () => {
    const s = siteTraffic(
      { site: "A", propertyId: "1" },
      siteData({ events: eventsReport({ page_view: { this: 900 }, scroll: { this: 300 }, phone_click: { this: 2 } }) })
    );
    expect(s.status === "ok" && s.actions.phoneClicks.thisWeek).toBe(2);
  });

  it("sorts sources by visits even if GA didn't", () => {
    const s = siteTraffic(
      { site: "A", propertyId: "1" },
      siteData({ sources: sourcesReport([["Direct", 5], ["Organic Search", 50], ["Referral", 7], ["Email", 1]]) })
    );
    expect(s.status === "ok" && s.topSources.map((x) => x.channel)).toEqual(["Organic Search", "Referral", "Direct"]);
  });
});

describe("sourceLabel", () => {
  it("puts GA's channel names in plain words, and keeps ones it doesn't know", () => {
    expect(sourceLabel("Paid Search")).toBe("Google Ads");
    expect(sourceLabel("Unassigned")).toBe("Unknown");
    expect(sourceLabel("Cross-network")).toBe("Cross-network");
  });
});

describe("buildTrafficReport", () => {
  it("adds up all sites at the top and sorts sites by visitors, unavailable ones last", () => {
    const report = buildTrafficReport(WEEKS, [
      okSite("Small", 50),
      { site: "Broken", propertyId: "9", status: "unavailable", reason: "PERMISSION_DENIED" },
      okSite("Big", 500),
      okSite("Middle", 120),
    ]);
    expect(report.sites.map((s) => s.site)).toEqual(["Big", "Middle", "Small", "Broken"]);
    expect(report.siteCount).toBe(4);
    expect(report.unavailableCount).toBe(1);
    expect(report.totals.visitors).toEqual({ thisWeek: 670, lastWeek: 670, changePct: 0 });
    expect(report.totals.actions.phoneClicks).toEqual({ thisWeek: 27, lastWeek: 18, changePct: 50 });
    expect(report.week).toEqual(WEEKS.week);
    expect(report.previousWeek).toEqual(WEEKS.previousWeek);
  });

  it("totals only the sites that loaded", () => {
    const report = buildTrafficReport(WEEKS, [
      okSite("A", 10),
      { site: "B", propertyId: "2", status: "unavailable", reason: "http_500" },
    ]);
    expect(report.totals.visitors.thisWeek).toBe(10);
  });

  it("breaks a tie in visitors by site name", () => {
    const report = buildTrafficReport(WEEKS, [okSite("Bravo", 10), okSite("Alpha", 10)]);
    expect(report.sites.map((s) => s.site)).toEqual(["Alpha", "Bravo"]);
  });
});
