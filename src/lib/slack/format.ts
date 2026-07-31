// Message builders. Pure — no I/O, no clock reads beyond the injected `now`.
// This is the ONLY place cents become dollars.
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import type { PaidInvoiceLine, ApprovedEstimateLine } from "@/lib/notifications/detect";

const TZ = "America/New_York";

export function formatCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// "Wed Jul 29" for an instant, in local time. Built from parts (rather than
// the default formatted string) because Intl's default en-US rendering
// inserts a comma after the weekday ("Wed, Jul 29"), which the message
// format does not want.
function dayLabel(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("month")} ${get("day")}`;
}

// "2026-07-27" -> "Mon Jul 27". Parsed as local noon so the label can never
// slip a day from a timezone edge.
function dayLabelFromKey(dateKey: string): string {
  return dayLabel(new Date(`${dateKey}T12:00:00Z`));
}

// "1:30 PM". Written in full rather than a compact "1:30p" — this is read on a
// phone at 6am, and the extra three characters cost nothing at 5-6 jobs a day.
function timeLabel(iso: string | null): string {
  if (!iso) return "Time TBD";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
}

// "(518) 555-0142" from whatever HCP stored. Rendered as plain text, not a
// tel: link — Slack's mobile clients already make a formatted number tappable,
// and a link that failed to render would show its markup to everyone.
function phoneLabel(digits: string | null): string | null {
  if (!digits) return null;
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return digits; // international/extension — show as stored
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
}

// One job as a bolded time/name line with indented detail lines:
//
//   • *1:30 PM* — Devon Robinson  ·  📞 (518) 555-0142
//        📍 123 Main St, Averill Park
//        🔧 Water Heater Repair
//        👤 Dan  ·  En Route
//
// Each detail leads with its own icon so the eye can jump straight to the line
// it wants — at four details a repeated "◦" turns the block back into a wall.
//
// Slack's incoming webhooks preserve leading spaces in `text`, so the indent is
// literal rather than a real nested list (mrkdwn has no nesting).
const INDENT = "     ";

function jobLines(row: TodayScheduleRow): string {
  const phone = phoneLabel(row.customerPhone);
  const lines = [
    [
      `• *${timeLabel(row.scheduledStart)}* — ${row.customerName ?? "Unknown customer"}`,
      phone ? `📞 ${phone}` : null,
    ]
      .filter(Boolean)
      .join("  ·  "),
  ];

  // The zone is the fallback location, not an addition: an ungeocoded job with
  // no street still tells a dispatcher roughly where it is, but printing both
  // "123 Main St, Albany" and "Albany Zone" is the noise this format removes.
  const where = row.address ?? (row.zone && row.zone !== "Unknown" ? row.zone : null);
  if (where) lines.push(`${INDENT}📍 ${where}`);
  if (row.service) lines.push(`${INDENT}🔧 ${row.service}`);

  // Always rendered, even with neither name nor status: "Unassigned" is the one
  // line on a 6am schedule that needs someone to act before the day starts, and
  // a missing line reads as "fine" rather than "nobody is going".
  const assignment = [row.technicianName ?? "*Unassigned*", row.status].filter(Boolean).join("  ·  ");
  lines.push(`${INDENT}👤 ${assignment}`);

  return lines.join("\n");
}

export function formatDailyDigest(
  now: Date,
  rows: TodayScheduleRow[],
  lastSyncMinutesAgo: number | null
): string {
  const header = `*Today — ${dayLabel(now)}* — ${rows.length} ${rows.length === 1 ? "job" : "jobs"}`;
  const body = rows.length === 0 ? "No jobs scheduled today." : rows.map(jobLines).join("\n\n");
  // Sync age makes a stalled external scheduler visible in a message that is
  // already read every morning, instead of being noticed a week later.
  const footer =
    lastSyncMinutesAgo == null ? "_last sync: unknown_" : `_last sync: ${lastSyncMinutesAgo} min ago_`;
  return [header, "", body, "", footer].join("\n");
}

export function formatWeeklyLookahead(
  now: Date,
  days: Array<{ dateKey: string; rows: TodayScheduleRow[] }>
): string {
  const total = days.reduce((n, d) => n + d.rows.length, 0);
  const sections = days.map((d) => {
    const heading = `*${dayLabelFromKey(d.dateKey)}*`;
    const body = d.rows.length === 0 ? "No jobs" : d.rows.map(jobLines).join("\n\n");
    return `${heading}\n${body}`;
  });
  return [`*Week ahead* — ${total} ${total === 1 ? "job" : "jobs"}`, "", ...sections].join("\n\n");
}

export function formatPaidInvoices(lines: PaidInvoiceLine[]): string {
  const header = `*${lines.length} ${lines.length === 1 ? "invoice paid" : "invoices paid"}*`;
  const body = lines
    .map((l) => {
      const number = l.invoiceNumber ? ` #${l.invoiceNumber}` : "";
      return `• ${l.customerName ?? "Unknown customer"} — ${formatCents(l.amountCents)}${number}`;
    })
    .join("\n");
  return `${header}\n${body}`;
}

export function formatApprovedEstimates(lines: ApprovedEstimateLine[]): string {
  const header = `*${lines.length} ${lines.length === 1 ? "estimate approved" : "estimates approved"}*`;
  const body = lines
    .map((l) => {
      const option = l.optionName ? ` (${l.optionName})` : "";
      return `• ${l.customerName ?? "Unknown customer"} — ${formatCents(l.amountCents)}${option}`;
    })
    .join("\n");
  return `${header}\n${body}`;
}
