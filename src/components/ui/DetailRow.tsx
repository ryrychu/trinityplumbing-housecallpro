/**
 * One labelled fact on a detail screen.
 *
 * A definition list rather than a pair of divs, because that is what this is —
 * and a screen reader then announces "Technician, Dylan" instead of two
 * unrelated strings that happen to sit on the same line.
 */
export function DetailRow({
  k,
  v,
  last = false,
}: {
  k: string;
  v: React.ReactNode;
  /** Suppresses the divider on the final row of a panel. */
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 px-3.5 py-2.5 ${
        last ? "" : "border-b border-surface-divider"
      }`}
    >
      <dt className="shrink-0 text-xs text-ink-faint">{k}</dt>
      <dd className="min-w-0 text-right text-sm font-medium text-ink-primary">{v}</dd>
    </div>
  );
}
