import { getDashboardSnapshot } from "@/lib/dashboard/queries";
import { MetricCard } from "./components/MetricCard";

export const dynamic = "force-dynamic"; // always fetch fresh data, never cache the dashboard

export default async function DashboardPage() {
  const snapshot = await getDashboardSnapshot();

  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 24 }}>Trinity Plumbing Operations Dashboard</h1>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <MetricCard label="Jobs in Progress" value={snapshot.jobsInProgress} />
        <MetricCard label="Emergency Calls" value={snapshot.emergencyCalls} highlight={snapshot.emergencyCalls > 0} />
        <MetricCard label="Commercial Jobs" value={snapshot.commercialJobs} />
        <MetricCard label="Open Estimates" value={snapshot.openEstimates} />
        <MetricCard label="Pending Invoices" value={snapshot.pendingInvoices} />
        <MetricCard
          label="Revenue Booked This Week"
          value={`$${(snapshot.revenueBookedThisWeekCents / 100).toLocaleString()}`}
        />
      </div>
    </main>
  );
}
