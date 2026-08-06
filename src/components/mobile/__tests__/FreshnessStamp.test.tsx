import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { FreshnessStamp } from "../FreshnessStamp";

const NOW = new Date("2026-08-06T14:00:00Z");

describe("FreshnessStamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  // The stamp's job is to date the DATA, not the HTTP request. A request served
  // in 40ms from a mirror last synced on Tuesday is a fast lie, and
  // generated_at cannot tell those apart -- it is always seconds ago.
  describe("mirror age", () => {
    it("reports how old the mirror is, not how old the request is", () => {
      render(
        <FreshnessStamp
          generatedAt="2026-08-06T13:59:59Z"
          fromCache={false}
          mirrorSyncedAt="2026-08-06T13:48:00Z"
          staleAfterMinutes={45}
        />
      );

      expect(screen.getByText(/Synced 12 min ago/i)).toBeInTheDocument();
      // The request time must not leak into the copy -- that is the number
      // this whole change exists to stop showing.
      expect(screen.queryByText(/just now/i)).not.toBeInTheDocument();
    });

    it("says 'just now' under a minute", () => {
      render(
        <FreshnessStamp
          generatedAt="2026-08-06T14:00:00Z"
          fromCache={false}
          mirrorSyncedAt="2026-08-06T13:59:30Z"
          staleAfterMinutes={45}
        />
      );
      expect(screen.getByText(/Synced just now/i)).toBeInTheDocument();
    });

    it("stays quiet right up to the threshold", () => {
      render(
        <FreshnessStamp
          generatedAt={NOW.toISOString()}
          fromCache={false}
          // Exactly 45 minutes: at the threshold, not past it.
          mirrorSyncedAt="2026-08-06T13:15:00Z"
          staleAfterMinutes={45}
        />
      );

      expect(screen.getByText(/Synced 45 min ago/i)).toBeInTheDocument();
      expect(screen.queryByText(/Sync is behind/i)).not.toBeInTheDocument();
    });

    // Past the route's own threshold something is genuinely wrong upstream --
    // most likely the cron has stopped -- and every number on the screen is
    // older than it looks. That earns an interruption.
    it("warns visibly once the threshold is exceeded", () => {
      render(
        <FreshnessStamp
          generatedAt={NOW.toISOString()}
          fromCache={false}
          mirrorSyncedAt="2026-08-06T10:00:00Z"
          staleAfterMinutes={45}
        />
      );

      const warning = screen.getByText(/Sync is behind/i);
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveTextContent(/4 hr ago/i);
      expect(warning.className).toMatch(/text-warn/);
    });

    // The same age is fine on Money and alarming on Today. One global
    // threshold would either cry wolf on invoices or hide a dead cron on jobs.
    it("treats the same age differently for a route with a longer window", () => {
      render(
        <FreshnessStamp
          generatedAt={NOW.toISOString()}
          fromCache={false}
          mirrorSyncedAt="2026-08-06T10:00:00Z"
          staleAfterMinutes={24 * 60}
        />
      );

      expect(screen.getByText(/Synced 4 hr ago/i)).toBeInTheDocument();
      expect(screen.queryByText(/Sync is behind/i)).not.toBeInTheDocument();
    });
  });

  // The offline path is unchanged on purpose: generated_at IS the right
  // timestamp there, and the only one available. It dates the moment this
  // device last held the data; mirror age is a server-side fact the device
  // cannot re-check while offline.
  describe("offline", () => {
    it("says so plainly when the data came from cache while offline", () => {
      render(<FreshnessStamp generatedAt="2026-08-06T12:42:00Z" fromCache />);
      expect(screen.getByText(/offline/i)).toBeInTheDocument();
    });

    it("keeps the offline wording even when a mirror age is known", () => {
      render(
        <FreshnessStamp
          generatedAt="2026-08-06T12:42:00Z"
          fromCache
          mirrorSyncedAt="2026-08-06T12:40:00Z"
          staleAfterMinutes={45}
        />
      );

      expect(screen.getByText(/offline/i)).toBeInTheDocument();
      expect(screen.queryByText(/Synced/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Sync is behind/i)).not.toBeInTheDocument();
    });
  });

  describe("degrading", () => {
    // sync_cursors empty or unreadable, or a response cached before this
    // contract existed. Falls back to the old wording rather than claiming a
    // freshness that was never established.
    it("falls back to request time when no mirror age is available", () => {
      render(<FreshnessStamp generatedAt="2026-08-06T13:48:00Z" fromCache={false} />);

      expect(screen.getByText(/Updated 12 min ago/i)).toBeInTheDocument();
      expect(screen.queryByText(/Sync is behind/i)).not.toBeInTheDocument();
    });

    // A mirror age with no threshold cannot be judged, so it is reported
    // without a verdict rather than guessed at.
    it("shows the mirror age without a warning when no threshold was sent", () => {
      render(
        <FreshnessStamp
          generatedAt={NOW.toISOString()}
          fromCache={false}
          mirrorSyncedAt="2026-08-05T10:00:00Z"
          staleAfterMinutes={null}
        />
      );

      expect(screen.getByText(/Synced/i)).toBeInTheDocument();
      expect(screen.queryByText(/Sync is behind/i)).not.toBeInTheDocument();
    });

    it("renders nothing before the first successful load", () => {
      const { container } = render(<FreshnessStamp generatedAt={null} fromCache={false} />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
