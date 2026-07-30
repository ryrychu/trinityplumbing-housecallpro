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
import { formatPaidInvoices, formatApprovedEstimates } from "@/lib/slack/format";
import { detectPaidInvoices, detectApprovedEstimates } from "./detect";
import { claimMany } from "./dedupe";

interface HasCustomerRef {
  customerName: string | null;
  customerId: string | null;
}

// I4: detect.ts's nested-name read (customer.first_name/last_name/company) is
// best-effort and unverified against a live payload; HcpInvoice/HcpEstimate
// both type `customer` as `{ id }`-only elsewhere in the sync path. Rather
// than trust the nested names, resolve any still-missing name from the
// already-synced local `customers` table by id — the same source of truth
// src/lib/dashboard/queries.ts's `fullName` pattern reads from. Kept here
// (not in detect.ts) because it needs DB access; detect.ts stays pure.
//
// Only queries for the subset that still needs it, and only once per batch
// (deduped ids), so the common case — nested names present — never touches
// the database.
async function fillMissingCustomerNames<T extends HasCustomerRef>(
  supabase: SupabaseClient,
  lines: T[]
): Promise<T[]> {
  const missingIds = Array.from(
    new Set(
      lines
        .filter((l): l is T & { customerId: string } => l.customerName == null && !!l.customerId)
        .map((l) => l.customerId)
    )
  );
  if (missingIds.length === 0) return lines;

  const { data, error } = await supabase
    .from("customers")
    .select("id, first_name, last_name, company")
    .in("id", missingIds);
  if (error || !data) return lines;

  const byId = new Map(
    (
      data as Array<{
        id: string;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
      }>
    ).map((c) => [c.id, c])
  );

  return lines.map((l) => {
    if (l.customerName != null || !l.customerId) return l;
    const c = byId.get(l.customerId);
    if (!c) return l;
    const person = [c.first_name, c.last_name].filter(Boolean).join(" ");
    const name = person || c.company || null;
    return name ? { ...l, customerName: name } : l;
  });
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
