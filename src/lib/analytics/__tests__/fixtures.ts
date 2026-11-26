// GA4 Data API responses shaped like the real ones, and a finished report, for
// the analytics tests. Synthetic numbers; no real property IDs or keys.
import type { GaReport } from "../google";
import type { SiteData, SiteTraffic, TrafficReport } from "../report";
import { buildTrafficReport, siteTraffic } from "../report";
import { reportWeeks } from "../week";

// Mon Nov 23 2026, 9:00 AM EST: reports Nov 16–22 against Nov 9–15.
export const MONDAY_9AM = new Date("2026-11-23T14:00:00Z");
export const WEEKS = reportWeeks(MONDAY_9AM);

type Pair = { this: number; last: number };

export function totalsReport(users: Pair, sessions: Pair): GaReport {
  return {
    dimensionHeaders: [{ name: "dateRange" }],
    metricHeaders: [{ name: "activeUsers" }, { name: "sessions" }],
    rows: [
      { dimensionValues: [{ value: "this_week" }], metricValues: [{ value: String(users.this) }, { value: String(sessions.this) }] },
      { dimensionValues: [{ value: "last_week" }], metricValues: [{ value: String(users.last) }, { value: String(sessions.last) }] },
    ],
  };
}

export function sourcesReport(rows: Array<[string, number]>): GaReport {
  return {
    dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }],
    metricHeaders: [{ name: "sessions" }],
    rows: rows.map(([channel, n]) => ({ dimensionValues: [{ value: channel }], metricValues: [{ value: String(n) }] })),
  };
}

// GA leaves out an event that didn't happen in a range, so a count can be missing.
export function eventsReport(counts: Partial<Record<string, Partial<Pair>>>): GaReport {
  const rows = Object.entries(counts).flatMap(([event, pair]) =>
    (["this", "last"] as const)
      .filter((k) => pair?.[k] !== undefined)
      .map((k) => ({
        dimensionValues: [{ value: event }, { value: k === "this" ? "this_week" : "last_week" }],
        metricValues: [{ value: String(pair![k]) }],
      }))
  );
  return {
    dimensionHeaders: [{ name: "eventName" }, { name: "dateRange" }],
    metricHeaders: [{ name: "eventCount" }],
    rows,
  };
}

export function siteData(over: Partial<SiteData> = {}): SiteData {
  return {
    totals: totalsReport({ this: 620, last: 574 }, { this: 790, last: 752 }),
    sources: sourcesReport([
      ["Organic Search", 410],
      ["Direct", 220],
      ["Organic Maps", 80],
      ["Referral", 50],
      ["Organic Social", 30],
    ]),
    events: eventsReport({
      phone_click: { this: 9, last: 6 },
      booking_click: { this: 3, last: 3 },
      generate_lead: { this: 2, last: 0 },
      email_click: { this: 1 },
    }),
    ...over,
  };
}

export function okSite(site: string, users: number, over: Partial<SiteData> = {}): SiteTraffic {
  return siteTraffic(
    { site, propertyId: "100000001" },
    siteData({ totals: totalsReport({ this: users, last: users }, { this: users, last: users }), ...over })
  );
}

/** The three-site report the Slack sample in the docs is built from. */
export function sampleReport(): TrafficReport {
  return buildTrafficReport(WEEKS, [
    siteTraffic({ site: "Albany Rooter", propertyId: "100000002" }, siteData({
      totals: totalsReport({ this: 140, last: 160 }, { this: 171, last: 190 }),
      sources: sourcesReport([["Paid Search", 90], ["Organic Search", 60], ["Direct", 21]]),
      events: eventsReport({ phone_click: { this: 4, last: 7 }, booking_click: { this: 1 } }),
    })),
    siteTraffic({ site: "Trinity Plumbing", propertyId: "100000001" }, siteData()),
    { site: "Troy Water Heaters", propertyId: "100000003", status: "unavailable", reason: "PERMISSION_DENIED" },
  ]);
}
