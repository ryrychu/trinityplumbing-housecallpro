import { NextResponse } from "next/server";
import { HousecallClient } from "@/lib/housecall/client";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import { mapCustomer, mapEmployee, mapJob, mapEstimate, mapInvoice, mapLead } from "@/lib/sync/mappers";
import { buildGeocodeTargets } from "@/lib/sync/geocodeSpecs";
import { enrichRowsWithGeocode, type GeocodeBudget } from "@/lib/geo/geocode";
import { syncResourceIncremental, type IncrementalResult } from "@/lib/sync/incremental";
import { type RehostBudget } from "@/lib/sync/attachments";
import { notifyPaidInvoices, notifyApprovedEstimates } from "@/lib/notifications/dispatch";
import { claim } from "@/lib/notifications/dedupe";
import {
  isDailyDigestDue,
  isWeeklyLookaheadDue,
  localDateKey,
  mondayDateKey,
} from "@/lib/notifications/schedule";
import { renderDigest, isDigestKind } from "@/lib/notifications/digest";
import { postSlack, slackAlertsEnabled } from "@/lib/slack/client";

// A steady-state incremental run costs ~2s (each resource stops after one page);
// the daily invoice reconcile below costs ~70s. 300s leaves generous headroom.
// NOTE: requires a Vercel plan that permits it — Hobby caps function duration
// lower, in which case the invoice reconcile must be split further.
export const maxDuration = 300;

// Cap network geocode calls per cron run so a large first backfill never exceeds
// the serverless timeout. Cache hits are free; the cache fills over successive
// runs. Run the one-time bulk backfill locally (no timeout) to fill it fast.
const DEFAULT_GEOCODE_MAX_PER_RUN = 500;

// Attachment files must be copied into Supabase Storage because hcp_url is a
// presigned S3 link that expires in 1 hour — metadata alone leaves the file
// unreachable. Each copy is a download + upload of a real file (~2MB photos are
// typical), so cap them per run and let successive runs finish the backfill.
// Only ~1.6% of jobs carry an attachment, so the tail is short.
const DEFAULT_ATTACHMENT_REHOST_MAX_PER_RUN = 25;

// Invoices carry no `updated_at` in the live HCP payload (go-live Step 2
// finding: keys are id/items/taxes/amount/due_at/job_id/status/paid_at/...
// invoice_date/service_date). The incremental cursor therefore can never
// advance, so every run re-paged all ~2.9k invoices — 58 API calls and ~70s of
// a ~72s run, ~5.6k wasted calls/day. So do a full invoice pass at most once
// per this many hours.
//
// IMPORTANT: HCP webhooks do NOT cover invoices (the dashboard offers events
// only for Jobs, Job Appointments, Estimates, Estimate Options, Customers, and
// Leads). This cron is therefore the ONLY thing that keeps invoices fresh.
//
// The threshold must stay comfortably BELOW the cron interval. On Vercel Hobby
// the cron runs daily with ±59 min precision, so two runs can land ~23h apart;
// a 24h threshold would skip the reconcile entirely on those days and push
// staleness to ~47h. 20h leaves margin without ever double-running in a day.
const DEFAULT_INVOICE_RECONCILE_HOURS = 20;

