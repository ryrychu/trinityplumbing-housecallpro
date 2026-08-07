import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BackLink } from "../BackLink";
import { recordNavigation, resetNavigationDepth, canGoBack } from "../navigationHistory";

const backMock = vi.fn();

beforeEach(() => {
  // history.back() is a no-op in jsdom; spying on it is how the two branches
  // are told apart. No next/navigation mock is needed, which is the point of
  // using it instead of router.back() — see the note on BackLink.
  vi.spyOn(window.history, "back").mockImplementation(backMock);
});

describe("navigationHistory", () => {
  beforeEach(() => resetNavigationDepth());

  // The whole point of counting in module scope: a fresh load means a fresh
  // module, and "nothing behind this screen" is then the literal truth rather
  // than a guess from window.history.length.
  it("reports no history on a cold load", () => {
    expect(canGoBack()).toBe(false);
  });

  it("reports history once the reader has moved between screens", () => {
    recordNavigation();
    expect(canGoBack()).toBe(true);
  });
});

describe("BackLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNavigationDepth();
  });

  it("is a real link to the fallback, so it works before any JS runs", () => {
    render(<BackLink fallback="/app/today" />);
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/app/today");
  });

  // Opened cold -- a shared link, a notification, the installed app launching
  // straight onto a job -- there is nothing to go back to, and router.back()
  // would walk the reader out of the app.
  it("navigates to the fallback when nothing precedes this screen", () => {
    render(<BackLink fallback="/app/today" />);
    // fireEvent.click returns false when the handler called preventDefault.
    const notPrevented = fireEvent.click(screen.getByRole("link", { name: "Back" }));
    expect(backMock).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  // Reached from inside the app, back must return to wherever the reader came
  // from -- Schedule, Customers, Dispatch -- not to the one tab the old
  // hardcoded href always pointed at.
  it("walks history back when the reader arrived from another screen", () => {
    recordNavigation();
    render(<BackLink fallback="/app/today" />);
    const notPrevented = fireEvent.click(screen.getByRole("link", { name: "Back" }));
    expect(backMock).toHaveBeenCalledTimes(1);
    // Prevented, so the anchor does not also navigate to the fallback.
    expect(notPrevented).toBe(false);
  });

  it("takes a custom label for screen readers", () => {
    render(<BackLink fallback="/app/customers" label="Back to customers" />);
    expect(screen.getByRole("link", { name: "Back to customers" })).toBeInTheDocument();
  });
});
