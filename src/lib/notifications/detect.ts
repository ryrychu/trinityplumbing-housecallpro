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
  amountCents: number | null;
  invoiceNumber: string | null;
}

export interface ApprovedEstimateLine {
  key: string;
  customerName: string | null;
  amountCents: number | null;
  optionName: string | null;
}

interface RawCustomer {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
}

function customerName(c: RawCustomer | undefined): string | null {
  if (!c) return null;
  const person = [c.first_name, c.last_name].filter(Boolean).join(" ");
  return person || c.company || null;
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
    if ((inv.status ?? "").toLowerCase() !== PAID_STATUS) continue;

    out.push({
      id: inv.id,
      customerName: customerName(inv.customer),
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
    for (const opt of est.options ?? []) {
      if (!APPROVED_STATUSES.has((opt.approval_status ?? "").toLowerCase())) continue;
      out.push({
        key: estimateOptionKey(est.id, opt.id),
        customerName: customerName(est.customer),
        amountCents: opt.total_amount ?? null,
        optionName: opt.name ?? null,
      });
    }
  }

  return out;
}
