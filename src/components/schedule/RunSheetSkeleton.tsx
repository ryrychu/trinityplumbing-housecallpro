import { Panel } from "@/components/ui/Panel";
import { Skeleton } from "@/components/ui/Skeleton";

/**
 * The run sheet's shape before its data lands: the same time-and-distance rail,
 * the same hairline, the same three lines of body.
 *
 * It matches the real row's geometry deliberately. A skeleton of a different
 * height is worse than none — the content lands and everything below it jumps.
 */
export function RunSheetSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Panel className="overflow-hidden">
      <ul className="divide-y divide-surface-divider">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="flex min-h-[44px] items-start px-3.5 py-2.5">
            <div className="w-[4.5rem] shrink-0 space-y-1.5 pr-2.5">
              <Skeleton className="ml-auto h-3 w-14" />
              <Skeleton className="ml-auto h-2.5 w-10" />
            </div>
            <div className="min-w-0 flex-1 space-y-1.5 border-l border-surface-divider pl-3">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
