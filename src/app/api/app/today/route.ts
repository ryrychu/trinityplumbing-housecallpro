import { getDashboardSnapshot } from "@/lib/dashboard/queries";
import { appJson, appError } from "@/lib/mobile/envelope";

export const dynamic = "force-dynamic";

// Vercel renders in UTC; Trinity's day boundary (and the label the owner
// reads first thing) is America/New_York regardless of where the server runs.
const BUSINESS_TIME_ZONE = "America/New_York";

export async function GET() {
  try {
    const snapshot = await getDashboardSnapshot();
    return appJson({
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
    });
  } catch (err) {
    // A dead Supabase must surface as an error, not as a quiet "no jobs
    // today" -- an empty schedule and a failed query must never look alike.
    return appError(
      `Couldn't load today: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
