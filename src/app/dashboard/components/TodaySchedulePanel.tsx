import type { DashboardSnapshot } from "@/lib/dashboard/queries";

export function TodaySchedulePanel({ jobs }: { jobs: DashboardSnapshot["todaySchedule"] }) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ marginBottom: 12 }}>Today&apos;s Schedule</h2>
      {jobs.length === 0 ? (
        <p style={{ color: "#666" }}>No jobs scheduled today.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: 8 }}>Time</th>
              <th style={{ padding: 8 }}>Customer</th>
              <th style={{ padding: 8 }}>Technician</th>
              <th style={{ padding: 8 }}>Zone</th>
              <th style={{ padding: 8 }}>Dir</th>
              <th style={{ padding: 8 }}>Miles</th>
              <th style={{ padding: 8 }}>Drive</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: 8 }}>
                  {j.scheduledStart ? new Date(j.scheduledStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                </td>
                <td style={{ padding: 8 }}>{j.customerName ?? "—"}</td>
                <td style={{ padding: 8 }}>{j.technicianName ?? "Unassigned"}</td>
                <td style={{ padding: 8 }}>{j.zone}</td>
                <td style={{ padding: 8 }}>{j.compass}</td>
                <td style={{ padding: 8 }}>{j.miles ?? "—"}</td>
                <td style={{ padding: 8 }}>{j.driveMinutes != null ? `${j.driveMinutes} min` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
