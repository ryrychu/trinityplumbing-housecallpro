"use client";

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

interface TodayPayload {
  dateLabel: string;
  jobsInProgress: number;
  emergencyCalls: number;
  pendingInvoices: number;
  jobs: TodayScheduleRow[];
}

export default function TodayPage() {
  const { data, generatedAt, mirrorSyncedAt, staleAfterMinutes, loading, error, fromCache, refresh } =
    useAppData<TodayPayload>("/api/app/today");

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

      {data && (
        <>
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
                <div className="px-3 py-3">
                  <Figure
                    value={data.pendingInvoices}
                    label="Unpaid"
                    size="compact"
                    tone={data.pendingInvoices > 0 ? "warn" : "default"}
                  />
                </div>
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
        </>
      )}

      {loading && !data && <p className="text-sm text-ink-faint">Loading…</p>}
    </main>
  );
}
