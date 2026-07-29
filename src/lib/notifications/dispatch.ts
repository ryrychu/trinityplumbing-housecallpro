//
// Detect -> claim -> post, in that order. One batched message per channel per
// run: four newly-paid invoices are one message with four lines, which keeps
// Slack's per-webhook rate limit irrelevant and the channel readable.
//
// The kill switch is checked BEFORE claiming. Claiming while disabled would
// silently burn the claim and permanently suppress that notification once
// alerts are turned on.
import type { SupabaseClient } from "@supabase/supabase-js";
import { postSlack, slackAlertsEnabled } from "@/lib/slack/client";
import { formatPaidInvoices, formatApprovedEstimates } from "@/lib/slack/format";
import { detectPaidInvoices, detectApprovedEstimates } from "./detect";
import { claimMany } from "./dedupe";

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

  await postSlack(process.env.SLACK_WEBHOOK_INVOICES, formatPaidInvoices(fresh));
  return fresh.length;
}

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

  await postSlack(process.env.SLACK_WEBHOOK_ESTIMATES, formatApprovedEstimates(fresh));
  return fresh.length;
}
