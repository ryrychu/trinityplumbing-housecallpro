import Link from "next/link";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { StatusPill } from "./StatusPill";

const BUSINESS_TIME_ZONE = "America/New_York";

// Must stay in step with classifyZone()'s out-of-radius bucket in
// src/lib/geo/zones.ts — it is the one zone name that carries a warning.
const OUT_OF_AREA = "Outside Service Area";

function clock(iso: string | null): string {
  if (!iso) return "Unscheduled";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
  });
}

/**
 * One line of the run sheet.
 *
 * The row is split by a hairline into a rail and a body, and the split carries
 * meaning rather than decorating: left of the rule is where and when the truck
 * has to be, right of it is who and what. That is the order a dispatcher reads
 * in, and it is why the distance sits under the time instead of trailing the
 * customer's name in a run-on line of dot separators.
 */
export function JobRow({
  job,
  href,
}: {
  job: TodayScheduleRow;
  /** Pass null for a static row — the desktop dashboard has no job detail page. */
  href?: string | null;
}) {
  const target = href === undefined ? `/app/jobs/${job.id}` : href;
  const outOfArea = job.zone === OUT_OF_AREA;

  const body = (
    <>
      <div className="w-[4.5rem] shrink-0 pr-2.5 text-right">
        <div className="font-mono text-xs font-semibold text-ink-primary tnum">
          {clock(job.scheduledStart)}
        </div>
        {job.miles != null && (
          // Out of area is flagged on the distance, not on the zone name in the
          // body: the body line truncates on a narrow phone and the zone sits
          // at the end of it, so the one warning on the row was the first thing
          // to disappear. The mileage is what makes it out of area anyway.
          <div
            className={`mt-0.5 font-mono text-[10px] tnum ${
              outOfArea ? "font-semibold text-danger" : "text-ink-faint"
            }`}
          >
            {job.miles} mi{job.compass && ` ${job.compass}`}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 border-l border-surface-divider pl-3">
        <div className="flex items-start justify-between gap-2">
          {/* min-w-0 is load-bearing: a flex child's min-width defaults to its
              content, so `truncate` alone cannot shrink a long customer name.
              Without it the row grows past the viewport and pushes the status
              pill off the right edge of the phone. */}
          <span className="min-w-0 truncate text-sm font-semibold text-ink-primary">
            {job.customerName ?? "Unknown customer"}
          </span>
          <StatusPill status={job.status} />
        </div>
        {job.address && <p className="mt-0.5 truncate text-xs text-ink-muted">{job.address}</p>}
        <p className="mt-0.5 truncate text-xs text-ink-faint">
          {[job.service, job.technicianName].filter(Boolean).join(" · ")}
          {(job.service || job.technicianName) && job.zone && " · "}
          {/* Zones are identities and read as plain text like everything else
              on this line. Out of area is the one that is a state, not a name:
              it means the truck is going past the radius Trinity routinely
              drives, and it is worth a dispatcher's eye catching on it. */}
          {job.zone && (
            <span className={outOfArea ? "font-semibold text-danger" : undefined}>{job.zone}</span>
          )}
        </p>
      </div>
    </>
  );

  const shell = "flex min-h-[44px] items-start px-3.5 py-2.5";

  return target ? (
    <Link href={target} className={`${shell} transition-colors hover:bg-surface-raised`}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}
