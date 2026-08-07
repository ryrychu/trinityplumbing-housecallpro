import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { JobRow } from "@/components/mobile/JobRow";
import { Panel } from "@/components/ui/Panel";

/**
 * The day, in order, as one list — and the same list on a phone and on a
 * desktop. The old desktop dashboard rendered a seven-column table and then a
 * second, separately-written stack of cards for narrow screens, which is two
 * implementations of one thing and exactly how the two views drift apart. This
 * is the mobile design, and wide screens get more of it rather than a
 * different one.
 *
 * It is also the dial's table view: every value the dial encodes as a position
 * is written out here in text, so nothing is reachable by hover alone.
 */
export function RunSheet({
  jobs,
  linkJobs = true,
  empty = "No jobs scheduled today.",
}: {
  jobs: TodayScheduleRow[];
  /** Only the installable app has a job detail screen to link into. */
  linkJobs?: boolean;
  empty?: string;
}) {
  if (jobs.length === 0) {
    return (
      <Panel className="px-4 py-8 text-center text-sm text-ink-faint">{empty}</Panel>
    );
  }

  return (
    <Panel className="overflow-hidden">
      <ol className="divide-y divide-surface-divider">
        {jobs.map((job) => (
          <li key={job.id}>
            <JobRow job={job} href={linkJobs ? undefined : null} />
          </li>
        ))}
      </ol>
    </Panel>
  );
}
