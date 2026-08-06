"use client";

import { useState } from "react";
import { EmptyState } from "@/components/mobile/EmptyState";

// Only the fields this screen renders. The API also returns per-job detail
// (customer, address, technician, miles away) for the desktop table, but the
// framing here is "which day is best", not a data dump — so that detail is
// deliberately left untyped and unused.
interface NearbyDay {
  dateKey: string;
  jobs: { id: string }[];
  summary: string;
  detourMinutes: number | null;
}

// dateKey is a local YYYY-MM-DD from localDateKey(). Anchoring at 12:00Z before
// constructing the Date keeps it on the right calendar day under either DST
// offset — the same approach dayLabel() uses in the desktop NearbySearch.
function dayLabel(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

export default function DispatchPage() {
  const [query, setQuery] = useState("");
  const [days, setDays] = useState<NearbyDay[] | null>(null);
  // A location that couldn't be placed (most often a town Trinity has never
  // worked in) is a real answer, not a failed request — resolveLocation's own
  // comment says so. It gets the same calm empty-state treatment as "nothing
  // nearby" below, kept separate from `error` so it never renders as a red alert.
  const [notFound, setNotFound] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const term = query.trim();
    if (!term) return;

    setBusy(true);
    setError(null);
    setNotFound(null);
    setDays(null);
    try {
      const res = await fetch(`/api/dispatch/nearby?q=${encodeURIComponent(term)}`, {
        credentials: "same-origin",
      });
      const body = await res.json();
      if (res.status === 404) {
        setNotFound(body.error ?? "Couldn't place that location.");
        return;
      }
      if (!res.ok) {
        setError(body.error ?? "Lookup failed.");
        return;
      }
      setDays(body.matches);
    } catch {
      setError("Offline — this lookup needs a connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="px-3 pt-3">
      <header className="mb-3">
        <h1 className="text-xl font-bold tracking-tight">Dispatch</h1>
        <p className="text-xs text-ink-faint">Are we already going near there?</p>
      </header>

      <form onSubmit={search} className="mb-3 flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Town or full address"
          className="min-h-[44px] flex-1 rounded-full border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint"
        />
        <button
          type="submit"
          disabled={busy}
          className="min-h-[44px] rounded-full bg-brand px-5 text-sm font-bold text-ink-inverse disabled:opacity-60"
        >
          {busy ? "…" : "Go"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {notFound && <EmptyState>{notFound}</EmptyState>}

      {days && days.length === 0 && (
        <EmptyState>
          Nothing booked near there in the next two weeks. A town with no history resolves to
          nothing — which is itself the answer.
        </EmptyState>
      )}

      {days?.map((d, i) => (
        <div
          key={d.dateKey}
          className={`mb-2 rounded-xl border px-3 py-2.5 ${
            i === 0 ? "border-brand bg-brand-tint" : "border-surface-divider bg-surface-card"
          }`}
        >
          {i === 0 && (
            <div className="text-[10px] font-bold uppercase tracking-wider text-brand">Best day</div>
          )}
          <div className="mt-0.5 text-sm font-semibold">{dayLabel(d.dateKey)}</div>
          <div className="mt-0.5 text-xs text-ink-muted">{d.summary}</div>
          {d.detourMinutes != null && (
            <div className="mt-0.5 text-xs text-ink-faint">≈ {d.detourMinutes} min detour</div>
          )}
        </div>
      ))}
    </main>
  );
}
