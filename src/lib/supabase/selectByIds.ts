// One chunked, never-throwing `where id in (...)` lookup, shared by the two
// places that resolve an invoice's customer.
//
// Both callers — the sync's invoice enrichment and the Slack paid-invoice
// notifier — walk the same chain (job_id -> jobs.customer_id -> customers) and
// need the same two properties from it, so the lookup lives in one place
// rather than being written twice with two sets of edge cases:
//
//   Chunked, because PostgREST puts `.in()` values in the query string. An
//   unbounded id list becomes an over-long request line, which fails as an
//   opaque HTTP error rather than as a query that returns fewer rows.
//
//   Never throwing, because both callers run after a side effect that must not
//   be undone by a failed name lookup — the sync is mid-page with rows to
//   upsert, and the notifier has already CLAIMED its invoices in
//   notifications_sent, so a throw there would suppress those alerts
//   permanently. Losing a display name is the acceptable failure; losing the
//   invoice is not.
import type { SupabaseClient } from "@supabase/supabase-js";

// Comfortably below any practical URL limit at ~25 chars per HCP id, and well
// above the 50-record page both callers actually work in.
const CHUNK = 200;

export async function selectByIds<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  ids: string[]
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .in("id", ids.slice(i, i + CHUNK));
    // Partial results are kept deliberately: an id that resolved is a real
    // name the reader gets to see, and the rest degrade to the same
    // placeholder they would have had anyway.
    if (error || !data) {
      console.error(`[supabase] ${table} lookup by id failed:`, error?.message);
      return out;
    }
    out.push(...(data as T[]));
  }
  return out;
}
