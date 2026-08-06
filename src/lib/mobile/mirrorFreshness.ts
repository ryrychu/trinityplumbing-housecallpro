import { getSupabaseServerClient } from "@/lib/supabase/client";

// How old the DATA is, which is the only question a freshness stamp was ever
// worth asking. `generated_at` answers "when did this HTTP request happen" --
// always seconds ago, always reassuring, and completely independent of whether
// the mirror behind it has been updated since Tuesday.
//
// The real age lives in sync_cursors.synced_at, written per resource by
// src/app/api/cron/sync/route.ts on every run.

export type MirrorResource = "customers" | "jobs" | "estimates" | "invoices";

// Vercel cron cadence (vercel.json: "*/15 * * * *").
const CRON_CADENCE_MINUTES = 15;
// Three cycles. One missed run is normal operations -- a deploy, a cold start,
// a slow HCP page -- and warning on it would train the owner to ignore the
// warning, which is worse than not having one. Three consecutive misses is a
// real problem worth interrupting someone about.
const MISSED_RUNS_TOLERATED = 3;
const FREQUENT_STALE_AFTER_MINUTES = CRON_CADENCE_MINUTES * MISSED_RUNS_TOLERATED;

// Mirrors DEFAULT_INVOICE_RECONCILE_HOURS in the cron route. Read from the same
// env var so the threshold tracks configuration instead of being a second
// number frozen somewhere else and silently drifting from the first.
const DEFAULT_INVOICE_RECONCILE_HOURS = 20;
// The reconcile does not run ON the 20-hour mark; it runs on the first cron
// tick AFTER the window has elapsed. So 20h is the floor for a perfectly
// healthy mirror, never the ceiling. Without headroom the invoice screen would
// spend part of every day warning about a mirror doing exactly what it should.
const INVOICE_RECONCILE_HEADROOM_HOURS = 4;

function invoiceStaleAfterMinutes(): number {
  const configured = Number(
    process.env.INVOICE_RECONCILE_HOURS ?? DEFAULT_INVOICE_RECONCILE_HOURS
  );
  // A malformed env var must not produce NaN and silently disable the warning.
  const hours =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INVOICE_RECONCILE_HOURS;
  return Math.round((hours + INVOICE_RECONCILE_HEADROOM_HOURS) * 60);
}

// Deliberately NOT one global threshold. Invoices are reconciled at most once
// every INVOICE_RECONCILE_HOURS because they have no usable cursor, so a single
// global value would either make every screen look permanently stale (if it
// tracked invoices) or hide a dead cron entirely (if it tracked jobs). Each
// route gets the threshold its own slowest input earns.
export function staleAfterMinutes(resources: MirrorResource[]): number {
  if (resources.length === 0) return FREQUENT_STALE_AFTER_MINUTES;
  return Math.max(
    ...resources.map((r) =>
      r === "invoices" ? invoiceStaleAfterMinutes() : FREQUENT_STALE_AFTER_MINUTES
    )
  );
}

/**
 * The OLDEST synced_at among the resources a route actually reads: a screen is
 * only as fresh as its stalest input, so the minimum is the honest answer and
 * a maximum would let one healthy resource paper over a dead one.
 *
 * Returns null when nothing can be established -- no rows, unreadable table,
 * every row null -- so the caller degrades to the old request-time wording
 * rather than crashing or asserting a freshness it cannot support.
 */
export async function mirrorSyncedAt(resources: MirrorResource[]): Promise<string | null> {
  if (resources.length === 0) return null;

  try {
    const { data, error } = await getSupabaseServerClient()
      .from("sync_cursors")
      .select("resource, synced_at")
      .in("resource", resources);

    if (error) return null;

    // A declared resource with NO cursor row is IGNORED BY DESIGN, not treated
    // as infinitely stale. The known case is `technicians`: the cron syncs
    // employees through syncAllPages(), which never records a cursor, so that
    // resource has no row and never will -- which is why this module's type
    // does not offer it. The trade-off is real and worth stating: if a
    // resource that SHOULD have a row is missing one, this reports the
    // remaining resources' age rather than flagging the gap. Anyone adding a
    // resource here must confirm the cron actually writes a sync_cursors row
    // for it, or staleness will silently never fire for that input.
    const stamps = ((data ?? []) as Array<{ resource: string; synced_at: string | null }>)
      .map((r) => (r.synced_at ? Date.parse(r.synced_at) : NaN))
      .filter((ms) => !Number.isNaN(ms));

    if (stamps.length === 0) return null;
    return new Date(Math.min(...stamps)).toISOString();
  } catch {
    // An unreachable or unreadable sync_cursors must not take down a screen
    // that has perfectly good data to show.
    return null;
  }
}
