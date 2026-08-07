/**
 * The app's one square tap target. 44px minimum on every side because that is
 * the smallest thing a thumb reliably hits, and every one of these is meant to
 * be hit from a truck seat.
 */
export function IconButton({
  label,
  glyph,
  onClick,
  disabled = false,
}: {
  /** Announced by screen readers; the glyph itself is decorative. */
  label: string;
  glyph: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-surface-border text-lg text-ink-muted transition-colors hover:border-brand hover:text-brand disabled:opacity-40"
    >
      <span aria-hidden>{glyph}</span>
    </button>
  );
}
