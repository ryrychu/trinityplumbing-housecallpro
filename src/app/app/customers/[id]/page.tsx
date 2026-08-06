"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useAppData } from "@/components/mobile/useAppData";
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
  const { data, error } = useAppData<CustomerDetail>(`/api/app/customers/${params.id}`);

  // Recording the visit here (not on tap) means the list only ever holds
  // customers that actually resolved.
  useEffect(() => {
    if (!data) return;
    try {
      const entry = { id: data.id, name: data.name, phone: data.phone, address: data.address };
      const prior = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as { id: string }[];
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
  if (!data) return <main className="px-3 pt-3 text-sm text-ink-faint">Loading…</main>;

  return (
    <main className="px-3 pt-3">
      <header className="mb-3 flex items-center gap-2">
        <Link href="/app/customers" aria-label="Back" className="min-h-[44px] px-1 text-xl text-brand">
          ‹
        </Link>
        <div>
          <h1 className="text-lg font-bold tracking-tight">{data.name}</h1>
          {data.company && <p className="text-xs text-ink-faint">{data.company}</p>}
        </div>
      </header>

      <div className="mb-4 flex gap-2">
        <a
          href={data.phone ? `tel:${data.phone}` : undefined}
          className={`min-h-[44px] flex-1 rounded-xl py-3 text-center text-sm font-bold ${
            data.phone ? "bg-brand text-ink-inverse" : "bg-surface-elevated text-ink-faint"
          }`}
        >
          📞 {formatPhone(data.phone) ?? "No number"}
        </a>
        <a
          href={data.address ? `maps:?q=${encodeURIComponent(data.address)}` : undefined}
          className="min-h-[44px] rounded-xl border border-surface-border px-4 py-3 text-center text-sm font-bold"
        >
          🧭
        </a>
      </div>

      <div className="mb-4 flex gap-2">
        <div className="flex-1 rounded-xl border border-surface-divider bg-surface-card p-3 text-center">
          <div className="font-mono text-lg font-bold">{data.jobs.length}</div>
          <div className="text-[10px] uppercase text-ink-faint">Jobs</div>
        </div>
        <div className="flex-1 rounded-xl border border-surface-divider bg-surface-card p-3 text-center">
          <div className="font-mono text-lg font-bold text-success">{money(data.lifetimeCents)}</div>
          <div className="text-[10px] uppercase text-ink-faint">Lifetime</div>
        </div>
      </div>

      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        History
      </h2>
      {data.jobs.map((j) => (
        <Link
          key={j.id}
          href={`/app/jobs/${j.id}`}
          className="mb-2 block min-h-[44px] rounded-xl border border-surface-divider bg-surface-card px-3 py-2.5"
        >
          <div className="flex justify-between text-sm">
            <span className="font-medium">{j.service ?? "Job"}</span>
            <span className="text-ink-muted">
              {j.amountCents == null ? "" : money(j.amountCents)}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">
            {[j.scheduledStart?.slice(0, 10), j.status].filter(Boolean).join(" · ")}
          </div>
        </Link>
      ))}
    </main>
  );
}
