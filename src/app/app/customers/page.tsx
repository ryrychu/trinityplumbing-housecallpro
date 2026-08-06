"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatPhone } from "@/lib/mobile/phone";
import { EmptyState } from "@/components/mobile/EmptyState";

interface CustomerHit { id: string; name: string; phone: string | null; address: string | null }

const RECENT_KEY = "trinity.recentCustomers";

function readRecent(): CustomerHit[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export default function CustomersPage() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CustomerHit[] | null>(null);
  const [recent, setRecent] = useState<CustomerHit[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setRecent(readRecent()), []);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setHits(null);
      return;
    }
    // 250ms is long enough that a typist does not fire a query per character,
    // short enough that it still feels instant.
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/app/customers?q=${encodeURIComponent(term)}`, {
          credentials: "same-origin",
        });
        const body = await res.json();
        if (!res.ok) {
          setError(body.error ?? "Search failed.");
          return;
        }
        setHits(body.data.hits);
        setError(null);
      } catch {
        setError("Offline — search needs a connection.");
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  const list = hits ?? recent;

  return (
    <main className="px-3 pt-3">
      <h1 className="mb-3 text-xl font-bold tracking-tight">Customers</h1>

      <input
        type="search"
        inputMode="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Name, phone or address"
        className="mb-3 min-h-[44px] w-full rounded-full border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint"
      />

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {!hits && recent.length > 0 && (
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          Recently viewed
        </h2>
      )}

      {list.length === 0 ? (
        <EmptyState>
          {hits ? `No customer matches "${query}".` : "Search by name, phone or address."}
        </EmptyState>
      ) : (
        list.map((c) => (
          <Link
            key={c.id}
            href={`/app/customers/${c.id}`}
            className="mb-2 block min-h-[44px] rounded-xl border border-surface-divider bg-surface-card px-3 py-2.5"
          >
            <div className="text-sm font-semibold">{c.name}</div>
            <div className="mt-0.5 text-xs text-ink-muted">
              {[formatPhone(c.phone), c.address].filter(Boolean).join(" · ")}
            </div>
          </Link>
        ))
      )}
    </main>
  );
}
