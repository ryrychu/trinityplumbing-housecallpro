import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetricCard } from "../components/MetricCard";

describe("MetricCard", () => {
  it("renders a label and value", () => {
    render(<MetricCard label="Jobs in Progress" value={4} />);
    expect(screen.getByText("Jobs in Progress")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("applies an emphasis style when highlight is true", () => {
    render(<MetricCard label="Emergency Calls" value={2} highlight />);
    const value = screen.getByText("2");
    expect(value.className).toContain("highlight");
  });
});
