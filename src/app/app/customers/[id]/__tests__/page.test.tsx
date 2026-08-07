import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CustomerPage from "../page";
import { clearAppDataCache } from "@/components/mobile/useAppData";

// useAppData holds payloads in module state so a reopened tab paints instantly.
// That state outlives a render, so each case here starts from an empty cache --
// otherwise a test asserting the first-load view inherits the previous test's
// data and sees a fully populated screen.
beforeEach(() => clearAppDataCache());

// The second of the two screens a person acts on -- the phone number here is
// tapped to place a call. Same defect as the job screen: useAppData was called
// and generatedAt/fromCache discarded, so a cached copy looked current.

const CUSTOMER = {
  id: "cus_1",
  name: "Margaret Kowalski",
  phone: "5185550142",
  address: "14 Sliter Rd, Averill Park",
  company: null,
  email: null,
  lifetimeCents: 145_000,
  jobs: [
    {
      id: "job_3417",
      scheduledStart: "2026-08-06T12:00:00Z",
      service: "Water Heater Replacement",
      // A scheduleStatus() display label: the route maps work_status before it
      // ever reaches the client, so this is what the page actually receives.
      status: "Completed",
      amountCents: 145_000,
    },
  ],
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

describe("CustomerPage", () => {
  it("says it is loading before the first response lands", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(<CustomerPage params={{ id: "cus_1" }} />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders the customer with a freshness stamp once loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: CUSTOMER, ...FRESH })
      )
    );

    render(<CustomerPage params={{ id: "cus_1" }} />);

    expect(await screen.findByText("Margaret Kowalski")).toBeInTheDocument();
    expect(screen.getByText(/Synced 12 min ago/i)).toBeInTheDocument();
  });

  // History renders the status through StatusPill, the same component every
  // other job surface uses, so one job cannot look like two different things
  // depending on which screen you reached it from.
  it("renders a history status as a pill, not bare text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: CUSTOMER, ...FRESH })
      )
    );

    render(<CustomerPage params={{ id: "cus_1" }} />);

    // Asserted on the label's own element, not merely somewhere in the tree:
    // the lifetime-value figure also carries text-success, so a container-wide
    // query would pass even with the status back to bare text.
    const label = await screen.findByText("Completed");
    expect(label.className).toMatch(/rounded-full/);
    expect(label.className).toMatch(/text-success/);
  });

  it("states it is offline when the service worker served a cached copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { data: CUSTOMER, generated_at: "2026-08-06T12:42:00Z" },
          { "X-Trinity-Cache": "hit" }
        )
      )
    );

    render(<CustomerPage params={{ id: "cus_1" }} />);

    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
    expect(screen.getByText("Margaret Kowalski")).toBeInTheDocument();
  });

  it("surfaces a server error instead of an empty-looking customer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ error: "Couldn't load the customer: boom" }, {}, 502)
      )
    );

    render(<CustomerPage params={{ id: "cus_1" }} />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't load the customer/i)
    );
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});
