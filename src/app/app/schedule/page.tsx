"use client";

import { useState } from "react";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { EmptyState } from "@/components/mobile/EmptyState";
import { JobRow } from "@/components/mobile/JobRow";

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

  const { data, generatedAt, loading, error, fromCache } = useAppData<SchedulePayload>(
    `/api/app/schedule?offset=${offset}`
  );

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

  return (
    <main className="px-3 pt-3">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Schedule</h1>
          <p className="text-xs text-ink-faint">{data?.weekLabel ?? " "}</p>
          <FreshnessStamp generatedAt={generatedAt} fromCache={fromCache} />
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => { setOffset((o) => o - 1); setDayIndex(null); }}
            aria-label="Previous week"
            className="min-h-[44px] min-w-[44px] rounded-xl border border-surface-border text-ink-muted"
          >‹</button>
          <button
            onClick={() => { setOffset((o) => o + 1); setDayIndex(null); }}
            aria-label="Next week"
            className="min-h-[44px] min-w-[44px] rounded-xl border border-surface-border text-ink-muted"
          >›</button>
        </div>
      </header>

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
      {data && (
        <>
          <div className="mb-3 flex gap-1">
            {days.map((d, i) => (
              <button
                key={d.dateKey}
                onClick={() => setDayIndex(dayIndex === i ? null : i)}
                className={`min-h-[44px] flex-1 rounded-lg border px-0.5 py-1 ${
                  dayIndex === i
                    ? "border-brand bg-brand-tint"
                    : "border-surface-divider bg-surface-card"
                }`}
              >
                <div className="text-[9px] uppercase text-ink-faint">{d.label}</div>
                <div className="text-xs font-bold">{d.dateKey.slice(-2)}</div>
                <div className="text-[9px] text-brand">{d.rows.length || "—"}</div>
              </button>
            ))}
          </div>

          {data.technicians.length > 0 && (
            <select
              value={tech}
              onChange={(e) => setTech(e.target.value)}
              className="mb-3 min-h-[44px] w-full rounded-lg border border-surface-divider bg-surface-card px-3 text-base text-ink-primary"
            >
              <option value="all">All technicians</option>
              {data.technicians.map((t) => (
                <option key={t.id} value={t.name}>{t.name}</option>
              ))}
            </select>
          )}

          {visible.length === 0 ? (
            <EmptyState>
              {selected ? "No jobs scheduled this day." : "No jobs scheduled this week."}
            </EmptyState>
          ) : (
            visible.map((job) => <JobRow key={job.id} job={job} />)
          )}
        </>
      )}

      {loading && !data && <p className="text-sm text-ink-faint">Loading…</p>}
    </main>
  );
}
