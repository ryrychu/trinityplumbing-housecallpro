//
// Detect -> claim -> [resolve missing customer names] -> post, in that order.
// One batched message per channel per run: four newly-paid invoices are one
// message with four lines, which keeps Slack's per-webhook rate limit
// irrelevant and the channel readable.
//
// The kill switch is checked BEFORE claiming. Claiming while disabled would
// silently burn the claim and permanently suppress that notification once
// alerts are turned on.
import type { SupabaseClient } from "@supabase/supabase-js";
import { postSlack, slackAlertsEnabled } from "@/lib/slack/client";
import { selectByIds } from "@/lib/supabase/selectByIds";
import { formatPaidInvoices, formatApprovedEstimates } from "@/lib/slack/format";
import { detectPaidInvoices, detectApprovedEstimates } from "./detect";
import { claimMany } from "./dedupe";

interface HasCustomerRef {
  customerName: string | null;
  customerId: string | null;
  // Invoices only. Estimates carry a real `customer` and never need this hop,
  // so it is optional rather than a field every caller has to invent.
  jobId?: string | null;
}

// Resolve a name for every line that still lacks one, walking as far down the
// chain as that line's payload allows:
//
//   customerName (from the payload)             -- estimates: usually here
//     -> customerId -> customers                -- an id-only customer
//       -> jobId -> jobs.customer_id -> customers   -- INVOICES: always here
//
// The last hop is the one that matters in production. A live invoice payload
// contains no `customer` key whatsoever (see detect.ts), so the first two
// steps yield nothing and every line rendered "Unknown customer" — fourteen in
// a row across three real Slack messages on 2026-08-13. `job_id` is the only
// customer link HCP puts on an invoice, and both mirrors it needs (jobs,
// customers) are synced earlier in the same cron run.
//
// Kept here rather than in detect.ts because it needs DB access; detect.ts
// stays pure. Each hop runs at most one query per batch over deduped ids, and
// only for the subset still missing a name — a batch that already has names
// never touches the database.
async function fillMissingCustomerNames<T extends HasCustomerRef>(
  supabase: SupabaseClient,
  lines: T[]
): Promise<T[]> {
  const needsName = lines.filter((l) => l.customerName == null);
  if (needsName.length === 0) return lines;

  // Hop 1: lines that already name a customer id use it directly.
  const idByLine = new Map<T, string>();
  for (const l of needsName) {
    if (l.customerId) idByLine.set(l, l.customerId);
  }

  // Hop 2: everything still unresolved goes through its job.
  const jobIds = unique(
    needsName.filter((l) => !idByLine.has(l)).map((l) => l.jobId ?? null)
  );
  if (jobIds.length > 0) {
    const jobs = await selectByIds<{ id: string; customer_id: string | null }>(
      supabase,
      "jobs",
      "id, customer_id",
      jobIds
    );
    const customerIdByJob = new Map(jobs.map((j) => [j.id, j.customer_id]));
    for (const l of needsName) {
      if (idByLine.has(l) || !l.jobId) continue;
      const customerId = customerIdByJob.get(l.jobId);
      if (customerId) idByLine.set(l, customerId);
    }
  }

  const customerIds = unique(Array.from(idByLine.values()));
  if (customerIds.length === 0) return lines;

  const customers = await selectByIds<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    company: string | null;
  }>(supabase, "customers", "id, first_name, last_name, company", customerIds);

  // Matches the `fullName` pattern in src/lib/dashboard/queries.ts and
  // customerNames() in src/lib/mobile/money.ts: person name first, company as
  // the fallback for a commercial account filed with no contact name.
  const nameById = new Map(
    customers.map((c) => {
      const person = [c.first_name, c.last_name].filter(Boolean).join(" ");
      return [c.id, person || c.company || null];
    })
  );

  return lines.map((l) => {
    const customerId = idByLine.get(l);
    if (!customerId) return l;
    const name = nameById.get(customerId);
    return name ? { ...l, customerName: name } : l;
  });
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v)));
}

// Both notify* functions return the count of NEWLY CLAIMED items (i.e. rows
// notifications_sent didn't already have), not a confirmed-delivered count —
// postSlack's own success/failure is never checked here. A Slack outage after
// a successful claim still returns the full count; this is the documented
// insert-first trade-off (claim before post), not a bug.
export async function notifyPaidInvoices(
  supabase: SupabaseClient,
  invoices: unknown[]
): Promise<number> {
  if (!slackAlertsEnabled()) return 0;

  const candidates = detectPaidInvoices(invoices);
  if (candidates.length === 0) return 0;

  const claimed = new Set(
    await claimMany(supabase, "invoice_paid", candidates.map((c) => c.id))
  );
  const fresh = candidates.filter((c) => claimed.has(c.id));
  if (fresh.length === 0) return 0;

  const resolved = await fillMissingCustomerNames(supabase, fresh);
  await postSlack(process.env.SLACK_WEBHOOK_INVOICES, formatPaidInvoices(resolved));
  return resolved.length;
}

// See notifyPaidInvoices's note above: the return value is a claimed count,
// not a delivered-to-Slack count.
export async function notifyApprovedEstimates(
  supabase: SupabaseClient,
  estimates: unknown[]
): Promise<number> {
  if (!slackAlertsEnabled()) return 0;

  const candidates = detectApprovedEstimates(estimates);
  if (candidates.length === 0) return 0;

  const claimed = new Set(
    await claimMany(supabase, "estimate_approved", candidates.map((c) => c.key))
  );
  const fresh = candidates.filter((c) => claimed.has(c.key));
  if (fresh.length === 0) return 0;

  const resolved = await fillMissingCustomerNames(supabase, fresh);
  await postSlack(process.env.SLACK_WEBHOOK_ESTIMATES, formatApprovedEstimates(resolved));
  return resolved.length;
}
