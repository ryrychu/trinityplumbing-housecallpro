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

  it("says 'just now' under a minute", () => {
    render(<FreshnessStamp generatedAt="2026-08-06T13:59:30Z" fromCache={false} />);
    expect(screen.getByText(/just now/i)).toBeInTheDocument();
  });

  it("counts whole minutes", () => {
    render(<FreshnessStamp generatedAt="2026-08-06T13:48:00Z" fromCache={false} />);
    expect(screen.getByText(/12 min ago/i)).toBeInTheDocument();
  });

  // The whole point of the feature: offline must be stated, not implied by
  // data that merely looks normal.
  it("says so plainly when the data came from cache while offline", () => {
    render(<FreshnessStamp generatedAt="2026-08-06T12:42:00Z" fromCache />);
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
  });

  it("renders nothing before the first successful load", () => {
    const { container } = render(<FreshnessStamp generatedAt={null} fromCache={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
