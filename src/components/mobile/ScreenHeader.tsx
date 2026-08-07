/**
 * The top of every screen in the installable app: the screen's name in the
 * condensed display face, an optional date or context line under it, whatever
 * freshness the screen can vouch for, and the screen's controls on the right.
 *
 * One component rather than five hand-set headers, because the previous five
 * had already drifted — different margins, different title sizes, and Money
 * had lost its subtitle line entirely.
 */
export function ScreenHeader({
  title,
  subtitle,
  trailing,
  children,
}: {
  title: string;
  subtitle?: string;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-3xl font-bold uppercase leading-none tracking-wide text-ink-primary">
          {title}
        </h1>
        {/* Reserved whether or not it is filled, so the controls beside it do
            not jump a line when a screen's context arrives with the data. */}
        <p className="mt-1.5 min-h-[1rem] text-xs text-ink-muted">{subtitle ?? " "}</p>
        {children}
      </div>
      {trailing && <div className="flex shrink-0 gap-1.5">{trailing}</div>}
    </header>
  );
}
