import type { DashboardSnapshot } from "@/lib/dashboard/queries";
import { Card } from "./Card";
import { ZoneBadge } from "./ZoneBadge";
import { EmptyState } from "./EmptyState";

// Times are rendered in the business timezone, not the server's. Vercel runs in
// UTC, so without this a 10:00 Eastern job displays as 14:00. Matches the
// Eastern-scoped revenue windows in the data layer.
const BUSINESS_TIME_ZONE = "America/New_York";

function fmtTime(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: BUSINESS_TIME_ZONE,
      })
    : "—";
}

export function TodaySchedulePanel({ jobs }: { jobs: DashboardSnapshot["todaySchedule"] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-surface-divider px-4 py-3">
        <h3 className="text-sm font-semibold text-ink-primary">Today&apos;s Schedule</h3>
      </div>

      {jobs.length === 0 ? (
        <EmptyState>No jobs scheduled today.</EmptyState>
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-divider text-left text-xs uppercase tracking-wider text-ink-faint">
                  <th scope="col" className="px-4 py-2 font-medium">Time</th>
                  <th scope="col" className="px-4 py-2 font-medium">Customer</th>
                  <th scope="col" className="px-4 py-2 font-medium">Tech</th>
                  <th scope="col" className="px-4 py-2 font-medium">Zone</th>
                  <th scope="col" className="px-4 py-2 font-medium">Dir</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Miles</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Drive</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b border-surface-divider/60 last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 font-mono tabular-nums text-ink-primary">
                      {fmtTime(j.scheduledStart)}
                    </td>
                    <td className="px-4 py-2 text-ink-primary">{j.customerName ?? "—"}</td>
                    <td className="px-4 py-2 text-ink-muted">{j.technicianName ?? "Unassigned"}</td>
                    <td className="px-4 py-2"><ZoneBadge zone={j.zone} /></td>
                    <td className="px-4 py-2 text-ink-faint">{j.compass || "—"}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums text-ink-muted">
                      {j.miles ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right font-mono tabular-nums text-ink-muted">
                      {j.driveMinutes != null ? `${j.driveMinutes} min` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile stacked cards */}
          <ul className="divide-y divide-surface-divider md:hidden">
            {jobs.map((j) => (
              <li key={j.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm tabular-nums text-ink-primary">
                    {fmtTime(j.scheduledStart)}
                  </span>
                  <ZoneBadge zone={j.zone} />
                </div>
                <div className="mt-1 text-sm font-medium text-ink-primary">{j.customerName ?? "—"}</div>
                <div className="mt-0.5 text-xs text-ink-muted">
                  {j.technicianName ?? "Unassigned"}
                  {j.miles != null && ` · ${j.miles} mi`}
                  {j.driveMinutes != null && ` · ${j.driveMinutes} min`}
                  {j.compass && ` · ${j.compass}`}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
