import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "../StatusPill";

describe("StatusPill", () => {
  // These are scheduleStatus()'s exact output labels. Inventing others here is
  // how the dashboard and this app would start disagreeing.
  it.each([
    ["Scheduled", "text-info"],
    ["En Route", "text-brand"],
    ["In Progress", "text-brand"],
    ["Completed", "text-success"],
    ["Canceled", "text-danger"],
    ["Needs Scheduling", "text-warn"],
  ])("renders %s with its tone", (status, toneClass) => {
    const { container } = render(<StatusPill status={status} />);
    expect(screen.getByText(status)).toBeInTheDocument();
    expect(container.querySelector(`.${toneClass}`)).not.toBeNull();
  });

  // scheduleStatus() returns null for an unmapped HCP status rather than
  // echoing it raw; the pill must not invent a label for that.
  it("renders nothing for a null status", () => {
    const { container } = render(<StatusPill status={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
