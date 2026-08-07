/**
 * An indeterminate progress ring, in currentColor so it takes the colour of
 * whatever it sits in.
 *
 * Decorative to assistive tech on purpose: it never appears alone. Whatever
 * shows it also changes its own text — "Signing in…" — and that label is what
 * gets announced. A second announcement of the same fact is noise.
 *
 * `spinner-ring` is not just `animate-spin`. globals.css collapses every
 * animation to 0.01ms under prefers-reduced-motion, which is right for the
 * dial's entrance and wrong here: a progress ring that does not turn is a
 * frozen UI, not a calm one. The class is what the reduced-motion block uses
 * to hand this one a slower spin back rather than none.
 */
export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" className={`spinner-ring ${className}`}>
      {/* The track, then the arc that reads as motion against it. */}
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth={2.5} opacity={0.25} />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
      />
    </svg>
  );
}
