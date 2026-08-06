import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MoneyPage from "../page";

// Both segments are gated on `data`, so before the fix this screen rendered
// nothing at all under the tab toggle while loading -- a blank panel that reads
// as "no estimates, no invoices" rather than "still loading".

const PAYLOAD = {
  estimates: [
    { id: "est_1", customerName: "Margaret Kowalski", amountCents: 145_000, status: "pending" },
  ],
  estimatesTotalCents: 145_000,
  // Live invoice statuses are paid / canceled / voided / open -- `open` is the
  // unpaid state. There is no `pending` on an invoice.
  invoices: [
    {
      id: "inv_1",
      customerName: "Dale Renner",
      amountCents: 42_000,
      status: "open",
      dueDate: "2026-07-30",
      overdueDays: 7,
    },
  ],
  invoicesTotalCents: 42_000,
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

describe("MoneyPage", () => {
  it("says it is loading rather than rendering a blank panel", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(<MoneyPage />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText(/No estimates are waiting/i)).not.toBeInTheDocument();
  });

  it("renders the estimates segment once loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ data: PAYLOAD, ...FRESH })
      )
    );

    render(<MoneyPage />);

    expect(await screen.findByText("Margaret Kowalski")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    // Dates the mirror, not the request that just completed.
    expect(screen.getByText(/Synced 12 min ago/i)).toBeInTheDocument();
  });

  // Money is the invoice-bearing screen and so carries the long threshold. This
  // is the end-to-end shape of the warning: past the route's OWN window, the
  // screen says so rather than showing a comfortable-looking number.
  it("warns when the mirror is older than this route's threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: PAYLOAD,
          generated_at: new Date().toISOString(),
          mirror_synced_at: new Date(Date.now() - 30 * 3_600_000).toISOString(),
          stale_after_minutes: 24 * 60,
        })
      )
    );

    render(<MoneyPage />);

    expect(await screen.findByText(/Sync is behind/i)).toBeInTheDocument();
    // The data is still shown -- stale is a caveat, not a reason to withhold.
    expect(screen.getByText("Margaret Kowalski")).toBeInTheDocument();
  });

  it("shows the error alone on a failure, never alongside an empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Couldn't load money: boom" }, {}, 502))
    );

    render(<MoneyPage />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't load money/i)
    );
    expect(screen.queryByText(/No estimates are waiting/i)).not.toBeInTheDocument();
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

    render(<MoneyPage />);

    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
    expect(screen.getByText("Margaret Kowalski")).toBeInTheDocument();
  });
});
