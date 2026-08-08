import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import MoneyPage from "../page";
import { clearAppDataCache } from "@/components/mobile/useAppData";

// useAppData holds payloads in module state so a reopened tab paints instantly.
// That state outlives a render, so each case here starts from an empty cache --
// otherwise a test asserting the first-load view inherits the previous test's
// data and sees a fully populated screen.
beforeEach(() => clearAppDataCache());

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

// Filtering runs in the browser over the payload the screen already has, so
// these exercise the real controls rather than a query parameter.
describe("MoneyPage filtering", () => {
  const MANY = {
    estimates: [
      { id: "e1", customerId: "c1", customerName: "Margaret Kowalski", amountCents: 100_000, status: "Scheduled" },
      { id: "e2", customerId: "c2", customerName: "Peter Nowak", amountCents: 50_000, status: "In Progress" },
      { id: "e3", customerId: "c3", customerName: "Ruiz Property Group", amountCents: 25_000, status: "Scheduled" },
    ],
    estimatesTotalCents: 175_000,
    invoices: [
      { id: "i1", customerId: "c1", customerName: "Margaret Kowalski", amountCents: 40_000, status: "open", dueDate: "2026-07-01", overdueDays: 37 },
      { id: "i2", customerId: "c2", customerName: "Peter Nowak", amountCents: 60_000, status: "open", dueDate: "2026-09-01", overdueDays: null },
    ],
    invoicesTotalCents: 100_000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearAppDataCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: MANY, ...FRESH }))
    );
  });

  async function ready() {
    render(<MoneyPage />);
    await screen.findByText("Margaret Kowalski");
  }

  it("narrows the list by customer", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText("Search by customer"), { target: { value: "ruiz" } });

    expect(screen.getByText("Ruiz Property Group")).toBeInTheDocument();
    expect(screen.queryByText("Margaret Kowalski")).not.toBeInTheDocument();
  });

  // The figure is what people read. A filtered list under an unfiltered total
  // is the screen saying two different things at once.
  it("recomputes the headline figure from the visible rows", async () => {
    await ready();
    expect(screen.getByText("$1,750")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search by customer"), { target: { value: "ruiz" } });
    // Twice on purpose: the headline figure and the single row it is now the
    // sum of. Before this, the figure would still have read $1,750 over one
    // $250 row.
    expect(screen.getAllByText("$250")).toHaveLength(2);
    expect(screen.getByText(/1 of 3 estimates/i)).toBeInTheDocument();
    expect(screen.queryByText("$1,750")).not.toBeInTheDocument();
  });

  it("filters estimates by their status", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "In Progress" } });

    expect(screen.getByText("Peter Nowak")).toBeInTheDocument();
    expect(screen.queryByText("Ruiz Property Group")).not.toBeInTheDocument();
  });

  // Only statuses actually present are offered -- a filter that can only
  // return nothing wastes a tap and reads as a bug.
  it("offers only the statuses the estimates actually carry", async () => {
    await ready();
    const options = Array.from(
      screen.getByLabelText("Filter by status").querySelectorAll("option")
    ).map((o) => o.textContent);
    expect(options).toEqual(["All statuses", "Scheduled", "In Progress"]);
  });

  it("keeps only late invoices behind the overdue toggle", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /estimates/i }).parentElement!.querySelectorAll("button")[1]);
    await screen.findByRole("button", { name: /overdue only/i });

    fireEvent.click(screen.getByRole("button", { name: /overdue only/i }));
    expect(screen.getByText("Margaret Kowalski")).toBeInTheDocument();
    expect(screen.queryByText("Peter Nowak")).not.toBeInTheDocument();
    // Unpaid and overdue are different debts, and the label has to say which.
    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });

  // "Every invoice is settled" is very good news; "your filter matched
  // nothing" is not news at all. Showing the first when it means the second
  // tells the owner their debts are paid.
  it("does not claim everything is settled when a filter simply matched nothing", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText("Search by customer"), {
      target: { value: "nobody at all" },
    });

    expect(screen.getByText(/nothing matches those filters/i)).toBeInTheDocument();
    expect(screen.queryByText(/no estimates are waiting/i)).not.toBeInTheDocument();
  });

  it("puts the whole list back from the empty state", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText("Search by customer"), {
      target: { value: "nobody at all" },
    });
    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));

    expect(screen.getByText("Margaret Kowalski")).toBeInTheDocument();
    expect(screen.getByText("$1,750")).toBeInTheDocument();
  });
});

// "$0 overdue" over a search that found nobody is a claim about the debt, not
// about the search -- and it is a false one while five overdue invoices exist.
describe("MoneyPage headline figure with no matches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAppDataCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: PAYLOAD, ...FRESH })));
  });

  it("shows no figure at all rather than a zero one", async () => {
    render(<MoneyPage />);
    await screen.findByText("Margaret Kowalski");

    fireEvent.change(screen.getByLabelText("Search by customer"), {
      target: { value: "nobody at all" },
    });

    expect(screen.getByText(/nothing matches those filters/i)).toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
    expect(screen.queryByText(/awaiting a response/i)).not.toBeInTheDocument();
  });
});
