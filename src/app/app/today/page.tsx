"use client";

import Link from "next/link";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { ScreenHeader } from "@/components/mobile/ScreenHeader";
import { DispatchDial } from "@/components/chart/DispatchDial";
import { RunSheet } from "@/components/schedule/RunSheet";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Panel } from "@/components/ui/Panel";
import { Figure } from "@/components/ui/Figure";
import { IconButton } from "@/components/ui/IconButton";
import { ChevronRightIcon } from "@/components/ui/icons";
import { Skeleton, LoadingStatus } from "@/components/ui/Skeleton";
import { RunSheetSkeleton } from "@/components/schedule/RunSheetSkeleton";

interface TodayPayload {
  dateLabel: string;
  jobsInProgress: number;
  emergencyCalls: number;
  pendingInvoices: number;
  jobs: TodayScheduleRow[];
}

/**
 * The screen's own shape, not a generic spinner. Same panels, same heights, so
 * nothing moves when the data lands.
 */
function TodaySkeleton() {
  return (
    <>
      <LoadingStatus />
      <section className="mb-5">
        <SectionHeader>The day</SectionHeader>
        <Panel className="flex justify-center px-3 py-4">
          {/* A ring, not a disc. The dial it stands in for is mostly empty
              space and hairlines, so a filled circle is far heavier than the
              thing arriving — the placeholder would be the loudest object on
              the screen and then vanish. */}
          <div
            aria-hidden
            className="aspect-square w-full max-w-[340px] animate-pulse rounded-full border-[14px] border-surface-elevated"
          />
        </Panel>
      </section>
      <section className="mb-5">
        <Panel>
          <div className="grid grid-cols-3 divide-x divide-surface-divider">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2 px-3 py-3">
                <Skeleton className="h-6 w-8" />
                <Skeleton className="h-2.5 w-16" />
              </div>
            ))}
          </div>
        </Panel>
      </section>
      <section>
        <SectionHeader>Run sheet</SectionHeader>
        <RunSheetSkeleton />
      </section>
    </>
  );
}

export default function TodayPage() {
  const {
    data,
    generatedAt,
    mirrorSyncedAt,
    staleAfterMinutes,
    loading,
    revalidating,
    error,
    fromCache,
    refresh,
  } = useAppData<TodayPayload>("/api/app/today");

  const jobs = data?.jobs ?? [];

  return (
    <main className="px-3 pb-4 pt-3">
      <ScreenHeader
        title="Today"
        subtitle={data?.dateLabel}
        trailing={<IconButton label="Refresh" glyph="↻" onClick={refresh} />}
      >
        <FreshnessStamp
          generatedAt={generatedAt}
          fromCache={fromCache}
          mirrorSyncedAt={mirrorSyncedAt}
          staleAfterMinutes={staleAfterMinutes}
        />
      </ScreenHeader>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {loading && <TodaySkeleton />}

      {/* Held at reduced opacity while a refresh is in flight rather than
          replaced by the skeleton again: throwing away readable content to
          show its outline is a step backwards, and the swap makes the page
          jump. */}
      {data && (
        <div className={revalidating ? "opacity-60 transition-opacity" : "transition-opacity"}>
          {/* The shape of the day comes first. A dispatcher's first question is
              not "how many" but "where" — whether the trucks are working one
              town or crossing the county twice. */}
          {jobs.length > 0 && (
            <section className="mb-5">
              {/* No count here: the dial's own caption reports how many jobs it
                  could place, and two counts a screen apart that disagree by
                  the unplaceable ones just make the reader stop and check. */}
              <SectionHeader>The day</SectionHeader>
              <Panel className="px-3 py-4">
                <DispatchDial jobs={jobs} />
              </Panel>
            </section>
          )}

          <section className="mb-5">
            <Panel>
              <div className="grid grid-cols-3 divide-x divide-surface-divider">
                <div className="px-3 py-3">
                  <Figure value={data.jobsInProgress} label="Running" size="compact" />
                </div>
                <div className="px-3 py-3">
                  {/* Counts jobs tagged `emergency` in Housecall Pro since the
                      convention began (docs/PHASE-1.x-BACKLOG.md); ~3,000 older
                      jobs are unclassified and always will be. The label has to
                      read as today's count, never as "all emergencies ever". */}
                  <Figure
                    value={data.emergencyCalls}
                    label="Emergency"
                    size="compact"
                    tone={data.emergencyCalls > 0 ? "danger" : "default"}
                  />
                </div>
                {/* The only one of the three with somewhere to go. Running and
                    Emergency are both answered by the run sheet directly below,
                    with their status pills on the rows; the unpaid invoices are
                    on another tab and are the ones you act on. Making all three
                    tappable for symmetry would promise two destinations that
                    do not exist. */}
                <Link
                  href="/app/money"
                  className="flex items-center justify-between gap-1 px-3 py-3 transition-colors hover:bg-surface-raised"
                >
                  <Figure
                    value={data.pendingInvoices}
                    label="Unpaid"
                    size="compact"
                    tone={data.pendingInvoices > 0 ? "warn" : "default"}
                  />
                  <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 self-start text-ink-faint" />
                </Link>
              </div>
            </Panel>
          </section>

          <section>
            {/* No "0 jobs" in the rule when the panel underneath already says
                "No jobs scheduled today" — one statement of a fact is enough. */}
            <SectionHeader
              meta={jobs.length > 0 ? `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}` : undefined}
            >
              Run sheet
            </SectionHeader>
            <RunSheet jobs={jobs} />
          </section>
        </div>
      )}
    </main>
  );
}
