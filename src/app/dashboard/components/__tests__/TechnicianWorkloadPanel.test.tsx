import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TechnicianWorkloadPanel } from "../TechnicianWorkloadPanel";

describe("TechnicianWorkloadPanel", () => {
  it("renders a technician row with combined job count and hours", () => {
    render(
      <TechnicianWorkloadPanel
        rows={[{ technicianId: "t1", technicianName: "Sam Tech", jobCount: 3, scheduledHours: 6.5 }]}
      />
    );
    expect(screen.getByText("Sam Tech")).toBeInTheDocument();
    expect(screen.getByText(/3 jobs · 6\.5h/)).toBeInTheDocument();
  });

  it("labels the unassigned bucket", () => {
    render(
      <TechnicianWorkloadPanel
        rows={[{ technicianId: null, technicianName: "Unassigned", jobCount: 1, scheduledHours: 2 }]}
      />
    );
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("renders the empty state when there are no rows", () => {
    render(<TechnicianWorkloadPanel rows={[]} />);
    expect(screen.getByText("No assigned work today.")).toBeInTheDocument();
  });

  it("does not divide by zero when every tech has zero scheduled hours", () => {
    render(
      <TechnicianWorkloadPanel
        rows={[{ technicianId: "t1", technicianName: "Idle Tech", jobCount: 0, scheduledHours: 0 }]}
      />
    );
    expect(screen.getByText("Idle Tech")).toBeInTheDocument();
    expect(screen.getByText(/0 jobs · 0h/)).toBeInTheDocument();
  });
});
