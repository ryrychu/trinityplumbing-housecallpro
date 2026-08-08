"use client";

import { useState } from "react";
import Link from "next/link";
import { useAppData } from "@/components/mobile/useAppData";
import { FreshnessStamp } from "@/components/mobile/FreshnessStamp";
import { ScreenHeader } from "@/components/mobile/ScreenHeader";
import { EmptyState } from "@/components/mobile/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { Figure } from "@/components/ui/Figure";
import { ChevronRightIcon } from "@/components/ui/icons";
import { Skeleton, LoadingStatus } from "@/components/ui/Skeleton";
import {
  filterEstimates,
  filterInvoices,
  sumCents,
  statusOptions,
  countOverdue,
} from "@/lib/mobile/moneyFilters";

interface EstimateHit { id: string; customerId: string | null; customerName: string | null; amountCents: number | null; status: string | null }
interface InvoiceHit { id: string; customerId: string | null; customerName: string | null; amountCents: number | null; status: string | null; dueDate: string | null; overdueDays: number | null }
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

/**
 * One money row. It links to the customer when that customer resolves, because
 * the thing you do with an overdue invoice is phone the person on it, and
 * their number is one screen away. An unresolvable customer renders as the
 * same row without the link rather than as a link that 404s.
 */
function MoneyRow({
  customerId,
  customerName,
  amount,
  meta,
}: {
  customerId: string | null;
  customerName: string | null;
  amount: string;
  meta: React.ReactNode;
}) {
  const body = (
    <>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-ink-primary">
          {customerName ?? "Unknown customer"}
        </div>
        <div className="mt-0.5 text-xs">{meta}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="font-mono text-sm text-ink-muted tnum">{amount}</span>
        {customerId && <ChevronRightIcon className="h-3.5 w-3.5 text-ink-faint" />}
      </div>
    </>
  );

  const shell = "flex min-h-[44px] items-baseline justify-between gap-3 px-3.5 py-2.5";

  return (
    <li>
      {customerId ? (
        <Link
          href={`/app/customers/${customerId}`}
          className={`${shell} transition-colors hover:bg-surface-raised`}
        >
          {body}
        </Link>
      ) : (
        <div className={shell}>{body}</div>
      )}
    </li>
  );
}

/**
 * The empty state, which has to say which kind of empty this is.
 *
 * "Every invoice is settled" is very good news and "your filter matched
 * nothing" is not news at all, and a screen that shows the first when it means
 * the second is telling the owner their debts are paid.
 */
function NoMatches({
  narrowed,
  onClear,
  empty,
}: {
  narrowed: boolean;
  onClear: () => void;
  empty: string;
}) {
  if (!narrowed) return <EmptyState>{empty}</EmptyState>;
  return (
    <Panel className="px-4 py-8 text-center">
      <p className="text-sm text-ink-faint">Nothing matches those filters.</p>
      <button
        type="button"
        onClick={onClear}
        className="mt-3 min-h-[44px] rounded-xl border border-surface-border px-4 text-sm font-semibold text-ink-primary transition-colors hover:border-brand hover:text-brand"
      >
        Clear filters
      </button>
    </Panel>
  );
}

