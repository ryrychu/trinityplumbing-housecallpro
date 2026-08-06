"use client";

import { useCallback, useEffect, useState } from "react";

export interface AppData<T> {
  data: T | null;
  generatedAt: string | null;
  // When the mirror this screen's data came from was last synced, and how old
  // that is allowed to get before the screen should say something is wrong.
  // Both are route-declared (see src/lib/mobile/mirrorFreshness.ts) because
  // "stale" means something different for a screen reading 15-minute job data
  // than for one reading invoices reconciled once a day.
  mirrorSyncedAt: string | null;
  staleAfterMinutes: number | null;
  loading: boolean;
  error: string | null;
  fromCache: boolean;
  refresh: () => void;
}

// The one fetch hook every /app/* screen uses. It exists so "how old is this
// data" and "signed out" are answered identically everywhere, rather than
// each screen growing its own copy that drifts from the others.
export function useAppData<T>(path: string): AppData<T> {
  const [data, setData] = useState<T | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [mirrorSyncedAt, setMirrorSyncedAt] = useState<string | null>(null);
  const [staleAfterMinutes, setStaleAfterMinutes] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Bumping a counter (rather than calling the fetch function directly) keeps
  // refresh() stable across renders and re-runs the same effect below, so
  // there is exactly one place the fetch/parse/error logic lives.
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const res = await fetch(path, { credentials: "same-origin" });

        // Task 2's middleware returns 401 JSON, never an HTML redirect, so
        // this is reachable and must be distinguished from a generic failure
        // -- the UI's fix for "signed out" is different from "server error".
        if (res.status === 401) {
          if (!cancelled) setError("You are not signed in.");
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled) setError(body.error ?? `Request failed (${res.status}).`);
          return;
        }

        const body = await res.json();
        if (cancelled) return;
        setData(body.data as T);
        setGeneratedAt(body.generated_at ?? null);
        // Absent on a response cached before this contract existed, so both
        // stay nullable and FreshnessStamp falls back to the old wording
        // rather than rendering "Synced NaN min ago" after an upgrade.
        setMirrorSyncedAt(body.mirror_synced_at ?? null);
        setStaleAfterMinutes(
          typeof body.stale_after_minutes === "number" ? body.stale_after_minutes : null
        );
        // Set by the service worker (Task 11) when it serves a stale cached
        // copy. This header is the ONLY signal that distinguishes a live
        // response from a cached one -- everything downstream (FreshnessStamp)
        // depends on it being read here and nowhere else.
        setFromCache(res.headers.get("X-Trinity-Cache") === "hit");
        setError(null);
      } catch {
        // A thrown fetch means no network AND no cached copy — the only case
        // where the screen genuinely has nothing to show.
        if (!cancelled) setError("Offline, and nothing saved for this screen yet.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  return {
    data,
    generatedAt,
    mirrorSyncedAt,
    staleAfterMinutes,
    loading,
    error,
    fromCache,
    refresh,
  };
}
