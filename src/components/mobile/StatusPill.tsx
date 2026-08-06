// Labels come from scheduleStatus() in src/lib/dashboard/queries.ts. "En Route"
// is derived from raw.work_timestamps.on_my_way_at — HCP's work_status enum has
// no en-route value.
const TONES: Record<string, string> = {
  Scheduled: "bg-info-tint text-info",
  "En Route": "bg-brand-tint text-brand",
  "In Progress": "bg-brand-tint text-brand",
  Completed: "bg-success-tint text-success",
  Canceled: "bg-danger-tint text-danger",
  "Needs Scheduling": "bg-warn-tint text-warn",
};

export function StatusPill({ status }: { status: string | null }) {
  if (!status) return null;
  const tone = TONES[status] ?? "bg-surface-elevated text-ink-muted";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${tone}`}>
      {status}
    </span>
  );
}
