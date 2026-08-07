"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  /** No data to show yet — the only state that should render a skeleton. */
  loading: boolean;
  /** A fetch is in flight but there is already something on screen. */
  revalidating: boolean;
  error: string | null;
  fromCache: boolean;
  refresh: () => void;
}

interface Payload<T> {
  data: T;
  generatedAt: string | null;
  mirrorSyncedAt: string | null;
  staleAfterMinutes: number | null;
  fromCache: boolean;
  storedAt: number;
}

// Every screen in the app is a separate route, so switching tabs unmounts one
// component and mounts another — and without this, that meant every tab paid a
// full round trip every time it was opened, even having been read seconds
// earlier. The service worker does not help: its /api/app/* handler awaits the
// network first and only reaches for its cache when that throws, so it is a
// fallback for being offline, not a fast path for being online.
//
// This sits above that: a tab reopened inside the freshness window paints from
// the last payload immediately and revalidates behind it.
const memory = new Map<string, Payload<unknown>>();

// How old a cached payload may be and still be worth painting instantly.
//
// Not unbounded, and the reason is honesty rather than memory. The freshness
// stamp reports mirror age out of the payload, so a cache left overnight would
// paint yesterday's jobs under a heading that says Today, with a "sync is
// behind" warning blaming the cron for what is actually a stale cache — until
// the revalidation lands a second later and silently corrects it. Five minutes
// is short enough that an instant paint can never say something a reader would
// act on differently.
const MAX_AGE_MS = 5 * 60_000;

function readCache<T>(path: string): Payload<T> | null {
  const hit = memory.get(path) as Payload<T> | undefined;
  if (!hit) return null;
  if (Date.now() - hit.storedAt > MAX_AGE_MS) {
    memory.delete(path);
    return null;
  }
  return hit;
}

// The one fetch hook every /app/* screen uses. It exists so "how old is this
// data" and "signed out" are answered identically everywhere, rather than
// each screen growing its own copy that drifts from the others.
export function useAppData<T>(path: string): AppData<T> {
  // Seeded in the initialiser, not an effect: an effect runs after paint, so
  // the reader would see an empty screen for a frame before the cached data
  // appeared, which is the flash this exists to remove.
  const [payload, setPayload] = useState<Payload<T> | null>(() => readCache<T>(path));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Bumping a counter (rather than calling the fetch function directly) keeps
  // refresh() stable across renders and re-runs the same effect below, so
  // there is exactly one place the fetch/parse/error logic lives.
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // The path can change without remounting — Schedule's week arrows do exactly
  // that. Swap to the new path's cache before its request lands, or the old
  // week stays on screen looking like the new one.
  const lastPath = useRef(path);
  if (lastPath.current !== path) {
    lastPath.current = path;
    setPayload(readCache<T>(path));
  }

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
          // Drop everything held for this path. A signed-out session must not
          // leave the previous user's customers painting instantly on the next
          // sign-in.
          memory.clear();
          if (!cancelled) {
            setPayload(null);
            setError("You are not signed in.");
          }
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled) setError(body.error ?? `Request failed (${res.status}).`);
          return;
        }

        const body = await res.json();
        const next: Payload<T> = {
          data: body.data as T,
          generatedAt: body.generated_at ?? null,
          // Absent on a response cached before this contract existed, so both
          // stay nullable and FreshnessStamp falls back to the old wording
          // rather than rendering "Synced NaN min ago" after an upgrade.
          mirrorSyncedAt: body.mirror_synced_at ?? null,
          staleAfterMinutes:
            typeof body.stale_after_minutes === "number" ? body.stale_after_minutes : null,
          // Set by the service worker (Task 11) when it serves a stale cached
          // copy. This header is the ONLY signal that distinguishes a live
          // response from a cached one -- everything downstream (FreshnessStamp)
          // depends on it being read here and nowhere else.
          fromCache: res.headers.get("X-Trinity-Cache") === "hit",
          storedAt: Date.now(),
        };

        // Written even if this render was cancelled: the response is valid and
        // the next screen to ask for this path should have it.
        memory.set(path, next as Payload<unknown>);

        if (cancelled) return;
        setPayload(next);
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
    data: payload?.data ?? null,
    generatedAt: payload?.generatedAt ?? null,
    mirrorSyncedAt: payload?.mirrorSyncedAt ?? null,
    staleAfterMinutes: payload?.staleAfterMinutes ?? null,
    // Only true when there is genuinely nothing to show. A revalidation over
    // cached data must never put a skeleton back on top of real content.
    loading: loading && payload === null,
    revalidating: loading && payload !== null,
    error,
    fromCache: payload?.fromCache ?? false,
    refresh,
  };
}

// Tests only — module state survives between cases in a file otherwise.
export function clearAppDataCache(): void {
  memory.clear();
}
