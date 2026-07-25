import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ZoneBadge } from "../ZoneBadge";

describe("ZoneBadge", () => {
  it("renders the zone name", () => {
    render(<ZoneBadge zone="Albany Zone" />);
    expect(screen.getByText("Albany Zone")).toBeInTheDocument();
  });

  // Every zone classifyZone() can emit must render its text, including the
  // out-of-area bucket the original design omitted.
  it.each([
    "Albany Zone",
    "North Route",
    "Vermont Route",
    "Southern Berkshire Route",
    "Extended Service Area",
    "Outside Service Area",
  ])("renders the known zone %s", (zone) => {
    render(<ZoneBadge zone={zone} />);
    expect(screen.getByText(zone)).toBeInTheDocument();
  });

  it("renders an unknown zone with the neutral fallback (still shows the text)", () => {
    render(<ZoneBadge zone="Somewhere Else" />);
    expect(screen.getByText("Somewhere Else")).toBeInTheDocument();
  });
});
