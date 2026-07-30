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

// "8:00a" — compact, so a 6-job list stays scannable on a phone.
function timeLabel(iso: string | null): string {
  if (!iso) return "  --  ";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}${get("dayPeriod").toLowerCase().startsWith("a") ? "a" : "p"}`;
}

function jobLines(row: TodayScheduleRow): string {
  const geo = [row.zone, row.compass, row.miles != null ? `${row.miles} mi` : null,
    row.driveMinutes != null ? `${row.driveMinutes} min` : null]
    .filter((p) => p != null && p !== "")
    .join(" / ");

  return [
    `${timeLabel(row.scheduledStart)}  ${row.customerName ?? "Unknown customer"}`,
    `       ${geo}`,
    `       Tech: ${row.technicianName ?? "Unassigned"}`,
  ].join("\n");
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
