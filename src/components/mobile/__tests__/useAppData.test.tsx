import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAppData, clearAppDataCache } from "../useAppData";

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("useAppData", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // The payload cache is module state and outlives a render, so every case
    // starts from an empty one or it inherits the previous case's data.
    clearAppDataCache();
  });

  it("exposes data and its generated_at", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: { count: 7 }, generated_at: "2026-08-06T14:00:00Z" })
      )
    );

    const { result } = renderHook(() => useAppData<{ count: number }>("/api/app/today"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ count: 7 });
    expect(result.current.generatedAt).toBe("2026-08-06T14:00:00Z");
    expect(result.current.fromCache).toBe(false);
  });

  // The fields the freshness stamp actually renders. generated_at alone can
  // only ever say how long ago the request happened.
  it("exposes the mirror age and the route's staleness threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: {},
          generated_at: "2026-08-06T14:00:00Z",
          mirror_synced_at: "2026-08-06T13:48:00Z",
          stale_after_minutes: 45,
        })
      )
    );

    const { result } = renderHook(() => useAppData("/api/app/today"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.mirrorSyncedAt).toBe("2026-08-06T13:48:00Z");
    expect(result.current.staleAfterMinutes).toBe(45);
  });

  // A response cached by the service worker before this contract existed has
  // neither field. Both must come back null so FreshnessStamp degrades to the
  // old wording instead of rendering "Synced NaN min ago" after an upgrade.
  it("reports nulls for a cached response predating the freshness contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: {}, generated_at: "2026-08-06T14:00:00Z" })
      )
    );

    const { result } = renderHook(() => useAppData("/api/app/today"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.mirrorSyncedAt).toBeNull();
    expect(result.current.staleAfterMinutes).toBeNull();
  });

  // The service worker marks a stale-cache reply with this header; without it
  // the UI cannot tell a live fetch from a cached one and would lie.
  it("reports a service-worker cache hit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: {}, generated_at: "2026-08-06T12:42:00Z" }, { "X-Trinity-Cache": "hit" })
      )
    );

    const { result } = renderHook(() => useAppData("/api/app/today"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.fromCache).toBe(true);
  });

  it("surfaces a 401 as a signed-out error rather than a parse failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 })
      )
    );

    const { result } = renderHook(() => useAppData("/api/app/today"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/signed in/i);
  });

  it("refetches on refresh()", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: {}, generated_at: "2026-08-06T14:00:00Z" }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAppData("/api/app/today"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

// Every tab is its own route, so switching tabs unmounts one screen and mounts
// another. Without a cache above the fetch, that meant a full round trip every
// time -- and the service worker does not help, because its /api/app/* handler
// awaits the network first and only reaches for its cache when that throws.
describe("useAppData payload cache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearAppDataCache();
  });

  it("paints the previous payload on the first render after remounting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { count: 7 }, generated_at: "2026-08-06T14:00:00Z" }));
    vi.stubGlobal("fetch", fetchMock);

    const first = renderHook(() => useAppData<{ count: number }>("/api/app/today"));
    await waitFor(() => expect(first.result.current.data).toEqual({ count: 7 }));
    first.unmount();

    // Remount, as leaving and returning to the tab does. The very first render
    // already has the data -- no await, because an await would hide the flash
    // of empty screen this exists to remove.
    const second = renderHook(() => useAppData<{ count: number }>("/api/app/today"));
    expect(second.result.current.data).toEqual({ count: 7 });
    expect(second.result.current.loading).toBe(false);
  });

  it("still revalidates behind the cached paint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { count: 7 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { count: 9 } }));
    vi.stubGlobal("fetch", fetchMock);

    const first = renderHook(() => useAppData<{ count: number }>("/api/app/today"));
    await waitFor(() => expect(first.result.current.data).toEqual({ count: 7 }));
    first.unmount();

    const second = renderHook(() => useAppData<{ count: number }>("/api/app/today"));
    expect(second.result.current.data).toEqual({ count: 7 });
    expect(second.result.current.revalidating).toBe(true);

    await waitFor(() => expect(second.result.current.data).toEqual({ count: 9 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // loading is what puts a skeleton on screen. Replacing readable content with
  // its own outline on every refresh is a step backwards.
  it("never reports loading while it has something to show", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { count: 7 } })));

    const first = renderHook(() => useAppData<{ count: number }>("/api/app/today"));
    await waitFor(() => expect(first.result.current.data).not.toBeNull());
    first.unmount();

    const second = renderHook(() => useAppData<{ count: number }>("/api/app/today"));
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.revalidating).toBe(true);
  });

  it("keeps each path's payload apart", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(jsonResponse({ data: { url } }))
      )
    );

    const today = renderHook(() => useAppData<{ url: string }>("/api/app/today"));
    await waitFor(() => expect(today.result.current.data).toEqual({ url: "/api/app/today" }));
    today.unmount();

    // A different path must not be handed Today's payload.
    const money = renderHook(() => useAppData<{ url: string }>("/api/app/money"));
    expect(money.result.current.data).toBeNull();
    expect(money.result.current.loading).toBe(true);
  });

  // A signed-out reply must not leave the previous session's customers sitting
  // in memory, ready to paint instantly for whoever signs in next.
  it("drops everything cached when the session is rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { count: 7 } }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = renderHook(() => useAppData<{ count: number }>("/api/app/today"));
    await waitFor(() => expect(first.result.current.data).toEqual({ count: 7 }));
    first.unmount();

    const second = renderHook(() => useAppData<{ count: number }>("/api/app/today"));
    await waitFor(() => expect(second.result.current.error).toBe("You are not signed in."));
    expect(second.result.current.data).toBeNull();
    second.unmount();

    // Nothing left to paint from.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const third = renderHook(() => useAppData<{ count: number }>("/api/app/today"));
    expect(third.result.current.data).toBeNull();
    expect(third.result.current.loading).toBe(true);
  });

  // Bounded on purpose: the freshness stamp reads mirror age out of the
  // payload, so an overnight cache would paint yesterday's jobs under a
  // heading that says Today, blaming the cron for a stale cache.
  it("ignores a payload older than the freshness window", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { count: 7 } })));

      const first = renderHook(() => useAppData<{ count: number }>("/api/app/today"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(first.result.current.data).toEqual({ count: 7 });
      first.unmount();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60_000);
      });

      const stale = renderHook(() => useAppData<{ count: number }>("/api/app/today"));
      expect(stale.result.current.data).toBeNull();
      expect(stale.result.current.loading).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
