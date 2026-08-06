import Link from "next/link";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { StatusPill } from "./StatusPill";

const BUSINESS_TIME_ZONE = "America/New_York";

function clock(iso: string | null): string {
  if (!iso) return "Unscheduled";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
  });
}

export function JobRow({ job }: { job: TodayScheduleRow }) {
  return (
    <Link
      href={`/app/jobs/${job.id}`}
      className="mb-2 flex min-h-[44px] flex-col rounded-xl border border-surface-divider bg-surface-card px-3 py-2.5"
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs font-bold text-brand">{clock(job.scheduledStart)}</span>
        <span className="flex-1 truncate text-sm font-semibold">
          {job.customerName ?? "Unknown customer"}
        </span>
        <StatusPill status={job.status} />
      </div>
      {job.address && <p className="mt-1 text-xs text-ink-muted">{job.address}</p>}
      {(job.service || job.technicianName) && (
        <p className="mt-0.5 text-xs text-ink-faint">
          {[job.service, job.technicianName].filter(Boolean).join(" · ")}
        </p>
      )}
    </Link>
  );
}
