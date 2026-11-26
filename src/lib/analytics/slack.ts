// The weekly traffic report as a Slack message, written for Dave reading it
// on his phone: the all-sites totals first, then one short section per site,
// busiest first.
//
// Slack limits this respects: 50 blocks a message, 150 characters in a header,
// 3000 in a section or context text. Site names and GA's channel names are
// escaped and shortened; past MAX_SITE_SECTIONS sites the rest are summed up
// in one line, so the block count can't grow with GA_PROPERTIES.
import { escapeMrkdwn, type SlackBlock } from "@/lib/tasks/render";
import type { Actions, Metric, OkSite, SiteTraffic, TrafficReport } from "./report";

export const MAX_BLOCKS = 50;
export const HEADER_MAX = 150;
export const SECTION_TEXT_MAX = 3000;
export const MAX_SITE_SECTIONS = 40;
const SITE_NAME_MAX = 80;
const SOURCE_NAME_MAX = 40;

export type TrafficMessage = { text: string; blocks: SlackBlock[] };

const PREVIEW_NOTE = "Preview, only you can see this. The real post goes to the channel on Monday morning.";

/** Shortened by code points, so an emoji is never split. */
function clip(raw: string, max: number): string {
  const points = Array.from(raw);
  return points.length <= max ? raw : `${points.slice(0, max - 1).join("").trimEnd()}…`;
}

function safe(raw: string, max: number): string {
  return escapeMrkdwn(clip(raw, max));
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function plural(count: number, one: string, many: string): string {
  return `${n(count)} ${count === 1 ? one : many}`;
}

/** "(up 8%)", "(down 13%)", "(same as the week before)", "(none the week before)", or "" when both weeks are zero. */
function changeNote(m: Metric): string {
  if (m.changePct === null) return m.thisWeek > 0 ? " (none the week before)" : "";
  if (m.changePct === 0) return " (same as the week before)";
  return m.changePct > 0 ? ` (up ${m.changePct}%)` : ` (down ${-m.changePct}%)`;
}

/** Shorter than changeNote, for the per-site line. */
function shortChange(m: Metric): string {
  if (m.changePct === null || m.changePct === 0) return "";
  return m.changePct > 0 ? ` (up ${m.changePct}%)` : ` (down ${-m.changePct}%)`;
}

const FIXES: Record<string, string> = {
  PERMISSION_DENIED: "no access. In GA4 Admin, add the service account as a Viewer on this property",
  http_403: "no access. In GA4 Admin, add the service account as a Viewer on this property",
  NOT_FOUND: "property not found. Check its ID in GA_PROPERTIES",
  http_404: "property not found. Check its ID in GA_PROPERTIES",
  RESOURCE_EXHAUSTED: "Google's daily limit for this property was reached. It resets tomorrow",
  http_429: "Google's daily limit for this property was reached. It resets tomorrow",
  network: "couldn't reach Google",
  timeout: "couldn't reach Google (timed out)",
  bad_property_id: "the property ID isn't a number. Check GA_PROPERTIES",
};

/** Why a site has no numbers, and what to do about it. */
export function unavailableLine(code: string): string {
  const why = FIXES[code] ?? (code.startsWith("http_5") ? "Google had a server error" : `Google said ${escapeMrkdwn(clip(code, 60))}`);
  return `_Couldn't get this site's numbers from Google: ${why}._`;
}

function actionLines(a: Actions): string[] {
  return [
    `📞 Calls from the site: *${n(a.phoneClicks.thisWeek)}*${changeNote(a.phoneClicks)}`,
    `📅 Booking clicks: *${n(a.bookingClicks.thisWeek)}*${changeNote(a.bookingClicks)}`,
    `📝 Form requests: *${n(a.formRequests.thisWeek)}*${changeNote(a.formRequests)}`,
    `✉️ Email clicks: *${n(a.emailClicks.thisWeek)}*${changeNote(a.emailClicks)}`,
  ];
}

function totalsText(report: TrafficReport): string {
  const t = report.totals;
  return [
    `*All sites: ${plural(t.visitors.thisWeek, "visitor", "visitors")}*${changeNote(t.visitors)} · ${plural(t.visits.thisWeek, "visit", "visits")}`,
    ...actionLines(t.actions),
  ].join("\n");
}

function okSiteText(s: OkSite): string {
  const name = `*${safe(s.site, SITE_NAME_MAX)}*`;
  if (s.visitors.thisWeek === 0 && s.visits.thisWeek === 0) return `${name}\nNo visitors this week.`;
  const a = s.actions;
  const lines = [
    name,
    `${plural(s.visitors.thisWeek, "visitor", "visitors")}${shortChange(s.visitors)} · ${plural(s.visits.thisWeek, "visit", "visits")}`,
  ];
  if (s.topSources.length > 0) {
    lines.push(`From: ${s.topSources.map((src) => `${safe(src.label, SOURCE_NAME_MAX)} ${n(src.visits)}`).join(" · ")}`);
  }
  lines.push(
    `Calls from the site ${n(a.phoneClicks.thisWeek)} · Booking clicks ${n(a.bookingClicks.thisWeek)} · Form requests ${n(a.formRequests.thisWeek)} · Email clicks ${n(a.emailClicks.thisWeek)}`
  );
  return lines.join("\n");
}

function siteText(s: SiteTraffic): string {
  return s.status === "ok" ? okSiteText(s) : `*${safe(s.site, SITE_NAME_MAX)}*\n${unavailableLine(s.reason)}`;
}

function section(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text: clip(text, SECTION_TEXT_MAX) } };
}

function context(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text: clip(text, SECTION_TEXT_MAX) }] };
}

function footer(report: TrafficReport): string {
  const parts = [
    "Mon–Sun, Eastern time.",
    `Changes compare with ${report.previousWeek.label}.`,
    "A person who visits two sites counts once on each.",
  ];
  if (report.unavailableCount > 0) {
    parts.push(`${plural(report.unavailableCount, "site", "sites")} couldn't be read.`);
  }
  parts.push("From Google Analytics.");
  return parts.join(" ");
}

export function renderTrafficMessage(report: TrafficReport, opts: { preview?: boolean } = {}): TrafficMessage {
  const loaded = report.siteCount - report.unavailableCount;
  const text = clip(
    `Website traffic, ${report.week.label}: ${plural(report.totals.visitors.thisWeek, "visitor", "visitors")} across ${plural(loaded, "site", "sites")}, ${plural(report.totals.actions.phoneClicks.thisWeek, "call", "calls")} from the site.`,
    SECTION_TEXT_MAX
  );

  const shown = report.sites.slice(0, MAX_SITE_SECTIONS);
  const rest = report.sites.slice(MAX_SITE_SECTIONS);

  const blocks: SlackBlock[] = [];
  if (opts.preview) blocks.push(context(PREVIEW_NOTE));
  blocks.push(
    { type: "header", text: { type: "plain_text", text: clip(`Website traffic: ${report.week.label}`, HEADER_MAX), emoji: true } },
    section(totalsText(report)),
    { type: "divider" },
    ...shown.map((s) => section(siteText(s)))
  );
  if (rest.length > 0) {
    const visitors = rest.reduce((t, s) => t + (s.status === "ok" ? s.visitors.thisWeek : 0), 0);
    blocks.push(section(`…and ${n(rest.length)} more sites, with ${plural(visitors, "visitor", "visitors")} between them.`));
  }
  blocks.push(context(footer(report)));
  return { text, blocks };
}
