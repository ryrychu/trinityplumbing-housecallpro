"use client";

import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { EmptyState } from "@/components/mobile/EmptyState";
import { JobRow } from "@/components/mobile/JobRow";

interface TodayPayload {
  dateLabel: string;
  jobsInProgress: number;
  emergencyCalls: number;
  pendingInvoices: number;
  jobs: TodayScheduleRow[];
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="flex-1 rounded-xl border border-surface-divider bg-surface-card px-2 py-2 text-center">
      <div className={`font-mono text-lg font-bold ${tone ?? "text-ink-primary"}`}>{n}</div>
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}

export default function TodayPage() {
  const { data, generatedAt, mirrorSyncedAt, staleAfterMinutes, loading, error, fromCache, refresh } =
    useAppData<TodayPayload>("/api/app/today");

  return (
    <main className="px-3 pt-3">
      <header className="mb-3 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Today</h1>
          <p className="text-xs text-ink-faint">{data?.dateLabel ?? " "}</p>
          <FreshnessStamp
            generatedAt={generatedAt}
            fromCache={fromCache}
            mirrorSyncedAt={mirrorSyncedAt}
            staleAfterMinutes={staleAfterMinutes}
          />
        </div>
        <button
          onClick={refresh}
          aria-label="Refresh"
          className="min-h-[44px] min-w-[44px] rounded-xl border border-surface-border text-ink-muted"
        >
          ↻
        </button>
      </header>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {data && (
        <>
          <div className="mb-4 flex gap-2">
            <Stat n={data.jobsInProgress} label="In prog" />
            {/* "Emerg" counts only jobs tagged since Trinity's tagging convention
                began (docs/PHASE-1.x-BACKLOG.md) -- ~3,000 older jobs are
                unclassified and always will be. The label must read as a count,
                never as "all emergencies ever". */}
            <Stat
              n={data.emergencyCalls}
              label="Emerg"
              tone={data.emergencyCalls > 0 ? "text-danger" : undefined}
            />
            <Stat
              n={data.pendingInvoices}
              label="Unpaid"
              tone={data.pendingInvoices > 0 ? "text-warn" : undefined}
            />
          </div>

          <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Schedule
          </h2>
          {data.jobs.length === 0 ? (
            <EmptyState>No jobs scheduled today.</EmptyState>
          ) : (
            data.jobs.map((job) => <JobRow key={job.id} job={job} />)
          )}
        </>
      )}

      {loading && !data && <p className="text-sm text-ink-faint">Loading…</p>}
    </main>
  );
}
