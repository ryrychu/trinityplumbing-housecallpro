import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import JobPage from "../page";

// The job detail screen is one of the two a person ACTS on -- they tap the
// number to call and the address to drive there. These tests exist because the
// screen originally called useAppData and threw generatedAt/fromCache away, so
// an offline, cached copy rendered as a completely normal-looking page. A
// page-level test covering loading / offline / error is what would have caught
// it; the route-level tests never could, because the defect was entirely in
// which fields the page chose to read.

const JOB = {
  id: "job_3417",
  customerId: "cus_1",
  customerName: "Margaret Kowalski",
  customerPhone: "5185550142",
  scheduledStart: "2026-08-06T12:00:00Z",
  scheduledEnd: "2026-08-06T14:00:00Z",
  address: "14 Sliter Rd, Averill Park",
  technicianName: "Dylan",
  service: "Water Heater Replacement",
  status: "In Progress",
  amountCents: 145_000,
  invoice: null,
  notes: [],
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

describe("JobPage", () => {
  it("says it is loading before the first response lands", () => {
    // A promise that never settles is the honest model of "request in flight".
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(<JobPage params={{ id: "job_3417" }} />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders the job with a freshness stamp once loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: JOB, ...FRESH })
      )
    );

    render(<JobPage params={{ id: "job_3417" }} />);

    expect(await screen.findByText("Margaret Kowalski")).toBeInTheDocument();
    expect(screen.getByText(/Synced 12 min ago/i)).toBeInTheDocument();
  });

  // The defect this whole finding is about: offline, the service worker serves
  // a cached copy tagged X-Trinity-Cache: hit. The page must SAY so, not render
  // a page indistinguishable from live data that someone then drives to.
  it("states it is offline when the service worker served a cached copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { data: JOB, generated_at: "2026-08-06T12:42:00Z" },
          { "X-Trinity-Cache": "hit" }
        )
      )
    );

    render(<JobPage params={{ id: "job_3417" }} />);

    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
    // And it must still show the job -- offline is a caveat on the data, not a
    // reason to withhold it. A tech in a basement still needs the address.
    expect(screen.getByText("14 Sliter Rd, Averill Park")).toBeInTheDocument();
  });

  it("surfaces a server error instead of an empty-looking job", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Couldn't load the job: boom" }, {}, 502))
    );

    render(<JobPage params={{ id: "job_3417" }} />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't load the job/i)
    );
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});
