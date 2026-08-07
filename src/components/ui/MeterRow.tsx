/**
 * One person's share of the day, as a name, a figure and a track.
 *
 * The track is a meter against the busiest person's load, not a chart series —
 * so it takes one hue, never a per-person colour. Unassigned work is the one
 * exception and reads in the muted ink, because "nobody owns this" is a
 * different kind of row from "Dylan owns this".
 */
export function MeterRow({
  name,
  value,
  fraction,
  muted = false,
}: {
  name: string;
  value: string;
  /** 0..1 of the busiest row. */
  fraction: number;
  muted?: boolean;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <li className="px-3.5 py-2.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        {/* Technician names come from Housecall Pro and are not length-capped,
            so this truncates rather than shoving the job count off the row. */}
        <span
          className={`min-w-0 truncate ${
            muted ? "italic text-ink-faint" : "font-medium text-ink-primary"
          }`}
        >
          {name}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono text-xs text-ink-muted tnum">
          {value}
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-elevated">
        <div
          className={`h-full rounded-full ${muted ? "bg-ink-faint" : "bg-brand"}`}
          style={{ width: `${pct}%` }}
          aria-hidden="true"
        />
      </div>
    </li>
  );
}
