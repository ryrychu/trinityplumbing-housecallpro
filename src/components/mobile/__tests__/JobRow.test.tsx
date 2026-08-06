import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JobRow } from "../JobRow";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";

const job: TodayScheduleRow = {
  id: "job_3417",
  scheduledStart: "2026-08-06T12:00:00Z", // 8:00a America/New_York
  customerName: "Margaret Kowalski",
  technicianName: "Dylan",
  zone: "Averill Park",
  compass: "",
  miles: 2.1,
  driveMinutes: 4,
  address: "14 Sliter Rd, Averill Park",
  service: "Water Heater Replacement",
  customerPhone: "5185550142",
  status: "In Progress",
  lat: 42.63,
  lng: -73.55,
};

describe("JobRow", () => {
  it("shows time, customer, address and service", () => {
    render(<JobRow job={job} />);
    expect(screen.getByText("Margaret Kowalski")).toBeInTheDocument();
    expect(screen.getByText("14 Sliter Rd, Averill Park")).toBeInTheDocument();
    expect(screen.getByText(/Water Heater Replacement/)).toBeInTheDocument();
  });

  // The server renders in UTC on Vercel. A job at 12:00Z is 8:00a Eastern, and
  // showing "12:00 PM" to a dispatcher would be actively dangerous.
  it("renders the time in America/New_York, not UTC", () => {
    render(<JobRow job={job} />);
    expect(screen.getByText("8:00 AM")).toBeInTheDocument();
  });

  it("links to the job detail screen", () => {
    render(<JobRow job={job} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/app/jobs/job_3417");
  });

  it("copes with a job that has no time, address or service", () => {
    render(<JobRow job={{ ...job, scheduledStart: null, address: null, service: null }} />);
    expect(screen.getByText("Margaret Kowalski")).toBeInTheDocument();
    expect(screen.getByText("Unscheduled")).toBeInTheDocument();
  });
});
