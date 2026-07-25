// Incremental, cursor-based resource sync for the polling cron.
//
// HCP list endpoints have no modified-since filter but honor
// sort_by=updated_at&sort_direction=desc (item 4 probe). We page newest-first
// and stop as soon as we reach a record older than the stored cursor, so a
// steady-state run touches only the changed pages instead of every page.
//
// Idempotency: the stop test is strict (`updated_at < cursor`), so records whose
// updated_at exactly equals the cursor are re-upserted rather than skipped —
// upsert is idempotent, and this guarantees no record is ever missed at a page
// boundary. A null cursor means "never synced" -> full backfill.
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildGeocodeTargets } from "./geocodeSpecs";
import { enrichRowsWithGeocode, type GeocodeBudget } from "@/lib/geo/geocode";
import { syncAttachments, type RehostBudget } from "./attachments";

export interface IncrementalResult {
  resource: string;
  newCursor: string | null; // max updated_at seen (>= the old cursor)
  upserted: number;
  pagesFetched: number;
}

interface WithUpdatedAt {
  updated_at?: string;
}

// Resource key doubles as the destination table name (true for the four
// incremental resources: customers/jobs/estimates/invoices).
export async function syncResourceIncremental<T extends WithUpdatedAt>(
  supabase: SupabaseClient,
  resource: string,
  fetchPage: (page: number) => Promise<{ items: T[]; page: number; totalPages: number }>,
  mapper: (x: T) => Record<string, unknown>,
  budget: GeocodeBudget,
  cursor: string | null,
  rehostBudget?: RehostBudget
): Promise<IncrementalResult> {
  let page = 1;
  let totalPages = 1;
  let maxUpdated = cursor;
  let upserted = 0;
  let pagesFetched = 0;
  let stop = false;

  do {
    const result = await fetchPage(page);
    totalPages = result.totalPages;
    pagesFetched += 1;

    // Items arrive sorted updated_at desc. Collect the fresh ones; stop at the
    // first record strictly older than the cursor.
    const fresh: T[] = [];
    for (const item of result.items) {
      const u = item.updated_at;
      if (cursor && u && u < cursor) {
        stop = true;
        break;
      }
      fresh.push(item);
      if (u && (maxUpdated === null || u > maxUpdated)) maxUpdated = u;
    }

    if (fresh.length > 0) {
      const rows = fresh.map(mapper);
      const targets = buildGeocodeTargets(resource, fresh as unknown[], rows);
      if (targets.length > 0) {
        await enrichRowsWithGeocode(supabase, targets, budget);
      }
      const { error } = await supabase.from(resource).upsert(rows);
      if (error) {
        throw new Error(`Incremental upsert failed for ${resource} page ${page}: ${error.message}`);
      }
      upserted += rows.length;

      // Backfill attachments for the ~3000 already-synced records that never
      // went through the webhook path. Best-effort: attachments must never fail
      // the parent sync — the parent rows are already upserted above.
      //
      // With a rehostBudget the files are copied into Storage until the run's cap
      // is spent (hcp_url is a 1h presigned link, so metadata alone would leave
      // the file unreachable); later runs pick up where this one stopped. Without
      // a budget this stays metadata-only and can't hit serverless timeouts.
      if (resource === "customers" || resource === "jobs") {
        const parentType = resource === "jobs" ? "job" : "customer";
        const attachmentOpts = rehostBudget
          ? { rehost: true, budget: rehostBudget }
          : { rehost: false };
        for (let i = 0; i < fresh.length; i++) {
          const id = rows[i].id as string;
          try {
            await syncAttachments(supabase, parentType, id, fresh[i], attachmentOpts);
          } catch (err) {
            console.error(`Incremental attachment sync failed for ${parentType} ${id}:`, err);
          }
        }
      }
    }

    page += 1;
  } while (!stop && page <= totalPages);

  return { resource, newCursor: maxUpdated, upserted, pagesFetched };
}
