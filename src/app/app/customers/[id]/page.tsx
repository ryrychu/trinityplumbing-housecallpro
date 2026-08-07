"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { DetailHeader } from "@/components/mobile/DetailHeader";
import { BackLink } from "@/components/mobile/BackLink";
import { StatusPill } from "@/components/mobile/StatusPill";
import { ActionPair } from "@/components/mobile/ActionPair";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Panel } from "@/components/ui/Panel";
import { Figure } from "@/components/ui/Figure";
import { Skeleton, LoadingStatus } from "@/components/ui/Skeleton";
import { formatPhone } from "@/lib/mobile/phone";

interface CustomerDetail {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  company: string | null;
  email: string | null;
  lifetimeCents: number;
  jobs: {
    id: string;
    scheduledStart: string | null;
    service: string | null;
    status: string | null;
    amountCents: number | null;
  }[];
}

const RECENT_KEY = "trinity.recentCustomers";
const RECENT_MAX = 8;

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export default function CustomerPage({ params }: { params: { id: string } }) {
  // generatedAt/fromCache are destructured, not dropped -- see the same comment
  // on the job detail screen. This is the other page someone acts on: the phone
  // number below is tapped to call. Cached-and-stale must say so.
  const { data, generatedAt, mirrorSyncedAt, staleAfterMinutes, error, fromCache } = useAppData<CustomerDetail>(
    `/api/app/customers/${params.id}`
  );

  // Recording the visit here (not on tap) means the list only ever holds
  // customers that actually resolved.
  useEffect(() => {
    if (!data) return;
    try {
      const entry = { id: data.id, name: data.name, phone: data.phone, address: data.address };
      // Same shape check the read side does (../page.tsx): a stored "null"
      // parses without throwing, and .filter on it would throw into the catch
      // below -- harmless, but it would leave the bad value in place forever
      // and the recently-viewed list permanently empty. Overwriting it here is
      // what lets a corrupted key heal on the next customer opened.
      const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
      const prior = (Array.isArray(parsed) ? parsed : []) as { id: string }[];
      const next = [entry, ...prior.filter((c) => c.id !== data.id)].slice(0, RECENT_MAX);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {}
  }, [data]);

  if (error) {
    return (
      <main className="px-3 pt-3">
        <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="px-3 pb-4 pt-3">
        <LoadingStatus />
        {/* The back control is real, not a placeholder — it is the one thing
            that must work before the data arrives. */}
        <header className="mb-4 flex items-start gap-1.5">
          <BackLink fallback="/app/customers" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-3 w-32" />
          </div>
        </header>
        <div className="mb-5 flex gap-2">
          <Skeleton className="h-12 flex-1 rounded-xl" />
          <Skeleton className="h-12 flex-1 rounded-xl" />
        </div>
        <Panel className="mb-5">
          <div className="grid grid-cols-2 divide-x divide-surface-divider">
            {[0, 1].map((i) => (
              <div key={i} className="space-y-2 px-4 py-3.5">
                <Skeleton className="h-6 w-16" />
                <Skeleton className="h-2.5 w-14" />
              </div>
            ))}
          </div>
        </Panel>
        <SectionHeader>History</SectionHeader>
        <Panel className="overflow-hidden">
          <ul className="divide-y divide-surface-divider">
            {Array.from({ length: 5 }, (_, i) => (
              <li key={i} className="space-y-1.5 px-3.5 py-2.5">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </li>
            ))}
          </ul>
        </Panel>
      </main>
    );
  }

  return (
    <main className="px-3 pb-4 pt-3">
      <DetailHeader
        title={data.name}
        subtitle={data.company ?? formatPhone(data.phone) ?? undefined}
        backTo="/app/customers"
      >
        <FreshnessStamp
          generatedAt={generatedAt}
          fromCache={fromCache}
          mirrorSyncedAt={mirrorSyncedAt}
          staleAfterMinutes={staleAfterMinutes}
        />
      </DetailHeader>

      <ActionPair phone={data.phone} address={data.address} />

      <section className="mb-5">
        <Panel>
          <div className="grid grid-cols-2 divide-x divide-surface-divider">
            <div className="px-4 py-3.5">
              <Figure value={data.jobs.length} label="Jobs" size="compact" />
            </div>
            <div className="px-4 py-3.5">
              <Figure
                value={money(data.lifetimeCents)}
                label="Lifetime"
                size="compact"
                tone="success"
              />
            </div>
          </div>
        </Panel>
      </section>

      <section>
        <SectionHeader meta={data.jobs.length > 0 ? `${data.jobs.length}` : undefined}>
          History
        </SectionHeader>
        {data.jobs.length === 0 ? (
          <Panel className="px-4 py-6 text-center text-sm text-ink-faint">
            No jobs on record for this customer.
          </Panel>
        ) : (
          <Panel className="overflow-hidden">
            <ul className="divide-y divide-surface-divider">
              {data.jobs.map((j) => (
                <li key={j.id}>
                  <Link
                    href={`/app/jobs/${j.id}`}
                    className="block min-h-[44px] px-3.5 py-2.5 transition-colors hover:bg-surface-raised"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-medium text-ink-primary">
                        {j.service ?? "Job"}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-ink-muted tnum">
                        {j.amountCents == null ? "" : money(j.amountCents)}
                      </span>
                    </div>
                    {/* The status is a scheduleStatus() label now, so it renders
                        through the same pill as every other job surface rather
                        than as bare text -- one job must not look like two
                        different things depending on which screen you reached
                        it from. */}
                    <div className="mt-1 flex items-center gap-2">
                      {j.scheduledStart && (
                        <span className="font-mono text-[11px] text-ink-faint tnum">
                          {j.scheduledStart.slice(0, 10)}
                        </span>
                      )}
                      <StatusPill status={j.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </section>
    </main>
  );
}
