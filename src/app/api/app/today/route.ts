import { getDashboardSnapshot } from "@/lib/dashboard/queries";
import { appJson, appError } from "@/lib/mobile/envelope";
import { requireUser } from "@/lib/mobile/session";
import type { MirrorResource } from "@/lib/mobile/mirrorFreshness";

export const dynamic = "force-dynamic";

// Vercel renders in UTC; Trinity's day boundary (and the label the owner
// reads first thing) is America/New_York regardless of where the server runs.
const BUSINESS_TIME_ZONE = "America/New_York";

// What the freshness stamp on this screen describes. Deliberately NOT
// "invoices", even though the Unpaid counter below is derived from them:
// invoices reconcile at most once every INVOICE_RECONCILE_HOURS, so declaring
// them here would push this screen's threshold past 20 hours and hide a dead
// 15-minute cron behind a number that looks fine. The stamp sits beside the
// day's schedule and describes the day's schedule.
//
// KNOWN GAP, stated so nobody has to rediscover it: the Unpaid counter is
// therefore NOT covered by this screen's stamp and can be up to a reconcile
// window old while the stamp reads "Synced 2 min ago". Money declares
// `invoices` and carries the honest, longer threshold for that figure.
const RESOURCES: MirrorResource[] = ["jobs", "customers"];

export async function GET() {
  // Defence in depth, not belt-and-braces. Every /api/app/* handler reads
  // through the service-role client and there is no RLS under any table, so
  // before this line the ONLY thing standing between the open internet and
  // 1,497 customers' addresses was one array literal in src/middleware.ts. A
  // typo in that matcher, or a future route mounted somewhere it doesn't
  // cover, would expose everything silently. Checking here turns the
  // invariant into something each route's own tests can hold.
  if (!(await requireUser())) return appError("Not signed in", 401);

  try {
    const snapshot = await getDashboardSnapshot();
    return await appJson(
      {
        dateLabel: new Date().toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone: BUSINESS_TIME_ZONE,
        }),
        jobsInProgress: snapshot.jobsInProgress,
        // Today-scoped, not the all-time emergencyCalls field -- see the doc
        // comment on DashboardSnapshot.emergencyCallsToday for why the two must
        // not be conflated under a screen headed "Today".
        emergencyCalls: snapshot.emergencyCallsToday,
        pendingInvoices: snapshot.pendingInvoices,
        jobs: snapshot.todaySchedule,
      },
      RESOURCES
    );
  } catch (err) {
    // A dead Supabase must surface as an error, not as a quiet "no jobs
    // today" -- an empty schedule and a failed query must never look alike.
    return appError(
      `Couldn't load today: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
