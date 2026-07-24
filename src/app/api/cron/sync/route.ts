import { NextResponse } from "next/server";
import { HousecallClient } from "@/lib/housecall/client";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import { mapCustomer, mapEmployee, mapJob, mapEstimate, mapInvoice } from "@/lib/sync/mappers";
import { buildGeocodeTargets } from "@/lib/sync/geocodeSpecs";
import { enrichRowsWithGeocode, type GeocodeBudget } from "@/lib/geo/geocode";
import { syncResourceIncremental, type IncrementalResult } from "@/lib/sync/incremental";

// A steady-state incremental run costs ~2s (each resource stops after one page);
// the daily invoice reconcile below costs ~70s. 300s leaves generous headroom.
// NOTE: requires a Vercel plan that permits it — Hobby caps function duration
// lower, in which case the invoice reconcile must be split further.
export const maxDuration = 300;

// Cap network geocode calls per cron run so a large first backfill never exceeds
// the serverless timeout. Cache hits are free; the cache fills over successive
// runs. Run the one-time bulk backfill locally (no timeout) to fill it fast.
const DEFAULT_GEOCODE_MAX_PER_RUN = 500;

// Invoices carry no `updated_at` in the live HCP payload (go-live Step 2
// finding: keys are id/items/taxes/amount/due_at/job_id/status/paid_at/...
// invoice_date/service_date). The incremental cursor therefore can never
// advance, so every run re-paged all ~2.9k invoices — 58 API calls and ~70s of
// a ~72s run, ~5.6k wasted calls/day. Webhooks cover live invoice changes, so
// the cron only needs to catch drift: do a full invoice pass at most once per
// this many hours.
const DEFAULT_INVOICE_RECONCILE_HOURS = 24;

async function syncAllPages<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; page: number; totalPages: number }>,
  table: string,
  mapper: (x: T) => Record<string, unknown>,
  budget: GeocodeBudget
) {
  const supabase = getSupabaseServerClient();
  let page = 1;
  let totalPages = 1;

  do {
    const result = await fetchPage(page);
    totalPages = result.totalPages;

    if (result.items.length > 0) {
      const rows = result.items.map(mapper);
      // Fill lat/lng in place before upserting (customers + jobs only).
      const targets = buildGeocodeTargets(table, result.items as unknown[], rows);
      if (targets.length > 0) {
        await enrichRowsWithGeocode(supabase, targets, budget);
      }
      const { error } = await supabase.from(table).upsert(rows);
      if (error) {
        throw new Error(`Backfill upsert failed for ${table} page ${page}: ${error.message}`);
      }
    }

    page += 1;
  } while (page <= totalPages);
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseServerClient();
  const hcp = new HousecallClient();
  const budget: GeocodeBudget = {
    remaining: Number(process.env.GEOCODE_MAX_PER_RUN ?? DEFAULT_GEOCODE_MAX_PER_RUN),
  };

  // Load per-resource cursors. A missing/null cursor => full backfill.
  const { data: cursorRows } = await supabase
    .from("sync_cursors")
    .select("resource, last_updated_at, synced_at");
  const cursors = new Map<string, string | null>();
  const lastSyncedAt = new Map<string, string | null>();
  for (const r of (cursorRows ?? []) as Array<{
    resource: string;
    last_updated_at: string | null;
    synced_at: string | null;
  }>) {
    cursors.set(r.resource, r.last_updated_at);
    lastSyncedAt.set(r.resource, r.synced_at);
  }

  // Invoices have no usable cursor (see above), so gate them on elapsed time
  // instead. Never reconciled => run now.
  const reconcileHours = Number(
    process.env.INVOICE_RECONCILE_HOURS ?? DEFAULT_INVOICE_RECONCILE_HOURS
  );
  const invoicesLastRun = lastSyncedAt.get("invoices");
  const invoicesLastRunMs = invoicesLastRun ? Date.parse(invoicesLastRun) : NaN;
  const shouldReconcileInvoices =
    Number.isNaN(invoicesLastRunMs) || Date.now() - invoicesLastRunMs >= reconcileHours * 3_600_000;

  // Employees (6 rows) stay a full resync; the big four sync incrementally,
  // sharing the geocode budget so a first backfill can't blow the timeout.
  await syncAllPages((p) => hcp.listEmployees(p), "technicians", mapEmployee, budget);

  const results: IncrementalResult[] = [
    await syncResourceIncremental(supabase, "customers", (p) => hcp.listCustomers(p), mapCustomer, budget, cursors.get("customers") ?? null),
    await syncResourceIncremental(supabase, "jobs", (p) => hcp.listJobs(p), mapJob, budget, cursors.get("jobs") ?? null),
    await syncResourceIncremental(supabase, "estimates", (p) => hcp.listEstimates(p), mapEstimate, budget, cursors.get("estimates") ?? null),
  ];

  if (shouldReconcileInvoices) {
    // Always a full pass: the cursor is meaningless for invoices, and passing a
    // stale one would make the early-stop skip records unpredictably.
    results.push(
      await syncResourceIncremental(supabase, "invoices", (p) => hcp.listInvoices(p), mapInvoice, budget, null)
    );
  }

  // Persist cursors for every resource that ran. Resources with no usable
  // timestamp (invoices) still record `synced_at`, which is what gates the
  // reconcile above; `last_updated_at` stays null for them.
  const syncedAt = new Date().toISOString();
  const cursorUpserts = results.map((r) => ({
    resource: r.resource,
    last_updated_at: r.newCursor,
    synced_at: syncedAt,
  }));
  if (cursorUpserts.length > 0) {
    await supabase.from("sync_cursors").upsert(cursorUpserts);
  }

  return NextResponse.json(
    {
      ok: true,
      syncedAt,
      geocodeBudgetRemaining: budget.remaining,
      invoicesReconciled: shouldReconcileInvoices,
      resources: Object.fromEntries(results.map((r) => [r.resource, { upserted: r.upserted, pages: r.pagesFetched }])),
    },
    { status: 200 }
  );
}
