import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TodaySchedulePanel } from "../TodaySchedulePanel";

const job = {
  id: "j1",
  scheduledStart: "2026-07-24T14:00:00Z",
  customerName: "Jane Doe",
  technicianName: "Sam Tech",
  zone: "Albany Zone",
  compass: "N",
  miles: 12,
  driveMinutes: 23,
  address: "12 Elm St, Troy",
  service: "Water Heater Repair",
};

describe("TodaySchedulePanel", () => {
  it("renders a job's customer, tech, and zone", () => {
    render(<TodaySchedulePanel jobs={[job]} />);
    // Customer/tech/zone appear once per layout (desktop table + mobile list),
    // so use getAllByText and assert at least one match.
    expect(screen.getAllByText("Jane Doe").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sam Tech").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Albany Zone").length).toBeGreaterThan(0);
  });

  it("falls back to Unassigned when no technician is set", () => {
    render(<TodaySchedulePanel jobs={[{ ...job, technicianName: null }]} />);
    expect(screen.getAllByText("Unassigned").length).toBeGreaterThan(0);
  });

  it("renders the empty state when there are no jobs", () => {
    render(<TodaySchedulePanel jobs={[]} />);
    expect(screen.getByText("No jobs scheduled today.")).toBeInTheDocument();
  });
});
