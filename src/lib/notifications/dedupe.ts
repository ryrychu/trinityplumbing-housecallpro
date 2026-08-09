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

// Batch, not per-row: the targeted paid-invoice poll can return up to 50
// invoices in a single run (page_size=50); claiming them one at a time would
// be 50 round trips where one upsert suffices.
//
// The 20-hour full invoice reconcile now feeds this too (the correctness
// backstop in src/app/api/cron/sync/route.ts — the poll's watermark can
// strand itself permanently, so it cannot be the only path). That pass hands
// over every paid invoice in the account at once, ~2.2k of them, which is far
// beyond the 50 this was sized for. It works because `ignoreDuplicates` makes
// all but the genuinely new rows no-ops and `select` returns only what
// Postgres actually created. If that single upsert ever grows past what
// PostgREST will accept, chunk it here rather than at the call site — the
// throw below is already safe (the reconcile pass logs and retries in 20
// hours, advancing no cursor), so the failure mode is delay, not loss.
export async function claimMany(
  supabase: SupabaseClient,
  kind: NotificationKind,
  entityIds: string[]
): Promise<string[]> {
  const unique = Array.from(new Set(entityIds));
  if (unique.length === 0) return [];

  const { data, error } = await supabase
    .from("notifications_sent")
    .upsert(
      unique.map((entity_id) => ({ kind, entity_id })),
      { onConflict: "kind,entity_id", ignoreDuplicates: true }
    )
    .select("entity_id");

  if (error) {
    // THROW rather than return []. Returning [] here used to look safe ("just
    // claim nothing"), but a caller that advances a cursor/watermark on any
    // return value — claimed or not — would treat "the DB errored" the same
    // as "nothing new to claim", and permanently skip past whatever was being
    // claimed. Throwing forces the caller's own try/catch to decide what
    // NOT to do (e.g. route.ts's paid-invoice pass omits its cursor push
    // entirely when this throws, so the watermark stays put and retries).
    console.error(`[dedupe] claim failed for kind=${kind}:`, error);
    throw new Error(`[dedupe] claim failed for kind=${kind}: ${error.message}`);
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
