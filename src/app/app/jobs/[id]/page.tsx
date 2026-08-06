"use client";

import Link from "next/link";
import type { JobDetail } from "@/lib/mobile/jobDetail";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { StatusPill } from "@/components/mobile/StatusPill";

const BUSINESS_TIME_ZONE = "America/New_York";

const money = (cents: number | null) =>
  cents == null
    ? "—"
    : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function timeRange(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "Unscheduled";
  const opts = { hour: "numeric", minute: "2-digit", timeZone: BUSINESS_TIME_ZONE } as const;
  const start = new Date(startIso).toLocaleTimeString("en-US", opts);
  if (!endIso) return start;
  return `${start} – ${new Date(endIso).toLocaleTimeString("en-US", opts)}`;
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between border-b border-surface-divider py-2 text-sm">
      <span className="text-ink-faint">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  );
}

export default function JobPage({ params }: { params: { id: string } }) {
  // generatedAt/fromCache are destructured, not dropped: this is one of the two
  // screens someone ACTS on -- they call this number and drive to this address.
  // Offline, the service worker serves a cached copy and useAppData sets
  // fromCache; without the stamp below the page renders as if it were current,
  // which is the exact dishonesty the freshness contract exists to prevent.
  const { data: job, generatedAt, error, fromCache } = useAppData<JobDetail>(
    `/api/app/jobs/${params.id}`
  );

  if (error) {
    return (
      <main className="px-3 pt-3">
        <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      </main>
    );
  }
  if (!job) return <main className="px-3 pt-3 text-sm text-ink-faint">Loading…</main>;

  return (
    <main className="px-3 pt-3">
      <header className="mb-3 flex items-center gap-2">
        <Link href="/app/today" aria-label="Back" className="min-h-[44px] px-1 text-xl text-brand">
          ‹
        </Link>
        <div className="flex-1">
          <h1 className="text-lg font-bold tracking-tight">
            {job.customerName ?? "Unknown customer"}
          </h1>
          <p className="text-xs text-ink-faint">{timeRange(job.scheduledStart, job.scheduledEnd)}</p>
          <FreshnessStamp generatedAt={generatedAt} fromCache={fromCache} />
        </div>
        <StatusPill status={job.status} />
      </header>

      {/* tel: and maps: are plain links — no API call, and they work offline. */}
      <div className="mb-4 flex gap-2">
        <a
          href={job.customerPhone ? `tel:${job.customerPhone}` : undefined}
          aria-disabled={!job.customerPhone}
          className={`min-h-[44px] flex-1 rounded-xl py-3 text-center text-sm font-bold ${
            job.customerPhone ? "bg-brand text-ink-inverse" : "bg-surface-elevated text-ink-faint"
          }`}
        >
          📞 Call
        </a>
        <a
          href={job.address ? `maps:?q=${encodeURIComponent(job.address)}` : undefined}
          aria-disabled={!job.address}
          className="min-h-[44px] flex-1 rounded-xl border border-surface-border py-3 text-center text-sm font-bold"
        >
          🧭 Directions
        </a>
      </div>

      <Row k="Address" v={job.address ?? "—"} />
      <Row k="Technician" v={job.technicianName ?? "Unassigned"} />
      <Row k="Service" v={job.service ?? "—"} />
      {/* Booked, not paid — the mirror has no line items. Labelled so nobody
          reads it as revenue collected. */}
      <Row k="Booked amount" v={<span className="text-success">{money(job.amountCents)}</span>} />
      <Row
        k="Invoice"
        v={
          job.invoice ? (
            <span className={job.invoice.status === "paid" ? "text-success" : "text-warn"}>
              {money(job.invoice.amountCents)} · {job.invoice.status}
            </span>
          ) : (
            "—"
          )
        }
      />

      <h2 className="mb-2 mt-5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        Notes
      </h2>
      {job.notes.length === 0 ? (
        <p className="text-sm text-ink-faint">No notes on this job.</p>
      ) : (
        job.notes.map((n, i) => (
          <div key={i} className="mb-2 rounded-xl border border-surface-divider bg-surface-card p-3">
            <p className="text-sm text-ink-muted">{n.content}</p>
            {(n.author || n.createdAt) && (
              <p className="mt-1 text-[10px] text-ink-faint">
                {[n.author, n.createdAt?.slice(0, 10)].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        ))
      )}
    </main>
  );
}
