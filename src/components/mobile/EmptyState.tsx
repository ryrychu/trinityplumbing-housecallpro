// Shared "nothing here" card for every mobile screen (empty schedule, no
// results, etc.) so the empty look is consistent without each screen
// re-picking padding and colors.
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-surface-divider bg-surface-card px-4 py-8 text-center text-sm text-ink-faint">
      {children}
    </p>
  );
}
