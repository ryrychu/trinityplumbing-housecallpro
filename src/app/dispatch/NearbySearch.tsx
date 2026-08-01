"use client";

import { useState } from "react";
import { Card } from "../dashboard/components/Card";

interface NearbyJob {
  id: string;
  scheduledStart: string | null;
  customerName: string | null;
  technicianName: string | null;
  address: string | null;
  service: string | null;
  status: string | null;
  milesAway: number;
}

interface NearbyDay {
  dateKey: string;
  jobs: NearbyJob[];
  nearestMiles: number | null;
  totalJobs: number;
  summary: string | null;
  detourMinutes: number | null;
}

interface Result {
  location: { label: string; via: "town" | "address"; sampleSize?: number };
  radiusMiles: number;
  days: number;
  matches: NearbyDay[];
  all: NearbyDay[];
}

const TZ = "America/New_York";

function dayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

function timeLabel(iso: string | null): string {
  if (!iso) return "Time TBD";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function NearbySearch() {
  const [query, setQuery] = useState("");
  const [radius, setRadius] = useState(12);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(
        `/api/dispatch/nearby?q=${encodeURIComponent(query)}&radius=${radius}`
      );
      const data = await res.json();
      if (!res.ok) setError(data.error ?? `Search failed (${res.status})`);
      else setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <form onSubmit={search}>
          <label htmlFor="q" className="block text-sm font-medium text-ink-primary">
            Where is the customer?
          </label>
          <p className="mt-1 text-sm text-ink-faint">
            A town (<span className="text-ink-muted">Delmar</span>) or a full address
            (<span className="text-ink-muted">12 Elm St, Delmar</span>).
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <input
              id="q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Town or address"
              className="min-w-0 flex-1 rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-ink-primary placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <select
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
              aria-label="Search radius"
              className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-ink-primary focus:border-brand focus:outline-none"
            >
              {[5, 12, 20, 30].map((m) => (
                <option key={m} value={m}>
                  within {m} mi
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={busy || !query.trim()}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-ink-inverse transition hover:bg-brand-bright disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Looking…" : "Search"}
            </button>
          </div>
        </form>
      </Card>

      {error && (
        <Card className="border-danger/50 p-5">
          <p className="text-sm text-danger">{error}</p>
        </Card>
      )}

      {result && (
        <>
          <Card className="p-5">
            <p className="text-sm text-ink-muted">
              <span className="font-medium text-ink-primary">{result.location.label}</span>
              {result.location.via === "town" ? (
                <> — centre of {result.location.sampleSize} past jobs in that town</>
              ) : (
                <> — geocoded address</>
              )}
              . Next {result.days} days, within {result.radiusMiles} miles.
            </p>
          </Card>

          {result.matches.length === 0 ? (
            <Card className="p-5">
              <p className="text-sm text-ink-primary">Nothing scheduled near there yet.</p>
              <p className="mt-1 text-sm text-ink-faint">
                No existing job within {result.radiusMiles} miles over the next {result.days} days,
                so this one is a trip of its own — widen the radius to see how close the nearest
                work gets.
              </p>
            </Card>
          ) : (
            result.matches.map((day) => (
              <Card key={day.dateKey} className="p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-base font-semibold text-ink-primary">{dayLabel(day.dateKey)}</h2>
                  <span className="text-sm text-ink-faint">
                    {day.totalJobs} {day.totalJobs === 1 ? "job" : "jobs"} booked
                  </span>
                </div>
                {day.summary && <p className="mt-1 text-sm text-brand">{day.summary}</p>}

                <ul className="mt-4 space-y-3">
                  {day.jobs.map((j) => (
                    <li key={j.id} className="border-l-2 border-surface-border pl-3">
                      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <span className="font-medium text-ink-primary">{timeLabel(j.scheduledStart)}</span>
                        <span className="text-ink-muted">{j.customerName ?? "Unknown customer"}</span>
                        <span className="text-ink-faint">· {j.milesAway} mi away</span>
                      </div>
                      <p className="mt-0.5 text-sm text-ink-faint">
                        {[j.address, j.service, j.technicianName ?? "Unassigned", j.status]
                          .filter(Boolean)
                          .join("  ·  ")}
                      </p>
                    </li>
                  ))}
                </ul>
              </Card>
            ))
          )}
        </>
      )}
    </div>
  );
}
