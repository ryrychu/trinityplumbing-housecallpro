"use client";

import { useState } from "react";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { EmptyState } from "@/components/mobile/EmptyState";

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

export default function MoneyPage() {
  const [tab, setTab] = useState<"estimates" | "invoices">("estimates");
  const { data, generatedAt, error, fromCache } = useAppData<MoneyPayload>("/api/app/money");

  return (
    <main className="px-3 pt-3">
      <header className="mb-3">
        <h1 className="text-xl font-bold tracking-tight">Money</h1>
        <FreshnessStamp generatedAt={generatedAt} fromCache={fromCache} />
      </header>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mb-3 flex rounded-xl border border-surface-divider bg-surface-card p-1">
        {(["estimates", "invoices"] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`min-h-[44px] flex-1 rounded-lg text-sm capitalize ${
              tab === key ? "bg-brand font-bold text-ink-inverse" : "text-ink-muted"
            }`}
          >
            {key} {data ? (key === "estimates" ? data.estimates.length : data.invoices.length) : ""}
          </button>
        ))}
      </div>

      {data && tab === "estimates" && (
        <>
          <div className="mb-3 rounded-xl border border-surface-divider bg-surface-card p-3">
            <div className="font-mono text-xl font-bold text-warn">
              {money(data.estimatesTotalCents)}
            </div>
            <div className="text-xs text-ink-faint">
              Awaiting a response · {data.estimates.length} estimates
            </div>
          </div>
          {data.estimates.length === 0 ? (
            <EmptyState>No estimates are waiting on a customer.</EmptyState>
          ) : (
            data.estimates.map((e) => (
              <div
                key={e.id}
                className="mb-2 rounded-xl border border-surface-divider border-l-2 border-l-warn bg-surface-card px-3 py-2.5"
              >
                <div className="flex justify-between text-sm">
                  <span className="font-semibold">{e.customerName ?? "Unknown customer"}</span>
                  <span className="font-mono text-ink-muted">{money(e.amountCents)}</span>
                </div>
                {e.status && <div className="mt-0.5 text-xs text-ink-faint">{e.status}</div>}
              </div>
            ))
          )}
        </>
      )}

      {data && tab === "invoices" && (
        <>
          <div className="mb-3 rounded-xl border border-surface-divider bg-surface-card p-3">
            <div className="font-mono text-xl font-bold text-warn">
              {money(data.invoicesTotalCents)}
            </div>
            <div className="text-xs text-ink-faint">Unpaid · {data.invoices.length} invoices</div>
          </div>
          {data.invoices.length === 0 ? (
            <EmptyState>Nothing outstanding. Every invoice is settled.</EmptyState>
          ) : (
            data.invoices.map((i) => (
              <div
                key={i.id}
                className={`mb-2 rounded-xl border border-surface-divider border-l-2 bg-surface-card px-3 py-2.5 ${
                  i.overdueDays ? "border-l-danger" : "border-l-warn"
                }`}
              >
                <div className="flex justify-between text-sm">
                  <span className="font-semibold">{i.customerName ?? "Unknown customer"}</span>
                  <span className="font-mono text-ink-muted">{money(i.amountCents)}</span>
                </div>
                <div className="mt-0.5 text-xs">
                  {i.overdueDays ? (
                    <span className="text-danger">{i.overdueDays} days overdue</span>
                  ) : (
                    <span className="text-ink-faint">Due {i.dueDate ?? "—"}</span>
                  )}
                </div>
              </div>
            ))
          )}
        </>
      )}
    </main>
  );
}
