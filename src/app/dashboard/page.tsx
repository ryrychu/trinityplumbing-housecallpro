import { getDashboardSnapshot } from "@/lib/dashboard/queries";
import { StatCard } from "./components/StatCard";
import { SectionHeading } from "./components/SectionHeading";
import { TodaySchedulePanel } from "./components/TodaySchedulePanel";
import { TechnicianWorkloadPanel } from "./components/TechnicianWorkloadPanel";

export const dynamic = "force-dynamic";

// The server renders in UTC on Vercel; show the operator their own clock.
const BUSINESS_TIME_ZONE = "America/New_York";

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export default async function DashboardPage() {
  const snapshot = await getDashboardSnapshot();
  const now = new Date();

  const asOfDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: BUSINESS_TIME_ZONE,
  });
  const asOfTime = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
  });

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-8 border-b border-surface-divider pb-5">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="h-8 w-1 rounded-full bg-brand" />
          <div>
            <h1 className="text-xl font-bold tracking-tight text-ink-primary sm:text-2xl">
              Trinity Plumbing <span className="text-ink-muted">&middot; Operations</span>
            </h1>
            <p className="mt-0.5 text-sm text-ink-faint">
              {asOfDate}
              {" · as of "}
              {asOfTime}
            </p>
          </div>
        </div>
      </header>

      <section className="mb-8">
        <SectionHeading>Field Ops</SectionHeading>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard label="Jobs in Progress" value={snapshot.jobsInProgress} />
          <StatCard
            label="Emergency Calls"
            value={snapshot.emergencyCalls}
            tone={snapshot.emergencyCalls > 0 ? "danger" : "default"}
          />
          <StatCard label="Commercial Jobs" value={snapshot.commercialJobs} />
        </div>
      </section>

      <section className="mb-8">
        <SectionHeading>Pipeline</SectionHeading>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard label="Open Estimates" value={snapshot.openEstimates} />
          <StatCard label="Upcoming Estimates" value={snapshot.upcomingEstimates} />
          <StatCard
            label="Pending Invoices"
            value={snapshot.pendingInvoices}
            tone={snapshot.pendingInvoices > 0 ? "warn" : "default"}
          />
        </div>
      </section>

      <section className="mb-8">
        <SectionHeading>Revenue</SectionHeading>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <StatCard
            label="Revenue Booked · This Week"
            value={money(snapshot.revenueBookedThisWeekCents)}
            tone="success"
          />
          <StatCard
            label="Revenue Scheduled · Next Week"
            value={money(snapshot.revenueScheduledNextWeekCents)}
            tone="success"
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TodaySchedulePanel jobs={snapshot.todaySchedule} />
        </div>
        <div>
          <TechnicianWorkloadPanel rows={snapshot.technicianWorkload} />
        </div>
      </div>
    </main>
  );
}
