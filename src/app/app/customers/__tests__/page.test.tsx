import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import CustomersPage from "../page";

function jsonResponse(hits: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ data: { hits } }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("CustomersPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Typing "sm" then "smith" before the first request returns fires two
  // fetches. clearTimeout on the debounce timer only stops a *pending*
  // timer -- it does nothing once the callback has already fired and the
  // fetch is in flight. If the "sm" response happens to arrive after the
  // "smith" response, its setHits call must not be allowed to overwrite the
  // newer, correct results with results for a query no longer on screen.
  it("ignores a slow, stale response that resolves after a newer query's response", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(<CustomersPage />);
    const input = screen.getByPlaceholderText("Name, phone or address");

    fireEvent.change(input, { target: { value: "sm" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    fireEvent.change(input, { target: { value: "smith" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The newer request ("smith") resolves first.
    await act(async () => {
      second.resolve(jsonResponse([{ id: "cus_2", name: "John Smith", phone: null, address: null }]));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stale request ("sm") resolves after -- it must be discarded.
    await act(async () => {
      first.resolve(jsonResponse([{ id: "cus_1", name: "Sam Old", phone: null, address: null }]));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("John Smith")).toBeInTheDocument();
    expect(screen.queryByText("Sam Old")).not.toBeInTheDocument();
  });
});
