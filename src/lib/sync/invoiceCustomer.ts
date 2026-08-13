// Invoices are the one mirrored resource whose row cannot know its own
// customer.
//
// The live HCP invoice payload has no `customer` key at all — the go-live
// Step 2 key census is id/items/taxes/amount/due_at/job_id/status/paid_at/
// invoice_date/service_date — so `mapInvoice`, being a pure function of that
// payload, could only ever write customer_id = null. Every one of the ~2.9k
// mirrored invoices therefore had a null customer_id, which is what made the
// Money screen's unpaid list render "Unknown customer" for every row.
//
// `job_id` IS on the payload (docs/PHASE-1.x-BACKLOG.md item 4), and jobs
// carry customer_id, so the missing link is one lookup away. It lives here
// rather than in mappers.ts because it needs the database and mappers stay
// pure; the sync calls it in place, immediately before the upsert, the same
// shape enrichRowsWithGeocode uses to fill lat/lng.
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectByIds } from "@/lib/supabase/selectByIds";

interface InvoiceRow {
  job_id?: unknown;
  customer_id?: unknown;
}

/**
 * Fill `customer_id` on mapped invoice rows from the job each invoice belongs
 * to. Mutates `rows` in place, matching the geocode enrichment it sits beside.
 *
 * Rows that already have a customer_id, carry no job_id, or whose job is not
 * in the mirror (or itself has no customer) are left exactly as they were —
 * a null customer_id is the honest answer, and the callers already render it
 * as "Unknown customer".
 *
 * Never throws: this runs inside the per-page loop of the sync the dashboard
 * depends on, and a jobs lookup failing is not a reason to lose the invoice.
 */
export async function fillInvoiceCustomerIds(
  supabase: SupabaseClient,
  rows: InvoiceRow[]
): Promise<void> {
  const pending = rows.filter(
    (r) => r.customer_id == null && typeof r.job_id === "string" && r.job_id
  );
  if (pending.length === 0) return;

  const jobIds = Array.from(new Set(pending.map((r) => r.job_id as string)));
  const jobs = await selectByIds<{ id: string; customer_id: string | null }>(
    supabase,
    "jobs",
    "id, customer_id",
    jobIds
  );
  const customerIdByJob = new Map(jobs.map((j) => [j.id, j.customer_id]));

  for (const row of pending) {
    const customerId = customerIdByJob.get(row.job_id as string);
    if (customerId) row.customer_id = customerId;
  }
}
