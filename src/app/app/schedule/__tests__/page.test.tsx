import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SchedulePage from "../page";

// This screen told the user "No jobs scheduled this week." on first paint,
// before any response had arrived, and showed that same empty state alongside
// the red error banner on a 502. An empty week and an unanswered request must
// never look alike -- one of the two was always a lie.

const PAYLOAD = {
  weekLabel: "Week of Aug 3",
  offset: 0,
  days: [
    {
      dateKey: "2026-08-06",
      label: "Thu",
      rows: [
        {
          id: "job_1",
          scheduledStart: "2026-08-06T12:00:00Z",
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
        },
      ],
    },
  ],
  technicians: [{ id: "tech_1", name: "Dylan" }],
};

const FRESH = {
  generated_at: new Date().toISOString(),
  // 12 minutes behind, well inside the 45-minute jobs threshold: the stamp
  // must date the MIRROR, not the request that just happened.
  mirror_synced_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  stale_after_minutes: 45,
};

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("SchedulePage", () => {
  // The core regression: no claim about the week until the week has loaded.
  it("does not claim the week is empty before anything has loaded", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(<SchedulePage />);

    expect(screen.queryByText(/No jobs scheduled this week/i)).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders the day strip and jobs once loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: PAYLOAD, ...FRESH })
      )
    );

    render(<SchedulePage />);

    expect(await screen.findByText("Margaret Kowalski")).toBeInTheDocument();
    expect(screen.getByText("Thu")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  // A genuinely empty week is a real answer and must still be stated -- the fix
  // is gating on `data`, not deleting the empty state.
  it("still says the week is empty when the server says it is", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: { ...PAYLOAD, days: [{ dateKey: "2026-08-06", label: "Thu", rows: [] }] },
          generated_at: new Date().toISOString(),
        })
      )
    );

    render(<SchedulePage />);

    expect(await screen.findByText(/No jobs scheduled this week/i)).toBeInTheDocument();
  });

  // The second half of the defect: the error banner and the empty state were
  // rendered together, so the screen simultaneously said "this failed" and
  // "there is nothing this week".
  it("shows the error alone on a failure, never alongside an empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ error: "Couldn't load the schedule: boom" }, {}, 502)
      )
    );

    render(<SchedulePage />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't load the schedule/i)
    );
    expect(screen.queryByText(/No jobs scheduled this week/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("states it is offline when the service worker served a cached copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { data: PAYLOAD, generated_at: "2026-08-06T12:42:00Z" },
          { "X-Trinity-Cache": "hit" }
        )
      )
    );

    render(<SchedulePage />);

    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
    expect(screen.getByText("Margaret Kowalski")).toBeInTheDocument();
  });
});
