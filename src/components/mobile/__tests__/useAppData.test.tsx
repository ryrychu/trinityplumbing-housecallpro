import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAppData } from "../useAppData";

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("useAppData", () => {
  beforeEach(() => vi.restoreAllMocks());

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
