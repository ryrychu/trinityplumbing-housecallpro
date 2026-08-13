// Message builders. Pure — no I/O, no clock reads beyond the injected `now`.
// This is the ONLY place cents become dollars.
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import type { PaidInvoiceLine, ApprovedEstimateLine } from "@/lib/notifications/detect";
import type { EstimateHit, InvoiceHit } from "@/lib/mobile/money";

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
// slip a day from a timezone edge. Exported because the slash commands build
// single-day titles ("Tomorrow — Thu Aug 13") from the same label the day
// headings use.
export function dayLabelFromKey(dateKey: string): string {
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

export function formatDailyDigest(now: Date, rows: TodayScheduleRow[]): string {
  const header = `*Today — ${dayLabel(now)}* — ${rows.length} ${rows.length === 1 ? "job" : "jobs"}`;
  const body = rows.length === 0 ? "No jobs scheduled today." : rows.map(jobLines).join("\n\n");
  return [header, "", body].join("\n");
}

// The one schedule renderer. The weekly digest, the week-ahead command and the
// single-day commands all render through this, so they cannot drift apart.
//
// A single day omits the per-day heading: its title already names the date
// ("Tomorrow — Thu Aug 13"), and repeating it directly underneath reads as a
// formatting bug rather than as emphasis.
export function formatScheduleDays(
  title: string,
  days: Array<{ dateKey: string; rows: TodayScheduleRow[] }>
): string {
  const total = days.reduce((n, d) => n + d.rows.length, 0);
  const header = `*${title}* — ${total} ${total === 1 ? "job" : "jobs"}`;

  if (days.length === 1) {
    const body = days[0].rows.length === 0 ? "No jobs" : days[0].rows.map(jobLines).join("\n\n");
    return [header, "", body].join("\n\n");
  }

  const sections = days.map((d) => {
    const heading = `*${dayLabelFromKey(d.dateKey)}*`;
    const body = d.rows.length === 0 ? "No jobs" : d.rows.map(jobLines).join("\n\n");
    return `${heading}\n${body}`;
  });
  return [header, "", ...sections].join("\n\n");
}

// `now` is unused but kept in the signature: this is what the 6am cron and the
// /admin button call (src/lib/notifications/digest.ts), and changing its shape
// would ripple into both for no benefit.
export function formatWeeklyLookahead(
  now: Date,
  days: Array<{ dateKey: string; rows: TodayScheduleRow[] }>
): string {
  return formatScheduleDays("Week ahead", days);
}

// "Aug 12, 10:41 PM" for HCP's `paid_at`. Eastern, like every other timestamp
// here: paid_at is a UTC instant, and an evening payment carries the FOLLOWING
// day's UTC date — 2026-08-13T02:41:00Z is 10:41 PM on the 12th in Averill
// Park — so slicing the ISO string would print the wrong day on every
// after-8pm payment.
//
// No weekday, unlike dayLabel: these lines already sit under a bolded count
// and repeat once per invoice, and "Wed" earns less than the ten columns it
// costs on a phone.
//
// Returns null for a missing or unparseable instant. Intl throws a RangeError
// on an Invalid Date, and a malformed timestamp must cost the reader a detail,
// never the whole message.
function paidAtLabel(iso: string | null): string | null {
  if (!iso) return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`;
}

export function formatPaidInvoices(lines: PaidInvoiceLine[]): string {
  const header = `*${lines.length} ${lines.length === 1 ? "invoice paid" : "invoices paid"}*`;
  const body = lines
    .map((l) => {
      const number = l.invoiceNumber ? ` #${l.invoiceNumber}` : "";
      const paid = paidAtLabel(l.paidAt);
      // Always stamped when HCP gave a time, not only when it differs from
      // today: this channel is read to reconcile against a bank deposit, and
      // an alert can trail the payment by up to the 20-hour invoice reconcile
      // (or arbitrarily, for a back-dated one). An absent stamp would then
      // read as "paid just now", which is the error that costs someone real
      // time to unpick.
      const when = paid ? `  ·  ${paid}` : "";
      return `• ${l.customerName ?? "Unknown customer"} — ${formatCents(l.amountCents)}${number}${when}`;
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

// How many lines of each list to print before collapsing the rest into a
// count. The whole point of this message is to be readable on a phone; 25
// unpaid invoices rendered in full is a wall nobody scrolls.
const MONEY_LIST_LIMIT = 5;

function moneyLines(
  heading: string,
  emptyText: string,
  count: number,
  totalCents: number,
  suffix: string,
  lines: string[]
): string {
  if (count === 0) return `*${heading}* — ${emptyText}`;
  const shown = lines.slice(0, MONEY_LIST_LIMIT);
  const rest = count - shown.length;
  return [
    `*${heading}* — ${count} · ${formatCents(totalCents)}${suffix}`,
    ...shown,
    ...(rest > 0 ? [`… and ${rest} more`] : []),
  ].join("\n");
}

export function formatMoneySummary(estimates: EstimateHit[], invoices: InvoiceHit[]): string {
  const estTotal = estimates.reduce((n, e) => n + (e.amountCents ?? 0), 0);
  const invTotal = invoices.reduce((n, i) => n + (i.amountCents ?? 0), 0);
  const overdue = invoices.filter((i) => i.overdueDays != null).length;

  const estimateBlock = moneyLines(
    "Open estimates",
    "No open estimates",
    estimates.length,
    estTotal,
    "",
    estimates.map((e) => `• ${e.customerName ?? "Unknown customer"} — ${formatCents(e.amountCents)}`)
  );

  const invoiceBlock = moneyLines(
    "Unpaid invoices",
    "No unpaid invoices",
    invoices.length,
    invTotal,
    overdue > 0 ? `  ·  ${overdue} overdue` : "",
    invoices.map((i) => {
      const late = i.overdueDays != null ? `  ·  ${i.overdueDays} days overdue` : "";
      return `• ${i.customerName ?? "Unknown customer"} — ${formatCents(i.amountCents)}${late}`;
    })
  );

  return ["*Money*", "", estimateBlock, "", invoiceBlock].join("\n");
}
