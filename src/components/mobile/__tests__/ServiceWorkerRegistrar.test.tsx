import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { ServiceWorkerRegistrar } from "../ServiceWorkerRegistrar";

describe("ServiceWorkerRegistrar", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("registers the worker scoped to /app/", async () => {
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    render(<ServiceWorkerRegistrar />);

    await waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/app/" }));
  });

  // Older iOS versions and private browsing have no serviceWorker at all. The
  // app must still work, just without offline support.
  it("does nothing when the browser has no service worker support", () => {
    vi.stubGlobal("navigator", {});
    expect(() => render(<ServiceWorkerRegistrar />)).not.toThrow();
  });

  it("swallows a registration failure rather than breaking the page", async () => {
    const register = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    render(<ServiceWorkerRegistrar />);

    await waitFor(() => expect(register).toHaveBeenCalled());
  });
});
