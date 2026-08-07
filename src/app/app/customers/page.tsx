"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatPhone } from "@/lib/mobile/phone";
import { EmptyState } from "@/components/mobile/EmptyState";
import { ScreenHeader } from "@/components/mobile/ScreenHeader";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Panel } from "@/components/ui/Panel";

interface CustomerHit { id: string; name: string; phone: string | null; address: string | null }

const RECENT_KEY = "trinity.recentCustomers";

function readRecent(): CustomerHit[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    // JSON.parse only throws on malformed JSON. A stored "null", "42" or
    // '{"a":1}' parses cleanly, so catch never fires -- and then recent.length
    // throws during render, white-screening the whole Customers tab. On a
    // phone there is no way back from that short of clearing site data, so the
    // shape is checked rather than assumed.
    return Array.isArray(parsed) ? parsed : [];
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
    //
    // clearTimeout below only cancels a *pending* timer -- once the callback
    // has fired the fetch is in flight and clearTimeout can't stop it. If a
    // later keystroke starts a second request, the first one's response can
    // still arrive after the second's and, without this flag, overwrite the
    // correct results with results for a query no longer on screen. Same
    // guard useAppData uses for the identical reason.
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/app/customers?q=${encodeURIComponent(term)}`, {
          credentials: "same-origin",
        });
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "Search failed.");
          return;
        }
        setHits(body.data.hits);
        setError(null);
      } catch {
        if (!cancelled) setError("Offline — search needs a connection.");
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const list = hits ?? recent;

  return (
    <main className="px-3 pb-4 pt-3">
      {/* No subtitle: the field's placeholder and the empty state both already
          say how to search, and a third copy of the same sentence in the header
          was the screen telling you the same thing three times. */}
      <ScreenHeader title="Customers" />

      <input
        type="search"
        inputMode="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search customers"
        placeholder="Name, phone or address"
        className="mb-4 min-h-[44px] w-full rounded-full border border-surface-border bg-surface-card px-4 text-base text-ink-primary placeholder:text-ink-faint"
      />

      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {list.length > 0 && (
        <SectionHeader meta={`${list.length}`}>
          {hits ? "Results" : "Recently viewed"}
        </SectionHeader>
      )}

      {list.length === 0 ? (
        <EmptyState>
          {hits ? `No customer matches "${query}".` : "Search by name, phone or address."}
        </EmptyState>
      ) : (
        <Panel className="overflow-hidden">
          <ul className="divide-y divide-surface-divider">
            {list.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/app/customers/${c.id}`}
                  className="block min-h-[44px] px-3.5 py-2.5 transition-colors hover:bg-surface-raised"
                >
                  <div className="truncate text-sm font-semibold text-ink-primary">{c.name}</div>
                  <div className="mt-0.5 truncate text-xs text-ink-muted">
                    {[formatPhone(c.phone), c.address].filter(Boolean).join(" · ")}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </main>
  );
}
