/**
 * A placeholder block, shaped like the thing it stands in for.
 *
 * Shown only when there is genuinely nothing to show. A skeleton on top of
 * content that is merely being revalidated is worse than the stale content:
 * it throws away something readable and replaces it with a shape.
 *
 * Its shimmer is plain `animate-pulse`, which globals.css collapses under
 * prefers-reduced-motion. That is the right outcome here — unlike the spinner,
 * a still skeleton still reads as "not loaded yet" because of what it is, not
 * because it moves.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-surface-elevated ${className}`} />;
}

/**
 * Says a screen is loading, to assistive tech only.
 *
 * The skeleton blocks are all aria-hidden — they are shapes, and a screen
 * reader announcing a dozen empty boxes is worse than silence. This is the one
 * part that speaks, and it replaces the visible "Loading…" the screens used to
 * carry. Dropping the shapes in without it would have quietly removed the only
 * thing a non-sighted reader had.
 */
export function LoadingStatus({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="sr-only">
      {label}
    </p>
  );
}

/**
 * A block of placeholder lines. The last one is short, because a paragraph's
 * final line is, and a stack of equal bars reads as a table instead.
 */
export function SkeletonLines({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 ? "w-1/2" : "w-full"}`} />
      ))}
    </div>
  );
}
