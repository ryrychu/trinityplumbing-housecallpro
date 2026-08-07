import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppScrollArea, clearScrollPositions } from "../AppScrollArea";

const { pathnameMock } = vi.hoisted(() => ({ pathnameMock: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

function scrollArea() {
  // The scrolling element is the only div wrapping the content; jsdom has no
  // layout, so scrollTop is whatever was assigned to it.
  return screen.getByTestId("content").parentElement as HTMLElement;
}

describe("AppScrollArea", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearScrollPositions();
  });

  // The bug this exists for: with the shell growing to fit its content, the tab
  // bar went down the page with it and a long screen scrolled it out of reach.
  it("scrolls its own content rather than the page", () => {
    pathnameMock.mockReturnValue("/app/money");
    render(
      <AppScrollArea>
        <div data-testid="content">rows</div>
      </AppScrollArea>
    );
    expect(scrollArea().className).toContain("overflow-y-auto");
    // Without min-h-0 a flex child's automatic minimum size is its content, so
    // it grows instead of scrolling -- which is the bug, not a detail.
    expect(scrollArea().className).toContain("min-h-0");
  });

  it("returns a tab to where it was left", () => {
    pathnameMock.mockReturnValue("/app/today");
    const { rerender } = render(
      <AppScrollArea>
        <div data-testid="content">today</div>
      </AppScrollArea>
    );

    const el = scrollArea();
    el.scrollTop = 420;
    fireEvent.scroll(el);

    // Away to another tab...
    pathnameMock.mockReturnValue("/app/money");
    rerender(
      <AppScrollArea>
        <div data-testid="content">money</div>
      </AppScrollArea>
    );
    expect(scrollArea().scrollTop).toBe(0);

    // ...and back.
    pathnameMock.mockReturnValue("/app/today");
    rerender(
      <AppScrollArea>
        <div data-testid="content">today</div>
      </AppScrollArea>
    );
    expect(scrollArea().scrollTop).toBe(420);
  });

  it("opens a screen it has never shown at the top", () => {
    pathnameMock.mockReturnValue("/app/today");
    const { rerender } = render(
      <AppScrollArea>
        <div data-testid="content">today</div>
      </AppScrollArea>
    );
    const el = scrollArea();
    el.scrollTop = 300;
    fireEvent.scroll(el);

    pathnameMock.mockReturnValue("/app/jobs/job_3417");
    rerender(
      <AppScrollArea>
        <div data-testid="content">job</div>
      </AppScrollArea>
    );
    expect(scrollArea().scrollTop).toBe(0);
  });

  // An offset belongs to the screen being left, never to the one arriving --
  // otherwise restoring a position fires a scroll event that overwrites the
  // destination's saved offset with the source's.
  it("attributes an offset to the screen that produced it", () => {
    pathnameMock.mockReturnValue("/app/today");
    const { rerender } = render(
      <AppScrollArea>
        <div data-testid="content">today</div>
      </AppScrollArea>
    );
    const el = scrollArea();
    el.scrollTop = 200;
    fireEvent.scroll(el);

    pathnameMock.mockReturnValue("/app/schedule");
    rerender(
      <AppScrollArea>
        <div data-testid="content">schedule</div>
      </AppScrollArea>
    );
    scrollArea().scrollTop = 50;
    fireEvent.scroll(scrollArea());

    pathnameMock.mockReturnValue("/app/today");
    rerender(
      <AppScrollArea>
        <div data-testid="content">today</div>
      </AppScrollArea>
    );
    expect(scrollArea().scrollTop).toBe(200);
  });
});
