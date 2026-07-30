//
// Pure detection: records in, notification lines out. No database, no network.
// Accepts `unknown[]` because these records arrive from two different shapes —
// raw HCP API payloads (cron) and webhook bodies — and both are untyped at the
// boundary.

// Live invoice statuses (census over all 2,854 synced invoices):
//   paid 2217 | canceled 570 | voided 42 | open 25. There is no "pending".
const PAID_STATUS = "paid";

// Per-option approval values, matching src/lib/dashboard/queries.ts.
const APPROVED_STATUSES = new Set(["approved", "pro approved"]);

export interface PaidInvoiceLine {
  id: string;
  customerName: string | null;
  // Carried alongside customerName (not resolved here) so a caller with DB
  // access can fall back to a local-table lookup when customerName is null —
  // see dispatch.ts's fillMissingCustomerNames. detect.ts stays pure/no-I/O.
  customerId: string | null;
  amountCents: number | null;
  invoiceNumber: string | null;
}

export interface ApprovedEstimateLine {
  key: string;
  customerName: string | null;
  customerId: string | null;
  amountCents: number | null;
  optionName: string | null;
}

// I4: HcpInvoice/HcpEstimate declare `customer?: { id: string, ... }` — the
// nested first_name/last_name/company below are unverified against a live
// payload (every existing test uses a hand-written fixture with them; if the
// live shape really is `{id}` only, customerName() below always returns
// null). Reading `id` here is what lets dispatch.ts fall back to a local
// `customers` table lookup instead of every line silently reading "Unknown
// customer" — the one piece of information the paid-invoice channel exists
// to report.
interface RawCustomer {
  id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
}

function customerName(c: RawCustomer | undefined): string | null {
  if (!c) return null;
  const person = [c.first_name, c.last_name].filter(Boolean).join(" ");
  return person || c.company || null;
}

// Guard unvalidated string fields to prevent .toLowerCase() throwing on
// non-string values (numbers, booleans). Returns empty string if not a string,
// which fails the approval check gracefully.
function asLower(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase() : "";
}

// The "0" fallback MUST match coalesce(o->>'id','0') in migration 0006, or
// seeded rows will not suppress the notifications they were written to suppress.
export function estimateOptionKey(
  estimateId: string,
  optionId: string | null | undefined
): string {
  return `${estimateId}:${optionId ?? "0"}`;
}

export function detectPaidInvoices(invoices: unknown[]): PaidInvoiceLine[] {
  const out: PaidInvoiceLine[] = [];

  for (const raw of invoices) {
    const inv = raw as {
      id?: string;
      status?: string | null;
      amount?: number | null;
      invoice_number?: string | null;
      customer?: RawCustomer;
    };
    if (!inv?.id) continue;
    if (asLower(inv.status) !== PAID_STATUS) continue;

    out.push({
      id: inv.id,
      customerName: customerName(inv.customer),
      customerId: inv.customer?.id ?? null,
      // Live API: the invoice total field is `amount`, in cents.
      amountCents: inv.amount ?? null,
      invoiceNumber: inv.invoice_number ?? null,
    });
  }

  return out;
}

export function detectApprovedEstimates(estimates: unknown[]): ApprovedEstimateLine[] {
  const out: ApprovedEstimateLine[] = [];

  for (const raw of estimates) {
    const est = raw as {
      id?: string;
      customer?: RawCustomer;
      options?: Array<{
        id?: string | null;
        name?: string | null;
        approval_status?: string | null;
        total_amount?: number | null;
      }>;
    };
    if (!est?.id) continue;

    // Approval is per-option: approving option B must not be silenced by
    // option A, so each approved option is its own claim key.
    // Guard est.options with Array.isArray to match the parallel jsonb_typeof
    // guard in supabase/migrations/0006_notifications.sql. If options is not
    // an array (e.g., an object or scalar), treat it as empty to prevent
    // throwing on for...of iteration and aborting the entire batch.
    for (const opt of Array.isArray(est.options) ? est.options : []) {
      if (!APPROVED_STATUSES.has(asLower(opt.approval_status))) continue;
      out.push({
        key: estimateOptionKey(est.id, opt.id),
        customerName: customerName(est.customer),
        customerId: est.customer?.id ?? null,
        amountCents: opt.total_amount ?? null,
        optionName: opt.name ?? null,
      });
    }
  }

  return out;
}