// Estimates need a full pass for a different reason than invoices, and a much
// more frequent one. They DO carry `updated_at` — but HCP does not touch it
// when an option's approval_status changes. Confirmed on the live account
// 2026-08-09 from estimate #937: approved by the customer Wed 2026-08-05
// 3:40pm Eastern, copied to job #5190 the following day, while
// sync_cursors.estimates stayed pinned at 2026-08-05T17:00:06Z (1:00pm
// Eastern) through ~380 cron runs. The cursor holds the max `updated_at` the
// sync has seen, so it would have advanced had either event touched it.
//
// An incremental pass sorted newest-first therefore stops above every
// approved-but-unbumped estimate, permanently. That silently broke two things
// at once: the approval was never detected for Slack, and the mirror kept the
// stale pre-approval options, so isOpenEstimate() went on counting an estimate
// that had already become a job.
//
// No cursor can track a field the source does not update, so a complete pass
// is the only thing that can see an approval. Hourly, not 20-hourly like
// invoices: this is the money alert Trinity acts on, and at ~950 estimates a
// full pass is 19 API calls, roughly a third of the invoice reconcile's 58.
const DEFAULT_ESTIMATE_RECONCILE_HOURS = 1;

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

  // Manual digest trigger — see the forced-digest block near the bottom for
  // why this exists. Validated here rather than treated as a truthy flag so a
  // typo (`?force=daily`) fails loudly instead of silently sending the wrong
  // digest to a real channel.
  const force = new URL(req.url).searchParams.get("force");
  if (force !== null && !isDigestKind(force)) {
    return NextResponse.json(
      { error: `Unknown force value '${force}' — use 'digest' or 'week'` },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();
  const hcp = new HousecallClient();
  const budget: GeocodeBudget = {
    remaining: Number(process.env.GEOCODE_MAX_PER_RUN ?? DEFAULT_GEOCODE_MAX_PER_RUN),
  };
  const rehostBudget: RehostBudget = {
    remaining: Number(
      process.env.ATTACHMENT_REHOST_MAX_PER_RUN ?? DEFAULT_ATTACHMENT_REHOST_MAX_PER_RUN
    ),
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

  // Same elapsed-time gate for the estimate full pass (see the constant above
  // for why a cursor cannot do this job). Tracked under its own `estimates_full`
  // key so it stays independent of the `estimates` cursor, which the
  // incremental runs in between still use and still advance normally.
  const estimateReconcileHours = Number(
    process.env.ESTIMATE_RECONCILE_HOURS ?? DEFAULT_ESTIMATE_RECONCILE_HOURS
  );
  const estimatesFullLastRun = lastSyncedAt.get("estimates_full");
  const estimatesFullLastRunMs = estimatesFullLastRun ? Date.parse(estimatesFullLastRun) : NaN;
  const shouldReconcileEstimates =
    Number.isNaN(estimatesFullLastRunMs) ||
    Date.now() - estimatesFullLastRunMs >= estimateReconcileHours * 3_600_000;

  // Employees (6 rows) stay a full resync; the big four sync incrementally,
  // sharing the geocode budget so a first backfill can't blow the timeout.
  await syncAllPages((p) => hcp.listEmployees(p), "technicians", mapEmployee, budget);

  // I2: the cron is the promised safety net for a missed estimate-approval
  // webhook (retries exhausted, deploy window, rotated secret, a signature
  // mismatch returning 401 — HCP never retries those). Collecting exactly the
  // records THIS run's incremental sync touched (not a fresh query) keeps
  // detection O(changes), per the design's "detection reads only the records
  // sync just touched" rule.
  const touchedEstimates: unknown[] = [];

  // Same idea for invoices, and for a sharper reason. The targeted paid-invoice
  // poll below is a LATENCY optimization; it is not, and cannot be, the
  // correctness guarantee, because its watermark can strand itself with no way
  // back. Two ways that happens, both observed or reachable in production:
  //
  //   1. The watermark never bootstraps. `newPaidWatermark` starts at the old
  //      value and only moves when it sees a truthy `paid_at`, so if page 1
  //      ever comes back without one, null stays null and the poll re-issues
  //      the identical query forever. Live on 2026-08-09: sync_cursors held
  //      `invoices_paid.last_updated_at = null` while its `synced_at` tracked
  //      every run — the poll had been running, and learning nothing, since
  //      alerts were switched on.
  //   2. Back-dated payments. `paid_at_min=<watermark>` cannot see an invoice
  //      whose `paid_at` precedes a cursor the poll has already moved past —
  //      a check collected Tuesday and entered Friday is invisible by design.
  //
  // The 20-hour reconcile is the only pass that sees EVERY invoice, so it is
  // what makes paid-invoice alerts eventually-correct. notifications_sent
  // dedupes the overlap with the poll exactly as it already does between the
  // estimate webhook and the estimate safety net: whichever claims first posts.
  const touchedInvoices: unknown[] = [];

  const results: IncrementalResult[] = [
    await syncResourceIncremental(supabase, "customers", (p) => hcp.listCustomers(p), mapCustomer, budget, cursors.get("customers") ?? null, rehostBudget),
    await syncResourceIncremental(supabase, "jobs", (p) => hcp.listJobs(p), mapJob, budget, cursors.get("jobs") ?? null, rehostBudget),
    await syncResourceIncremental(
      supabase,
      "estimates",
      (p) => hcp.listEstimates(p),
      mapEstimate,
      budget,
      // null on a reconcile run = full pass, so an approved estimate whose
      // `updated_at` never moved is still seen. `maxUpdated` starts from
      // nothing but ends at the true max across every estimate, so this
      // leaves the `estimates` cursor exactly where an incremental run
      // would have.
      shouldReconcileEstimates ? null : (cursors.get("estimates") ?? null),
      undefined,
      (items) => touchedEstimates.push(...items)
    ),
    await syncResourceIncremental(supabase, "leads", (p) => hcp.listLeads(p), mapLead, budget, cursors.get("leads") ?? null),
  ];

  // Marker row only — `last_updated_at` stays null, exactly like `invoices`.
  // What gates the next full pass is `synced_at`, which the shared cursor
  // upsert below stamps for every entry in `results`.
  if (shouldReconcileEstimates) {
    results.push({ resource: "estimates_full", newCursor: null, upserted: 0, pagesFetched: 0 });
  }

  if (shouldReconcileInvoices) {
    // Always a full pass: the cursor is meaningless for invoices, and passing a
    // stale one would make the early-stop skip records unpredictably.
    results.push(
      await syncResourceIncremental(
        supabase,
        "invoices",
        (p) => hcp.listInvoices(p),
        mapInvoice,
        budget,
        null,
        undefined,
        (items) => touchedInvoices.push(...items)
      )
    );
  }

  // Targeted paid-invoice poll — ONE API call per run, unlike the 58-call full
  // reconcile above, which is why it can run every 15 minutes. The watermark
  // lives in sync_cursors under a dedicated resource key.
  //
  // notifications_sent (via claimMany) is the correctness guarantee against
  // DUPLICATE notifications. It is NOT what protects against a LOST one — the
  // watermark is. If this block fetched or advanced the watermark while
  // alerts are off, or after a claim/DB error, invoices in that window would
  // be skipped past and never queried again: nothing would have claimed or
  // posted them, yet the cursor would say they were handled. So:
  //
  //   1. The kill switch gates the ENTIRE block — fetch, notify, AND
  //      watermark advance — not just the Slack post. The rollout runbook
  //      deploys with alerts off for a watch period of hours to days
  //      (docs/SLACK-ROLLOUT.md Step 3); this is not a hypothetical window.
  //   2. claimMany (src/lib/notifications/dedupe.ts) THROWS on a DB error
  //      instead of swallowing it. That throw propagates through
  //      notifyPaidInvoices into the catch below, which skips `results.push`
  //      for `invoices_paid` entirely — so cursorUpserts never includes it,
  //      sync_cursors keeps its prior value, and the next run retries these
  //      same invoices instead of silently treating them as handled.
  if (slackAlertsEnabled()) {
    const paidWatermark = cursors.get("invoices_paid") ?? null;
    let newPaidWatermark = paidWatermark;
    try {
      const paidPage = await hcp.listPaidInvoicesSince(paidWatermark);
      await notifyPaidInvoices(supabase, paidPage.items);
      for (const inv of paidPage.items) {
        if (inv.paid_at && (!newPaidWatermark || inv.paid_at > newPaidWatermark)) {
          newPaidWatermark = inv.paid_at;
        }
      }
      results.push({
        resource: "invoices_paid",
        newCursor: newPaidWatermark,
        upserted: 0,
        pagesFetched: 1,
      });
    } catch (err) {
      // A fetch/claim/notification failure must never fail the sync the
      // dashboard depends on — but see the comment above: it must also never
      // reach the results.push above, or the watermark advances on a run that
      // claimed and posted nothing.
      console.error("[cron] paid-invoice notification pass failed:", err);
    }
  }

  // The correctness backstop for paid invoices (see `touchedInvoices` above).
  // Runs only on a reconcile run — roughly one run in eighty — so the cost is
  // one extra claim round trip per 20 hours, not per 15 minutes.
  //
  // Unlike the poll, this pass advances no cursor, so there is nothing a
  // failure here could skip past: a throw just means the next reconcile tries
  // again. That is the whole point of moving correctness off the watermark.
  //
  // Note this feeds EVERY invoice the reconcile touched (~2.9k), not just new
  // ones. detectPaidInvoices filters to the ~2.2k paid, and claimMany collapses
  // them into a single upsert whose `select` returns only the rows Postgres
  // actually created — so the steady-state result is one round trip that
  // returns nothing, and the Slack post is skipped entirely.
  if (slackAlertsEnabled() && touchedInvoices.length > 0) {
    try {
      await notifyPaidInvoices(supabase, touchedInvoices);
    } catch (err) {
      // Same guarantee as every other notification pass: never fail the sync.
      console.error("[cron] paid-invoice reconcile notification pass failed:", err);
    }
  }

  // I2 safety net: estimate approvals are delivered near-instantly by the
  // webhook path (src/app/api/webhooks/housecall/route.ts). This re-checks
  // only the estimate records this run's incremental sync just touched, so a
  // webhook delivery HCP never retries (signature mismatch, rotated secret,
  // deploy window, retries exhausted) still gets picked up here within one
  // poll interval. The shared claim ledger (notifications_sent) makes the
  // overlap with the webhook path free — whichever path claims first posts,
  // the other is a no-op.
  if (slackAlertsEnabled()) {
    try {
      await notifyApprovedEstimates(supabase, touchedEstimates);
    } catch (err) {
      // Same guarantee as every other notification pass: never fail the sync.
      console.error("[cron] estimate-approval notification pass failed:", err);
    }
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

  // A manual digest trigger, for the hours the morning window below
  // deliberately excludes. There is no other way to post a production digest on
  // demand: every secret in this project is a Vercel Sensitive env var, which
  // is write-only — `vercel env pull` returns the literal string [SENSITIVE],
  // so scripts/preview-digest.mts cannot reach production Supabase or Slack
  // from a laptop, and no dashboard button re-runs a cron job. This is the
  // same query and the same formatter, running inside the deployment that
  // already holds the real credentials.
  //
  //   curl -H "Authorization: Bearer $CRON_SECRET" \
  //     "https://<domain>/api/cron/sync?force=digest"     # or force=week
  //
  // Like the preview script, it bypasses claim() and records nothing, so a
  // forced digest never consumes the day's claim and can never suppress the
  // genuine 6am one. The trade-off is that forcing inside the window can
  // produce two messages — the right bias for something a human triggered on
  // purpose, where a silent no-op reads as a broken endpoint.
  let forced: string | null = null;

  if (force) {
    if (!slackAlertsEnabled()) {
      forced = "skipped: SLACK_ALERTS_ENABLED is not 'true'";
    } else {
      try {
        const text = await renderDigest(force, new Date());
        forced = (await postSlack(process.env.SLACK_WEBHOOK_SCHEDULE, text))
          ? "posted"
          : "post failed — see function logs";
      } catch (err) {
        // Surfaced in the response, not merely logged. Nobody triggers this by
        // hand and then goes reading function logs to find out whether the
        // Slack message they are waiting for is coming.
        forced = `failed: ${err instanceof Error ? err.message : String(err)}`;
        console.error("[cron] forced digest failed:", err);
      }
    }
  }

  // Digest timing is decided here rather than by the cron schedule: cron cannot
  // express "6am Eastern", only a UTC hour that is wrong for half the year.
  // Any run inside the local morning window sends it, so a missed 6:00 ping
  // self-heals on the next one; claim() guarantees exactly one per day.
  // Skipped entirely on a forced run, which has already posted above.
  if (!force && slackAlertsEnabled()) {
    const now = new Date();

    // Split from the daily digest below into its own try/catch: sharing one
    // try meant a throw from getWeekAheadSchedule AFTER claim('weekly_lookahead')
    // already succeeded would skip the daily branch too AND permanently lose
    // that week's look-ahead (the claim is already recorded, so a retry finds
    // it pre-claimed and posts nothing). The daily digest is only delayed by
    // a throw, never lost, since tomorrow re-claims a fresh date key — but
    // that only holds if a weekly failure can't take it down too.
    try {
      if (isWeeklyLookaheadDue(now) && (await claim(supabase, "weekly_lookahead", mondayDateKey(now)))) {
        await postSlack(process.env.SLACK_WEBHOOK_SCHEDULE, await renderDigest("week", now));
      }
    } catch (err) {
      // A Slack/digest problem must never fail the sync the dashboard depends on.
      console.error("[cron] weekly look-ahead pass failed:", err);
    }

    try {
      if (isDailyDigestDue(now) && (await claim(supabase, "daily_digest", localDateKey(now)))) {
        await postSlack(process.env.SLACK_WEBHOOK_SCHEDULE, await renderDigest("digest", now));
      }
    } catch (err) {
      // A Slack/digest problem must never fail the sync the dashboard depends on.
      console.error("[cron] daily digest pass failed:", err);
    }
  }

  return NextResponse.json(
    {
      ok: true,
      syncedAt,
      ...(forced ? { forcedDigest: forced } : {}),
      geocodeBudgetRemaining: budget.remaining,
      invoicesReconciled: shouldReconcileInvoices,
      resources: Object.fromEntries(results.map((r) => [r.resource, { upserted: r.upserted, pages: r.pagesFetched }])),
    },
    { status: 200 }
  );
}
