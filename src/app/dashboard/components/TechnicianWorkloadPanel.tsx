import type { DashboardSnapshot } from "@/lib/dashboard/queries";

export function TechnicianWorkloadPanel({ rows }: { rows: DashboardSnapshot["technicianWorkload"] }) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ marginBottom: 12 }}>Technician Workload (Today)</h2>
      {rows.length === 0 ? (
        <p style={{ color: "#666" }}>No assigned work today.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: 8 }}>Technician</th>
              <th style={{ padding: 8 }}>Jobs</th>
              <th style={{ padding: 8 }}>Scheduled Hours</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.technicianId ?? "unassigned"} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: 8 }}>{r.technicianName ?? "Unassigned"}</td>
                <td style={{ padding: 8 }}>{r.jobCount}</td>
                <td style={{ padding: 8 }}>{r.scheduledHours}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
