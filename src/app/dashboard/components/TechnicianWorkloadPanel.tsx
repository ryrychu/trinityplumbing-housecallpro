import type { DashboardSnapshot } from "@/lib/dashboard/queries";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";

export function TechnicianWorkloadPanel({ rows }: { rows: DashboardSnapshot["technicianWorkload"] }) {
  // Scale each load bar against the busiest tech; guard against divide-by-zero
  // when nobody has scheduled hours yet.
  const maxHours = Math.max(1, ...rows.map((r) => r.scheduledHours));

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-surface-divider px-4 py-3">
        <h3 className="text-sm font-semibold text-ink-primary">Technician Workload · Today</h3>
      </div>

      {rows.length === 0 ? (
        <EmptyState>No assigned work today.</EmptyState>
      ) : (
        <ul className="divide-y divide-surface-divider">
          {rows.map((r) => {
            const isUnassigned = r.technicianId === null;
            const pct = Math.round((r.scheduledHours / maxHours) * 100);
            return (
              <li key={r.technicianId ?? "unassigned"} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className={isUnassigned ? "italic text-ink-faint" : "font-medium text-ink-primary"}>
                    {r.technicianName ?? "Unassigned"}
                  </span>
                  <span className="whitespace-nowrap font-mono tabular-nums text-ink-muted">
                    {r.jobCount} jobs · {r.scheduledHours}h
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full rounded-full bg-surface-elevated">
                  <div
                    className={`h-1.5 rounded-full ${isUnassigned ? "bg-ink-faint" : "bg-brand"}`}
                    style={{ width: `${pct}%` }}
                    aria-hidden="true"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
