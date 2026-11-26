// The weekly traffic numbers, computed from GA4 runReport responses. Pure:
// responses in, report out, so the Slack post, the preview and the ChatGPT
// tool all share one tested calculation and no network.
//
// Sources use sessionDefaultChannelGroup rather than sessionSourceMedium.
// Channel groups are a short fixed list ("Organic Search", "Direct", "Paid
// Search") that reads as plain words once relabelled below, and they fold
// google / bing / duckduckgo into one line. Source/medium splits the same
// visits across many "google / organic", "gbp / referral" rows, which is more
// detail than a weekly glance needs; ChatGPT can still be asked about it in GA.
import type { GaReport } from "./google";
import type { GaProperty } from "./config";
import type { ReportWeek, ReportWeeks } from "./week";

/** The fixed event names the sites send. page_view is GA's own and is counted as visits instead. */
export const SITE_EVENTS = ["phone_click", "booking_click", "generate_lead", "email_click"] as const;
type SiteEvent = (typeof SITE_EVENTS)[number];

export const THIS_WEEK = "this_week";
export const LAST_WEEK = "last_week";
export const TOP_SOURCES = 3;

export type Metric = { thisWeek: number; lastWeek: number; changePct: number | null };

export type Actions = {
  phoneClicks: Metric;
  bookingClicks: Metric;
  formRequests: Metric;
  emailClicks: Metric;
};

export type TopSource = { channel: string; label: string; visits: number };

export type SiteTraffic =
  | {
      site: string;
      propertyId: string;
      status: "ok";
      visitors: Metric;
      visits: Metric;
      topSources: TopSource[];
      actions: Actions;
    }
  | { site: string; propertyId: string; status: "unavailable"; reason: string };

export type OkSite = Extract<SiteTraffic, { status: "ok" }>;

export type TrafficReport = {
  week: ReportWeek;
  previousWeek: ReportWeek;
  totals: { visitors: Metric; visits: Metric; actions: Actions };
  /** Busiest first by visitors; unavailable sites last. */
  sites: SiteTraffic[];
  siteCount: number;
  unavailableCount: number;
};

/** The three runReport responses for one property. */
export type SiteData = { totals: GaReport; sources: GaReport; events: GaReport };

const ACTION_EVENTS: Record<keyof Actions, SiteEvent> = {
  phoneClicks: "phone_click",
  bookingClicks: "booking_click",
  formRequests: "generate_lead",
  emailClicks: "email_click",
};

const CHANNEL_LABELS: Record<string, string> = {
  "Organic Search": "Google search",
  Direct: "Typed in or bookmarked",
  "Paid Search": "Google Ads",
  "Organic Maps": "Maps",
  "Organic Social": "Social media",
  "Paid Social": "Social media ads",
  Referral: "Other websites",
  Email: "Email",
  "Organic Video": "Video",
  "Paid Video": "Video ads",
  Display: "Display ads",
  "Paid Other": "Other ads",
  SMS: "Text messages",
  Unassigned: "Unknown",
};

export function sourceLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/** Week-over-week, rounded half away from zero; null when last week was zero. */
export function change(thisWeek: number, lastWeek: number): Metric {
  if (lastWeek === 0) return { thisWeek, lastWeek, changePct: null };
  const pct = ((thisWeek - lastWeek) / lastWeek) * 100;
  return { thisWeek, lastWeek, changePct: Math.sign(pct) * Math.round(Math.abs(pct)) || 0 };
}

function num(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Each row as { dimension name → value } and { metric name → number }, matched by header. */
function rowsOf(report: GaReport): { dims: Record<string, string>; metrics: Record<string, number> }[] {
  const dimNames = (report.dimensionHeaders ?? []).map((h) => h.name);
  const metricNames = (report.metricHeaders ?? []).map((h) => h.name);
  return (report.rows ?? []).map((row) => ({
    dims: Object.fromEntries(dimNames.map((n, i) => [n, row.dimensionValues?.[i]?.value ?? ""])),
    metrics: Object.fromEntries(metricNames.map((n, i) => [n, num(row.metricValues?.[i]?.value)])),
  }));
}

// GA leaves out a range with no data, so a missing row means zero.
function sumWhere(report: GaReport, metric: string, match: (dims: Record<string, string>) => boolean): number {
  return rowsOf(report)
    .filter((r) => match(r.dims))
    .reduce((t, r) => t + (r.metrics[metric] ?? 0), 0);
}

function weekly(report: GaReport, metric: string, extra: (dims: Record<string, string>) => boolean = () => true): Metric {
  return change(
    sumWhere(report, metric, (d) => d.dateRange === THIS_WEEK && extra(d)),
    sumWhere(report, metric, (d) => d.dateRange === LAST_WEEK && extra(d))
  );
}

function topSources(report: GaReport): TopSource[] {
  return rowsOf(report)
    .map((r) => ({ channel: r.dims.sessionDefaultChannelGroup ?? "", visits: r.metrics.sessions ?? 0 }))
    .filter((s) => s.channel && s.visits > 0)
    .sort((a, b) => b.visits - a.visits)
    .slice(0, TOP_SOURCES)
    .map((s) => ({ channel: s.channel, label: sourceLabel(s.channel), visits: s.visits }));
}

export function siteTraffic(property: GaProperty, data: SiteData): OkSite {
  const actions = Object.fromEntries(
    (Object.keys(ACTION_EVENTS) as (keyof Actions)[]).map((k) => [
      k,
      weekly(data.events, "eventCount", (d) => d.eventName === ACTION_EVENTS[k]),
    ])
  ) as Actions;
  return {
    site: property.site,
    propertyId: property.propertyId,
    status: "ok",
    visitors: weekly(data.totals, "activeUsers"),
    visits: weekly(data.totals, "sessions"),
    topSources: topSources(data.sources),
    actions,
  };
}

function sumMetric(sites: OkSite[], pick: (s: OkSite) => Metric): Metric {
  return change(
    sites.reduce((t, s) => t + pick(s).thisWeek, 0),
    sites.reduce((t, s) => t + pick(s).lastWeek, 0)
  );
}

export function buildTrafficReport(weeks: ReportWeeks, sites: SiteTraffic[]): TrafficReport {
  const ok = sites.filter((s): s is OkSite => s.status === "ok");
  const unavailable = sites.filter((s) => s.status !== "ok");
  const sorted = [...ok].sort((a, b) => b.visitors.thisWeek - a.visitors.thisWeek || a.site.localeCompare(b.site));
  const actions = Object.fromEntries(
    (Object.keys(ACTION_EVENTS) as (keyof Actions)[]).map((k) => [k, sumMetric(ok, (s) => s.actions[k])])
  ) as Actions;
  return {
    week: weeks.week,
    previousWeek: weeks.previousWeek,
    totals: { visitors: sumMetric(ok, (s) => s.visitors), visits: sumMetric(ok, (s) => s.visits), actions },
    sites: [...sorted, ...unavailable],
    siteCount: sites.length,
    unavailableCount: unavailable.length,
  };
}
