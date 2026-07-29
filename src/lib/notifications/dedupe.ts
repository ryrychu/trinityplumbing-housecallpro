//
// INSERT FIRST, POST SECOND. claimMany inserts with ON CONFLICT DO NOTHING and
// returns only the rows Postgres actually created; those are the ones that have
// not been notified yet. Idempotent under retries, overlapping cron runs, and
// duplicate HCP webhook deliveries, with no locking.
//
// Trade-off, deliberate: a crash between the insert and the Slack post loses
// that notification. The inverse order would double-post on every retry.
// Losing an alert beats spamming the channel.
import type { SupabaseClient } from "@supabase/supabase-js";

export type NotificationKind =
  | "invoice_paid"
  | "estimate_approved"
  | "daily_digest"
  | "weekly_lookahead";

// Batch, not per-row: the 20-hour full invoice reconcile re-touches all ~2,200
// paid invoices, which would otherwise be 2,200 round trips.
export async function claimMany(
  supabase: SupabaseClient,
  kind: NotificationKind,
  entityIds: string[]
): Promise<string[]> {
  const unique = [...new Set(entityIds)];
  if (unique.length === 0) return [];

  const { data, error } = await supabase
    .from("notifications_sent")
    .upsert(
      unique.map((entity_id) => ({ kind, entity_id })),
      { onConflict: "kind,entity_id", ignoreDuplicates: true }
    )
    .select("entity_id");

  if (error) {
    // Claim nothing on error. Posting without a durable claim risks repeating
    // the whole batch on the next run.
    console.error(`[dedupe] claim failed for kind=${kind}:`, error);
    return [];
  }

  return ((data ?? []) as Array<{ entity_id: string }>).map((r) => r.entity_id);
}

export async function claim(
  supabase: SupabaseClient,
  kind: NotificationKind,
  entityId: string
): Promise<boolean> {
  const claimed = await claimMany(supabase, kind, [entityId]);
  return claimed.length === 1;
}
