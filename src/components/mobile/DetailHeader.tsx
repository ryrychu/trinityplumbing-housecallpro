import { BackLink } from "./BackLink";

/**
 * The top of a detail screen: back, whose record this is, and what it can
 * vouch for.
 *
 * Deliberately NOT a wrapper around ScreenHeader. A tab screen's title is a UI
 * label — "TODAY", "SCHEDULE" — and wears the condensed display face in caps.
 * A detail screen's title is a person's name out of the database, which is
 * content, and uppercasing content mangles it: "McDonald" is not "MCDONALD".
 * So the display face stays on labels and names are set in the body face.
 */
export function DetailHeader({
  title,
  subtitle,
  backTo,
  trailing,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Where back goes when this screen was opened cold. */
  backTo: string;
  trailing?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-4 flex items-start gap-1.5">
      <BackLink fallback={backTo} />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-bold tracking-tight text-ink-primary">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
        {children}
      </div>
      {trailing && <div className="shrink-0 pt-1">{trailing}</div>}
    </header>
  );
}