export default function MoneyPage() {
  const [tab, setTab] = useState<"estimates" | "invoices">("estimates");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const { data, generatedAt, mirrorSyncedAt, staleAfterMinutes, loading, revalidating, error, fromCache } =
    useAppData<MoneyPayload>("/api/app/money");

  const allEstimates = data?.estimates ?? [];
  const allInvoices = data?.invoices ?? [];
  const estimates = filterEstimates(allEstimates, { query, status });
  const invoices = filterInvoices(allInvoices, { query, overdueOnly });

  const statuses = statusOptions(allEstimates);
  const overdueCount = countOverdue(allInvoices);

  // Whether the list on screen is a subset, which is what decides if the
  // headline figure needs to say so.
  const narrowed =
    tab === "estimates"
      ? estimates.length !== allEstimates.length
      : invoices.length !== allInvoices.length;

  function clearFilters() {
    setQuery("");
    setStatus("all");
    setOverdueOnly(false);
  }

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

      {data && (
        <div className="mb-4 space-y-2">
          <input
            type="search"
            inputMode="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search by customer"
            placeholder="Search by customer"
            className="min-h-[44px] w-full rounded-full border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint"
          />

          {/* Each tab gets the filter its own data actually has. Every unpaid
              invoice carries status "open" -- that is what listUnpaidInvoices
              selects on -- so a status control there would offer one choice;
              what separates invoices is age. Estimates have no age, so theirs
              is the lifecycle status. */}
          {tab === "estimates" && statuses.length > 1 && (
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter by status"
              className="min-h-[44px] w-full rounded-xl border border-surface-border bg-surface-card px-3 text-base text-ink-primary"
            >
              <option value="all">All statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}

          {tab === "invoices" && overdueCount > 0 && (
            <button
              type="button"
              aria-pressed={overdueOnly}
              onClick={() => setOverdueOnly((on) => !on)}
              className={`min-h-[44px] w-full rounded-xl border px-4 text-sm font-semibold transition-colors ${
                overdueOnly
                  ? "border-danger bg-danger-tint text-danger"
                  : "border-surface-border text-ink-muted"
              }`}
            >
              Overdue only
              <span className="ml-1.5 font-mono text-xs tnum">{overdueCount}</span>
            </button>
          )}
        </div>
      )}

      {loading && (
        <>
          <LoadingStatus />
          <Panel className="mb-4 space-y-2 px-4 py-3.5">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-3 w-28" />
          </Panel>
          <Panel className="overflow-hidden">
            <ul className="divide-y divide-surface-divider">
              {Array.from({ length: 6 }, (_, i) => (
                <li key={i} className="flex min-h-[44px] items-baseline justify-between gap-3 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                  <Skeleton className="h-3.5 w-14 shrink-0" />
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}

      {/* Held at reduced opacity during a refresh rather than swapped back to
          the skeleton — replacing readable numbers with their outline is a step
          backwards, and the swap makes the page jump. */}
      <div className={revalidating ? "opacity-60 transition-opacity" : "transition-opacity"}>
      {data && tab === "estimates" && (
        <>
          {/* No figure at all when nothing is showing. A big "$0 awaiting a
              response" over a filter that matched nothing states something
              false — there are 24 estimates, the search just found none of
              them — and the panel below already explains the emptiness. */}
          {estimates.length > 0 && (
            <Panel className="mb-4 px-4 py-3.5">
              {/* Recomputed from the rows on screen, never the server's total.
                  A filtered list under an unfiltered figure is the screen
                  telling you two different things at once, and the figure is
                  the one people read. */}
              <Figure
                value={money(narrowed ? sumCents(estimates) : data.estimatesTotalCents)}
                label="Awaiting a response"
                tone="warn"
                caption={
                  narrowed
                    ? `${estimates.length} of ${allEstimates.length} estimates`
                    : `${allEstimates.length} ${allEstimates.length === 1 ? "estimate" : "estimates"}`
                }
              />
            </Panel>
          )}
          {estimates.length === 0 ? (
            <NoMatches
              narrowed={narrowed}
              onClear={clearFilters}
              empty="No estimates are waiting on a customer."
            />
          ) : (
            <Panel className="overflow-hidden">
              <ul className="divide-y divide-surface-divider">
                {estimates.map((e) => (
                  <MoneyRow
                    key={e.id}
                    customerId={e.customerId}
                    customerName={e.customerName}
                    amount={money(e.amountCents)}
                    meta={<span className="text-ink-faint">{e.status ?? "Awaiting a response"}</span>}
                  />
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}

      {data && tab === "invoices" && (
        <>
          {/* Hidden when nothing is showing — see the note on the estimates
              figure. "$0 overdue" over a search that found nobody is a claim
              about the debt, not about the search. */}
          {invoices.length > 0 && (
            <Panel className="mb-4 px-4 py-3.5">
              <Figure
                value={money(narrowed ? sumCents(invoices) : data.invoicesTotalCents)}
                label={overdueOnly ? "Overdue" : "Unpaid"}
                tone="warn"
                caption={
                  narrowed
                    ? `${invoices.length} of ${allInvoices.length} invoices`
                    : `${allInvoices.length} ${allInvoices.length === 1 ? "invoice" : "invoices"}`
                }
              />
            </Panel>
          )}
          {invoices.length === 0 ? (
            <NoMatches
              narrowed={narrowed}
              onClear={clearFilters}
              empty="Nothing outstanding. Every invoice is settled."
            />
          ) : (
            <Panel className="overflow-hidden">
              <ul className="divide-y divide-surface-divider">
                {invoices.map((i) => (
                  <MoneyRow
                    key={i.id}
                    customerId={i.customerId}
                    customerName={i.customerName}
                    amount={money(i.amountCents)}
                    meta={
                      i.overdueDays ? (
                        <span className="font-medium text-danger">{i.overdueDays} days overdue</span>
                      ) : (
                        <span className="text-ink-faint">Due {i.dueDate ?? "—"}</span>
                      )
                    }
                  />
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
      </div>

      {/* Both segments above are gated on `data`; the skeleton above covers the
          first request, so the screen is never a blank panel under the toggle
          that reads as "no estimates, no invoices" rather than "still
          loading". */}
    </main>
  );
}
