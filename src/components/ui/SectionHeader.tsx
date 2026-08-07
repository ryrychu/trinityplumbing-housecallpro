// Every band on every screen opens the same way: a gold tick, the name in the
// condensed display face, a hairline carrying across to an optional count on
// the right. It is the app's only structural device, and it does one job —
// separating a section's name from how much is in it.
export function SectionHeader({
  children,
  meta,
  className = "",
}: {
  children: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-2.5 flex items-center gap-2.5 ${className}`}>
      <span aria-hidden className="h-3.5 w-0.5 shrink-0 bg-brand" />
      <h2 className="font-display text-lg font-semibold uppercase leading-none tracking-wide text-ink-primary">
        {children}
      </h2>
      <span aria-hidden className="h-px flex-1 bg-surface-divider" />
      {meta && (
        <span className="shrink-0 font-mono text-[11px] leading-none text-ink-faint tnum">
          {meta}
        </span>
      )}
    </div>
  );
}
