"use client";

import Link from "next/link";
import type { JobDetail } from "@/lib/mobile/jobDetail";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { DetailHeader } from "@/components/mobile/DetailHeader";
import { BackLink } from "@/components/mobile/BackLink";
import { StatusPill } from "@/components/mobile/StatusPill";
import { ActionPair } from "@/components/mobile/ActionPair";
import { DetailRow } from "@/components/ui/DetailRow";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Panel } from "@/components/ui/Panel";
import { ChevronRightIcon } from "@/components/ui/icons";
import { Skeleton, LoadingStatus } from "@/components/ui/Skeleton";

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

/**
 * The screen's shape while it loads. The back control is real, not a
 * placeholder: it is the one thing that must work before the data arrives,
 * because a slow or failed job is exactly when someone wants out.
 */
function JobSkeleton() {
  return (
    <main className="px-3 pb-4 pt-3">
      <LoadingStatus />
      <header className="mb-4 flex items-start gap-1.5">
        <BackLink fallback="/app/today" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-3 w-32" />
        </div>
      </header>
      <div className="mb-5 flex gap-2">
        <Skeleton className="h-12 flex-1 rounded-xl" />
        <Skeleton className="h-12 flex-1 rounded-xl" />
      </div>
      <SectionHeader>Job</SectionHeader>
      <Panel className="overflow-hidden">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`flex items-baseline justify-between gap-4 px-3.5 py-2.5 ${
              i === 4 ? "" : "border-b border-surface-divider"
            }`}
          >
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        ))}
      </Panel>
    </main>
  );
}

export default function JobPage({ params }: { params: { id: string } }) {
  // generatedAt/fromCache are destructured, not dropped: this is one of the two
  // screens someone ACTS on -- they call this number and drive to this address.
  // Offline, the service worker serves a cached copy and useAppData sets
  // fromCache; without the stamp below the page renders as if it were current,
  // which is the exact dishonesty the freshness contract exists to prevent.
  const { data: job, generatedAt, mirrorSyncedAt, staleAfterMinutes, error, fromCache } = useAppData<JobDetail>(
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
  if (!job) return <JobSkeleton />;

  return (
    <main className="px-3 pb-4 pt-3">
      <DetailHeader
        title={job.customerName ?? "Unknown customer"}
        subtitle={timeRange(job.scheduledStart, job.scheduledEnd)}
        backTo="/app/today"
        trailing={<StatusPill status={job.status} />}
      >
        <FreshnessStamp
          generatedAt={generatedAt}
          fromCache={fromCache}
          mirrorSyncedAt={mirrorSyncedAt}
          staleAfterMinutes={staleAfterMinutes}
        />
      </DetailHeader>

      <ActionPair phone={job.customerPhone} address={job.address} />

      <section className="mb-5">
        <SectionHeader>Job</SectionHeader>
        <Panel className="overflow-hidden">
          <dl>
            <DetailRow k="Address" v={job.address ?? "—"} />
            <DetailRow k="Technician" v={job.technicianName ?? "Unassigned"} />
            <DetailRow k="Service" v={job.service ?? "—"} />
            {/* Booked, not paid — the mirror has no line items. Labelled so
                nobody reads it as revenue collected. */}
            <DetailRow
              k="Booked amount"
              v={<span className="text-success">{money(job.amountCents)}</span>}
            />
            <DetailRow
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
              last
            />
          </dl>
        </Panel>
      </section>

      {/* getJobDetail() has always returned customerId and no screen ever read
          it, so a job was a dead end: you could reach it from a customer but
          never walk back the other way to their number or their history. */}
      {job.customerId && (
        <section className="mb-5">
          <SectionHeader>Customer</SectionHeader>
          <Panel className="overflow-hidden">
            <Link
              href={`/app/customers/${job.customerId}`}
              className="flex min-h-[44px] items-center gap-3 px-3.5 py-3 transition-colors hover:bg-surface-raised"
            >
              {/* Deliberately not the customer's name again — the heading at
                  the top of this screen is already their name, and repeating
                  it here says nothing about where the row goes. */}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-ink-primary">
                  Customer record
                </div>
                <div className="mt-0.5 text-xs text-ink-faint">
                  Every job and the lifetime total
                </div>
              </div>
              <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-faint" />
            </Link>
          </Panel>
        </section>
      )}

      <section>
        <SectionHeader meta={job.notes.length > 0 ? `${job.notes.length}` : undefined}>
          Notes
        </SectionHeader>
        {job.notes.length === 0 ? (
          <Panel className="px-4 py-6 text-center text-sm text-ink-faint">
            No notes on this job.
          </Panel>
        ) : (
          <Panel className="overflow-hidden">
            <ul className="divide-y divide-surface-divider">
              {job.notes.map((n, i) => (
                <li key={i} className="px-3.5 py-3">
                  <p className="whitespace-pre-wrap text-sm text-ink-muted">{n.content}</p>
                  {(n.author || n.createdAt) && (
                    <p className="mt-1.5 text-[11px] text-ink-faint">
                      {[n.author, n.createdAt?.slice(0, 10)].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </section>
    </main>
  );
}
