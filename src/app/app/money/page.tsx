"use client";

import { useState } from "react";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { ScreenHeader } from "@/components/mobile/ScreenHeader";
import { EmptyState } from "@/components/mobile/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { Figure } from "@/components/ui/Figure";

interface EstimateHit { id: string; customerName: string | null; amountCents: number | null; status: string | null }
interface InvoiceHit { id: string; customerName: string | null; amountCents: number | null; status: string | null; dueDate: string | null; overdueDays: number | null }
interface MoneyPayload {
  estimates: EstimateHit[];
  estimatesTotalCents: number;
  invoices: InvoiceHit[];
  invoicesTotalCents: number;
}

const money = (cents: number | null) =>
  cents == null
    ? "—"
    : `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const TABS = [
  { key: "estimates", label: "Estimates" },
  { key: "invoices", label: "Invoices" },
] as const;

export default function MoneyPage() {
  const [tab, setTab] = useState<"estimates" | "invoices">("estimates");
  const { data, generatedAt, mirrorSyncedAt, staleAfterMinutes, loading, error, fromCache } = useAppData<MoneyPayload>("/api/app/money");

  return (
    <main className="px-3 pb-4 pt-3">
      <ScreenHeader title="Money" subtitle="Outstanding on both sides">
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

      {/* Plain buttons with aria-pressed rather than role="tab": a real tablist
          owes the reader tabpanels and arrow-key navigation, and half-built
          ARIA reads worse to a screen reader than none. */}
      <div className="mb-4 flex rounded-xl border border-surface-divider bg-surface-card p-1">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
            className={`min-h-[40px] flex-1 rounded-lg font-display text-base font-semibold uppercase tracking-wide transition-colors ${
              tab === key ? "bg-brand text-ink-inverse" : "text-ink-muted"
            }`}
          >
            {label}
            {data && (
              <span className={`ml-1.5 font-mono text-xs ${tab === key ? "opacity-70" : "text-ink-faint"}`}>
                {key === "estimates" ? data.estimates.length : data.invoices.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {data && tab === "estimates" && (
        <>
          <Panel className="mb-4 px-4 py-3.5">
            <Figure
              value={money(data.estimatesTotalCents)}
              label="Awaiting a response"
              tone="warn"
              caption={`${data.estimates.length} ${data.estimates.length === 1 ? "estimate" : "estimates"}`}
            />
          </Panel>
          {data.estimates.length === 0 ? (
            <EmptyState>No estimates are waiting on a customer.</EmptyState>
          ) : (
            <Panel className="overflow-hidden">
              <ul className="divide-y divide-surface-divider">
                {data.estimates.map((e) => (
                  <li key={e.id} className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-ink-primary">
                        {e.customerName ?? "Unknown customer"}
                      </div>
                      {e.status && <div className="mt-0.5 text-xs text-ink-faint">{e.status}</div>}
                    </div>
                    <span className="shrink-0 font-mono text-sm text-ink-muted tnum">
                      {money(e.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}

      {data && tab === "invoices" && (
        <>
          <Panel className="mb-4 px-4 py-3.5">
            <Figure
              value={money(data.invoicesTotalCents)}
              label="Unpaid"
              tone="warn"
              caption={`${data.invoices.length} ${data.invoices.length === 1 ? "invoice" : "invoices"}`}
            />
          </Panel>
          {data.invoices.length === 0 ? (
            <EmptyState>Nothing outstanding. Every invoice is settled.</EmptyState>
          ) : (
            <Panel className="overflow-hidden">
              <ul className="divide-y divide-surface-divider">
                {data.invoices.map((i) => (
                  <li key={i.id} className="flex items-baseline justify-between gap-3 px-3.5 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-ink-primary">
                        {i.customerName ?? "Unknown customer"}
                      </div>
                      <div className="mt-0.5 text-xs">
                        {i.overdueDays ? (
                          <span className="font-medium text-danger">{i.overdueDays} days overdue</span>
                        ) : (
                          <span className="text-ink-faint">Due {i.dueDate ?? "—"}</span>
                        )}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-sm text-ink-muted tnum">
                      {money(i.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}

      {/* Both segments above are gated on `data`, so without this the screen
          renders nothing at all under the tab toggle while the first request is
          in flight -- a blank panel that reads as "no estimates, no invoices"
          rather than "still loading". Same line Today already carries. */}
      {loading && !data && <p className="text-sm text-ink-faint">Loading…</p>}
    </main>
  );
}
