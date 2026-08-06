import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const { pathnameMock } = vi.hoisted(() => ({ pathnameMock: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

import { ServiceWorkerRegistrar } from "../ServiceWorkerRegistrar";

describe("ServiceWorkerRegistrar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pathnameMock.mockReturnValue("/app/today");
  });

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
    // Deliberately a plain function, not vi.fn().mockRejectedValue(): vitest
    // instruments a mock's returned promise for its own mock.results
    // bookkeeping, which itself counts as "handling" the rejection as far as
    // Node is concerned -- so a vi.fn() mock here would make this test pass
    // no matter what the component does with the promise. A plain function's
    // rejection is genuinely unhandled unless the component catches it.
    let called = false;
    const register = () => {
      called = true;
      return Promise.reject(new Error("denied"));
    };
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    // Asserting register() was called proves nothing about whether its
    // rejection escaped -- a component that never attaches .catch() would
    // still pass that assertion and then blow up the process. Listen for the
    // real signal: Node flags a promise as unhandled if nothing caught it by
    // the time the microtask queue settles.
    const onUnhandledRejection = vi.fn();
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      render(<ServiceWorkerRegistrar />);
      await waitFor(() => expect(called).toBe(true));
      // Give Node a couple of turns after the mount effect to flag the
      // rejection, if it's going to.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  // src/middleware.ts 307s every signed-out /app/* request to /app/login, so
  // that's the page a first-time visitor's browser actually sits on when the
  // service worker would otherwise install. sw.js's own redirect check is
  // the real fix for what gets cached, but there is no reason to even start
  // an install here.
  it("does not register while sitting on the login page", () => {
    pathnameMock.mockReturnValue("/app/login");
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    render(<ServiceWorkerRegistrar />);

    expect(register).not.toHaveBeenCalled();
  });

  // Signing in is a client-side router.replace() (see
  // src/app/app/login/page.tsx), not a reload -- the /app/** layout that
  // mounts this component never remounts, so registration has to react to
  // the pathname changing rather than only checking once on mount.
  it("registers once navigation moves off the login page", async () => {
    pathnameMock.mockReturnValue("/app/login");
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    const { rerender } = render(<ServiceWorkerRegistrar />);
    expect(register).not.toHaveBeenCalled();

    pathnameMock.mockReturnValue("/app/today");
    rerender(<ServiceWorkerRegistrar />);

    await waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/app/" }));
  });
});
