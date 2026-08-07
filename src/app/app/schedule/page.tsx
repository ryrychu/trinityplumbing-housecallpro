"use client";

import { useState } from "react";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { ScreenHeader } from "@/components/mobile/ScreenHeader";
import { RunSheet } from "@/components/schedule/RunSheet";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { IconButton } from "@/components/ui/IconButton";
import { Skeleton, LoadingStatus } from "@/components/ui/Skeleton";
import { RunSheetSkeleton } from "@/components/schedule/RunSheetSkeleton";

interface ScheduleDay { dateKey: string; label: string; rows: TodayScheduleRow[] }
interface SchedulePayload {
  weekLabel: string;
  offset: number;
  days: ScheduleDay[];
  technicians: { id: string; name: string }[];
}

export default function SchedulePage() {
  const [offset, setOffset] = useState(0);
  const [dayIndex, setDayIndex] = useState<number | null>(null);
  const [tech, setTech] = useState<string>("all");

  const { data, generatedAt, mirrorSyncedAt, staleAfterMinutes, loading, revalidating, error, fromCache } =
    useAppData<SchedulePayload>(`/api/app/schedule?offset=${offset}`);

  const days = data?.days ?? [];
  const selected = dayIndex == null ? null : days[dayIndex];
  // Filtering by name, not id: TodayScheduleRow carries no technician id (see
  // the comment on listTechnicians in ../../api/app/schedule/route.ts), so
  // this is the best this screen can discriminate on today. The route already
  // collapses same-named technicians in the dropdown so a selection here never
  // silently under-matches against the rows.
  const visible = (selected?.rows ?? days.flatMap((d) => d.rows)).filter(
    (r) => tech === "all" || r.technicianName === tech
  );

  // The busiest day sets the height of the load bars, so a week's shape reads
  // off the strip before you tap anything.
  const busiest = Math.max(1, ...days.map((d) => d.rows.length));

  return (
    <main className="px-3 pb-4 pt-3">
      <ScreenHeader
        title="Schedule"
        subtitle={data?.weekLabel}
        trailing={
          <>
            <IconButton
              label="Previous week"
              glyph="‹"
              onClick={() => { setOffset((o) => o - 1); setDayIndex(null); }}
            />
            <IconButton
              label="Next week"
              glyph="›"
              onClick={() => { setOffset((o) => o + 1); setDayIndex(null); }}
            />
          </>
        }
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

      {/* Everything below is gated on `data`, matching Today and Money. Before
          the first response lands `days` is [] and `visible` is [] -- rendering
          them ungated told the user "No jobs scheduled this week." before
          anything had loaded, and on a 502 showed the red error banner AND that
          empty state at the same time, one of which was necessarily false. An
          empty week and an unanswered request must never look alike. */}
      {loading && (
        <>
          <LoadingStatus />
          {/* The seven day buttons keep their real height so the run sheet
              below them does not jump when the week lands. */}
          <div className="mb-4 flex gap-1">
            {Array.from({ length: 7 }, (_, i) => (
              <Skeleton key={i} className="h-[60px] flex-1 rounded-lg" />
            ))}
          </div>
          <Skeleton className="mb-4 h-11 w-full rounded-xl" />
          <SectionHeader>This week</SectionHeader>
          <RunSheetSkeleton rows={5} />
        </>
      )}

      {data && (
        <div className={revalidating ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <div className="mb-4 flex gap-1">
            {days.map((d, i) => {
              const on = dayIndex === i;
              return (
                <button
                  key={d.dateKey}
                  type="button"
                  onClick={() => setDayIndex(on ? null : i)}
                  aria-pressed={on}
                  className={`flex min-h-[60px] flex-1 flex-col items-center justify-between rounded-lg border px-0.5 py-1.5 transition-colors ${
                    on ? "border-brand bg-brand-tint" : "border-surface-divider bg-surface-card"
                  }`}
                >
                  <span
                    className={`font-display text-[11px] font-semibold uppercase leading-none tracking-wide ${
                      on ? "text-brand" : "text-ink-faint"
                    }`}
                  >
                    {d.label}
                  </span>
                  <span className="font-mono text-sm font-bold leading-none text-ink-primary tnum">
                    {d.dateKey.slice(-2)}
                  </span>
                  {/* A count in a 9px type is unreadable at arm's length; the
                      same number as a bar is legible without being read. */}
                  <span
                    aria-hidden
                    className="flex h-3 w-full items-end justify-center px-1"
                    title={`${d.rows.length} jobs`}
                  >
                    <span
                      className={`w-full rounded-sm ${
                        d.rows.length === 0 ? "bg-surface-elevated" : on ? "bg-brand" : "bg-ink-faint"
                      }`}
                      style={{
                        height: d.rows.length === 0 ? 2 : `${Math.max(3, (d.rows.length / busiest) * 12)}px`,
                      }}
                    />
                  </span>
                  <span className="sr-only">
                    {d.rows.length} {d.rows.length === 1 ? "job" : "jobs"}
                  </span>
                </button>
              );
            })}
          </div>

          {data.technicians.length > 0 && (
            <select
              value={tech}
              onChange={(e) => setTech(e.target.value)}
              aria-label="Filter by technician"
              className="mb-4 min-h-[44px] w-full rounded-xl border border-surface-border bg-surface-card px-3 text-base text-ink-primary"
            >
              <option value="all">All technicians</option>
              {data.technicians.map((t) => (
                <option key={t.id} value={t.name}>{t.name}</option>
              ))}
            </select>
          )}

          <SectionHeader meta={`${visible.length} ${visible.length === 1 ? "job" : "jobs"}`}>
            {selected ? selected.label : "This week"}
          </SectionHeader>
          <RunSheet
            jobs={visible}
            empty={selected ? "No jobs scheduled this day." : "No jobs scheduled this week."}
          />
        </div>
      )}
    </main>
  );
}
