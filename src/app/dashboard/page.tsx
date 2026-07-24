import { getDashboardSnapshot } from "@/lib/dashboard/queries";
import { MetricCard } from "./components/MetricCard";
import { TodaySchedulePanel } from "./components/TodaySchedulePanel";
import { TechnicianWorkloadPanel } from "./components/TechnicianWorkloadPanel";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const snapshot = await getDashboardSnapshot();
  const money = (cents: number) => `$${(cents / 100).toLocaleString()}`;

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 24 }}>Trinity Plumbing Operations Dashboard</h1>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <MetricCard label="Jobs in Progress" value={snapshot.jobsInProgress} />
        <MetricCard label="Emergency Calls" value={snapshot.emergencyCalls} highlight={snapshot.emergencyCalls > 0} />
        <MetricCard label="Commercial Jobs" value={snapshot.commercialJobs} />
        <MetricCard label="Open Estimates" value={snapshot.openEstimates} />
        <MetricCard label="Upcoming Estimates" value={snapshot.upcomingEstimates} />
        <MetricCard label="Pending Invoices" value={snapshot.pendingInvoices} />
        <MetricCard label="Revenue Booked (This Week)" value={money(snapshot.revenueBookedThisWeekCents)} />
        <MetricCard label="Revenue Scheduled (Next Week)" value={money(snapshot.revenueScheduledNextWeekCents)} />
      </div>
      <TodaySchedulePanel jobs={snapshot.todaySchedule} />
      <TechnicianWorkloadPanel rows={snapshot.technicianWorkload} />
    </main>
  );
}
