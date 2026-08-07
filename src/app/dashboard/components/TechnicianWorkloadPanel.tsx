import type { DashboardSnapshot } from "@/lib/dashboard/queries";
import { Panel } from "@/components/ui/Panel";
import { MeterRow } from "@/components/ui/MeterRow";

export function TechnicianWorkloadPanel({ rows }: { rows: DashboardSnapshot["technicianWorkload"] }) {
  // Scale each load bar against the busiest tech; guard against divide-by-zero
  // when nobody has scheduled hours yet.
  const maxHours = Math.max(1, ...rows.map((r) => r.scheduledHours));

  if (rows.length === 0) {
    return (
      <Panel className="px-4 py-8 text-center text-sm text-ink-faint">
        No assigned work today.
      </Panel>
    );
  }

  return (
    <Panel className="overflow-hidden">
      <ul className="divide-y divide-surface-divider">
        {rows.map((r) => (
          <MeterRow
            key={r.technicianId ?? "unassigned"}
            name={r.technicianName ?? "Unassigned"}
            value={`${r.jobCount} ${r.jobCount === 1 ? "job" : "jobs"} · ${r.scheduledHours}h`}
            fraction={r.scheduledHours / maxHours}
            muted={r.technicianId === null}
          />
        ))}
      </ul>
    </Panel>
  );
}
