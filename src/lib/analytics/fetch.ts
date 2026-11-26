// Fetching a traffic report: one token, then three runReport calls per
// property, all properties at once. A property that fails becomes
// "unavailable" with Google's error code; the others still report.
import type { GaProperty } from "./config";
import { GaApiError, type GaReport } from "./google";
import { LAST_WEEK, SITE_EVENTS, THIS_WEEK, buildTrafficReport, siteTraffic, type SiteTraffic, type TrafficReport } from "./report";
import type { ReportWeeks } from "./week";

export interface GaPort {
  token(): Promise<string>;
  runReport(token: string, propertyId: string, body: Record<string, unknown>): Promise<GaReport>;
}

type Body = Record<string, unknown> & { dateRanges: { startDate: string; endDate: string; name?: string }[] };

// Ten sources is plenty to pick the top three from after relabelling.
const SOURCE_ROWS = 10;

export function reportRequests(weeks: ReportWeeks): { totals: Body; sources: Body; events: Body } {
  const both = [
    { startDate: weeks.week.startDate, endDate: weeks.week.endDate, name: THIS_WEEK },
    { startDate: weeks.previousWeek.startDate, endDate: weeks.previousWeek.endDate, name: LAST_WEEK },
  ];
  return {
    totals: { dateRanges: both, metrics: [{ name: "activeUsers" }, { name: "sessions" }] },
    sources: {
      dateRanges: [{ startDate: weeks.week.startDate, endDate: weeks.week.endDate }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: SOURCE_ROWS,
    },
    events: {
      dateRanges: both,
      dimensions: [{ name: "eventName" }],
      metrics: [{ name: "eventCount" }],
      dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: [...SITE_EVENTS] } } },
    },
  };
}

async function fetchSite(ga: GaPort, token: string, property: GaProperty, requests: ReturnType<typeof reportRequests>): Promise<SiteTraffic> {
  try {
    const [totals, sources, events] = await Promise.all([
      ga.runReport(token, property.propertyId, requests.totals),
      ga.runReport(token, property.propertyId, requests.sources),
      ga.runReport(token, property.propertyId, requests.events),
    ]);
    return siteTraffic(property, { totals, sources, events });
  } catch (err) {
    const reason = err instanceof GaApiError ? err.code : "unknown_error";
    if (!(err instanceof GaApiError)) {
      console.error(`[analytics] ${property.site} failed unexpectedly: ${err instanceof Error ? err.name : "error"}`);
    }
    return { site: property.site, propertyId: property.propertyId, status: "unavailable", reason };
  }
}

/** Throws only when the token can't be had, since then no property can load. */
export async function fetchTrafficReport(properties: GaProperty[], weeks: ReportWeeks, ga: GaPort): Promise<TrafficReport> {
  const token = await ga.token();
  const requests = reportRequests(weeks);
  const sites = await Promise.all(properties.map((p) => fetchSite(ga, token, p, requests)));
  return buildTrafficReport(weeks, sites);
}
