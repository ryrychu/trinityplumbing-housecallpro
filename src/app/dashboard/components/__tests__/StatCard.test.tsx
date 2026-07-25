import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatCard } from "../StatCard";

describe("StatCard", () => {
  it("renders label and value", () => {
    render(<StatCard label="Jobs in Progress" value={4} />);
    expect(screen.getByText("Jobs in Progress")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("shows an accessible attention icon when tone is danger", () => {
    render(<StatCard label="Emergency Calls" value={2} tone="danger" />);
    expect(screen.getByLabelText("Attention")).toBeInTheDocument();
  });

  it("does not show the attention icon for the default tone", () => {
    render(<StatCard label="Commercial Jobs" value={0} />);
    expect(screen.queryByLabelText("Attention")).not.toBeInTheDocument();
  });

  it("renders an optional caption", () => {
    render(<StatCard label="Open Estimates" value={5} caption="awaiting response" />);
    expect(screen.getByText("awaiting response")).toBeInTheDocument();
  });

  it("renders string values such as formatted currency", () => {
    render(<StatCard label="Revenue Booked" value="$22,441.89" tone="success" />);
    expect(screen.getByText("$22,441.89")).toBeInTheDocument();
  });
});
