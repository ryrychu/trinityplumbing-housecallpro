import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CustomerPage from "../page";

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
      // Live HCP string, not a display label -- see the customers.ts fixture
      // rules in the plan's Global Constraints.
      status: "complete rated",
      amountCents: 145_000,
    },
  ],
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
        jsonResponse({ data: CUSTOMER, generated_at: new Date().toISOString() })
      )
    );

    render(<CustomerPage params={{ id: "cus_1" }} />);

    expect(await screen.findByText("Margaret Kowalski")).toBeInTheDocument();
    expect(screen.getByText(/just now|min ago/i)).toBeInTheDocument();
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
