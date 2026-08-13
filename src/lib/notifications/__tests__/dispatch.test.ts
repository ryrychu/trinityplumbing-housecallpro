import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/slack/client", () => ({
  postSlack: vi.fn().mockResolvedValue(true),
  slackAlertsEnabled: vi.fn().mockReturnValue(true),
}));
vi.mock("../dedupe", () => ({ claimMany: vi.fn() }));

import { postSlack, slackAlertsEnabled } from "@/lib/slack/client";
import { claimMany } from "../dedupe";
import { notifyPaidInvoices, notifyApprovedEstimates } from "../dispatch";

const supabase = {} as SupabaseClient;
const paid = (id: string) => ({
  id,
  status: "paid",
  amount: 1000,
  invoice_number: id,
  customer: { first_name: "A", last_name: "B" },
});

// A Supabase stand-in backed by plain arrays, recording every `.in()` lookup in
// order. The name resolution under test walks two tables (jobs -> customers),
// so a single-table mock can no longer express what should happen.
function fakeSupabase(tables: Record<string, Array<Record<string, unknown>>>) {
  const calls: Array<{ table: string; column: string; ids: string[] }> = [];
  const client = {
    from: (table: string) => ({
      select: () => ({
        in: (column: string, ids: string[]) => {
          calls.push({ table, column, ids });
          return Promise.resolve({
            data: (tables[table] ?? []).filter((r) => ids.includes(r[column] as string)),
            error: null,
          });
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("notifyPaidInvoices", () => {
  beforeEach(() => {
    vi.mocked(slackAlertsEnabled).mockReturnValue(true);
    vi.mocked(postSlack).mockClear().mockResolvedValue(true);
    vi.mocked(claimMany).mockReset();
    process.env.SLACK_WEBHOOK_INVOICES = "https://hooks.slack.com/services/INV";
  });
  afterEach(() => {
    delete process.env.SLACK_WEBHOOK_INVOICES;
  });

  it("posts ONE batched message for all newly claimed invoices", async () => {
    vi.mocked(claimMany).mockResolvedValue(["inv_1", "inv_2"]);

    const posted = await notifyPaidInvoices(supabase, [paid("inv_1"), paid("inv_2")]);

    expect(posted).toBe(2);
    expect(postSlack).toHaveBeenCalledOnce();
    const [url, text] = vi.mocked(postSlack).mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/INV");
    expect(text).toContain("2 invoices paid");
  });

  it("posts nothing when every invoice was already claimed", async () => {
    vi.mocked(claimMany).mockResolvedValue([]);
    expect(await notifyPaidInvoices(supabase, [paid("inv_1")])).toBe(0);
    expect(postSlack).not.toHaveBeenCalled();
  });

  it("posts only the subset that was newly claimed", async () => {
    vi.mocked(claimMany).mockResolvedValue(["inv_2"]);
    await notifyPaidInvoices(supabase, [paid("inv_1"), paid("inv_2")]);
    const text = vi.mocked(postSlack).mock.calls[0][1];
    expect(text).toContain("1 invoice paid");
    expect(text).toContain("#inv_2");
    expect(text).not.toContain("#inv_1");
  });

  it("claims nothing and posts nothing when the kill switch is off", async () => {
    vi.mocked(slackAlertsEnabled).mockReturnValue(false);
    expect(await notifyPaidInvoices(supabase, [paid("inv_1")])).toBe(0);
    expect(claimMany).not.toHaveBeenCalled();
    expect(postSlack).not.toHaveBeenCalled();
  });

  it("skips the whole pass when no paid invoice is present", async () => {
    expect(await notifyPaidInvoices(supabase, [{ id: "x", status: "open" }])).toBe(0);
    expect(claimMany).not.toHaveBeenCalled();
  });

  // I4: HcpInvoice.customer is typed (and, per the live-payload uncertainty
  // this finding raised, may in reality be) `{ id }` only — no nested name.
  // Without a fallback, every line in this channel would read "Unknown
  // customer", defeating the channel's whole purpose. detect.ts stays pure
  // (no DB access), so the fallback — resolving the name from the
  // already-synced local `customers` table by customer_id — lives here.
  it("resolves a real customer name from the local customers table when the invoice carries only a customer id", async () => {
    vi.mocked(claimMany).mockResolvedValue(["inv_9"]);
    const inMock = vi.fn().mockResolvedValue({
      data: [{ id: "cus_only_id", first_name: "Priya", last_name: "Nair", company: null }],
      error: null,
    });
    const selectMock = vi.fn().mockReturnValue({ in: inMock });
    const fromMock = vi.fn().mockReturnValue({ select: selectMock });
    const localSupabase = { from: fromMock } as unknown as SupabaseClient;

    const invoiceWithIdOnlyCustomer = {
      id: "inv_9",
      status: "paid",
      amount: 5000,
      invoice_number: "9001",
      customer: { id: "cus_only_id" }, // no first_name/last_name/company
    };

    await notifyPaidInvoices(localSupabase, [invoiceWithIdOnlyCustomer]);

    expect(fromMock).toHaveBeenCalledWith("customers");
    expect(inMock).toHaveBeenCalledWith("id", ["cus_only_id"]);
    const text = vi.mocked(postSlack).mock.calls[0][1];
    expect(text).toContain("Priya Nair");
    expect(text).not.toContain("Unknown customer");
  });

  // The bug Trinity actually saw: fourteen consecutive lines reading "Unknown
  // customer". A live invoice carries no `customer` at all — not even an id —
  // so the customer-id fallback above had nothing to work with and every line
  // fell through to the placeholder. `job_id` is the link the payload does
  // carry, so resolution walks job_id -> jobs.customer_id -> customers.
  it("resolves the name through job_id when the invoice carries no customer at all", async () => {
    vi.mocked(claimMany).mockResolvedValue(["inv_live"]);
    const { client, calls } = fakeSupabase({
      jobs: [{ id: "job_a955", customer_id: "cus_7" }],
      customers: [{ id: "cus_7", first_name: "Devon", last_name: "Robinson", company: null }],
    });

    await notifyPaidInvoices(client, [
      {
        id: "inv_live",
        status: "paid",
        amount: 29592,
        invoice_number: "5143",
        job_id: "job_a955",
        paid_at: "2026-08-13T02:41:00Z",
      },
    ]);

    expect(calls).toEqual([
      { table: "jobs", column: "id", ids: ["job_a955"] },
      { table: "customers", column: "id", ids: ["cus_7"] },
    ]);
    const text = vi.mocked(postSlack).mock.calls[0][1];
    expect(text).toContain("Devon Robinson");
    expect(text).not.toContain("Unknown customer");
  });

  it("falls back to the company name when the job's customer has no person name", async () => {
    vi.mocked(claimMany).mockResolvedValue(["inv_co"]);
    const { client } = fakeSupabase({
      jobs: [{ id: "job_b", customer_id: "cus_co" }],
      customers: [{ id: "cus_co", first_name: null, last_name: null, company: "Averill Park Diner" }],
    });

    await notifyPaidInvoices(client, [
      { id: "inv_co", status: "paid", amount: 5000, invoice_number: "5144", job_id: "job_b" },
    ]);

    expect(vi.mocked(postSlack).mock.calls[0][1]).toContain("Averill Park Diner");
  });

  it("issues one jobs lookup and one customers lookup for a whole batch, deduped", async () => {
    vi.mocked(claimMany).mockResolvedValue(["i1", "i2", "i3"]);
    const { client, calls } = fakeSupabase({
      jobs: [
        { id: "job_1", customer_id: "cus_1" },
        { id: "job_2", customer_id: "cus_1" }, // same customer, two jobs
      ],
      customers: [{ id: "cus_1", first_name: "Dana", last_name: "Reyes", company: null }],
    });

    await notifyPaidInvoices(client, [
      { id: "i1", status: "paid", amount: 100, job_id: "job_1" },
      { id: "i2", status: "paid", amount: 200, job_id: "job_2" },
      { id: "i3", status: "paid", amount: 300, job_id: "job_1" }, // repeat job
    ]);

    expect(calls).toEqual([
      { table: "jobs", column: "id", ids: ["job_1", "job_2"] },
      { table: "customers", column: "id", ids: ["cus_1"] },
    ]);
  });

  it("still renders the batch when the job is not in the mirror yet", async () => {
    vi.mocked(claimMany).mockResolvedValue(["inv_orphan"]);
    const { client } = fakeSupabase({ jobs: [], customers: [] });

    await notifyPaidInvoices(client, [
      { id: "inv_orphan", status: "paid", amount: 4200, invoice_number: "5150", job_id: "job_missing" },
    ]);

    const text = vi.mocked(postSlack).mock.calls[0][1];
    expect(text).toContain("Unknown customer"); // honest, not a crash
    expect(text).toContain("$42.00");
  });

  it("never queries jobs when the invoice already carries a resolvable customer id", async () => {
    vi.mocked(claimMany).mockResolvedValue(["inv_9"]);
    const { client, calls } = fakeSupabase({
      customers: [{ id: "cus_only_id", first_name: "Priya", last_name: "Nair", company: null }],
    });

    await notifyPaidInvoices(client, [
      { id: "inv_9", status: "paid", amount: 5000, customer: { id: "cus_only_id" }, job_id: "job_x" },
    ]);

    expect(calls.map((c) => c.table)).toEqual(["customers"]);
  });

  // The whole bug, end to end, from the payload shape production actually
  // sends to the finished Slack text. Reported 2026-08-13: three consecutive
  // messages, fourteen lines, every one of them "Unknown customer" and no
  // indication of when the money arrived. If this assertion ever reverts to
  // placeholders, the channel is back to being unreadable.
  it("renders the reported message with real names and payment times", async () => {
    vi.mocked(claimMany).mockResolvedValue(["inv_5143", "inv_5133"]);
    const { client } = fakeSupabase({
      jobs: [
        { id: "job_5143", customer_id: "cus_devon" },
        { id: "job_5133", customer_id: "cus_diner" },
      ],
      customers: [
        { id: "cus_devon", first_name: "Devon", last_name: "Robinson", company: null },
        { id: "cus_diner", first_name: null, last_name: null, company: "Averill Park Diner" },
      ],
    });

    // Exactly the live key set — note the absence of any `customer`.
    await notifyPaidInvoices(client, [
      {
        id: "inv_5143",
        status: "paid",
        amount: 29592,
        invoice_number: "5143",
        job_id: "job_5143",
        paid_at: "2026-08-13T02:41:00Z",
        invoice_date: "2026-08-12",
        service_date: "2026-08-12",
      },
      {
        id: "inv_5133",
        status: "paid",
        amount: 1075000,
        invoice_number: "5133",
        job_id: "job_5133",
        paid_at: "2026-08-12T20:02:00Z",
        invoice_date: "2026-08-10",
        service_date: "2026-08-10",
      },
    ]);

    expect(vi.mocked(postSlack).mock.calls[0][1]).toBe(
      [
        "*2 invoices paid*",
        "• Devon Robinson — $295.92 #5143  ·  Aug 12, 10:41 PM",
        "• Averill Park Diner — $10,750.00 #5133  ·  Aug 12, 4:02 PM",
      ].join("\n")
    );
  });

  it("does not query the customers table when every invoice already has a name", async () => {
    vi.mocked(claimMany).mockResolvedValue(["inv_1"]);
    const fromMock = vi.fn();
    const localSupabase = { from: fromMock } as unknown as SupabaseClient;

    await notifyPaidInvoices(localSupabase, [paid("inv_1")]);

    expect(fromMock).not.toHaveBeenCalled();
  });
});

const approved = (estimateId: string, optionId: string) => ({
  id: estimateId,
  customer: { first_name: "A", last_name: "B" },
  options: [
    {
      id: optionId,
      name: "Option " + optionId,
      approval_status: "approved",
      total_amount: 5000,
    },
  ],
});

describe("notifyApprovedEstimates", () => {
  beforeEach(() => {
    vi.mocked(slackAlertsEnabled).mockReturnValue(true);
    vi.mocked(postSlack).mockClear().mockResolvedValue(true);
    vi.mocked(claimMany).mockReset();
    process.env.SLACK_WEBHOOK_ESTIMATES = "https://hooks.slack.com/services/EST";
  });
  afterEach(() => {
    delete process.env.SLACK_WEBHOOK_ESTIMATES;
  });

  it("posts ONE batched message for all newly claimed estimates", async () => {
    vi.mocked(claimMany).mockResolvedValue(["est_1:opt_1", "est_2:opt_1"]);

    const posted = await notifyApprovedEstimates(supabase, [
      approved("est_1", "opt_1"),
      approved("est_2", "opt_1"),
    ]);

    expect(posted).toBe(2);
    expect(postSlack).toHaveBeenCalledOnce();
    const [url, text] = vi.mocked(postSlack).mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/EST");
    expect(text).toContain("2 estimates approved");
  });

  it("posts nothing when every estimate option was already claimed", async () => {
    vi.mocked(claimMany).mockResolvedValue([]);
    expect(await notifyApprovedEstimates(supabase, [approved("est_1", "opt_1")])).toBe(0);
    expect(postSlack).not.toHaveBeenCalled();
  });

  it("posts only the subset that was newly claimed, keyed by estimateId:optionId", async () => {
    vi.mocked(claimMany).mockResolvedValue(["est_2:opt_1"]);
    await notifyApprovedEstimates(supabase, [
      approved("est_1", "opt_1"),
      approved("est_2", "opt_1"),
    ]);
    expect(claimMany).toHaveBeenCalledWith(
      supabase,
      "estimate_approved",
      ["est_1:opt_1", "est_2:opt_1"]
    );
    const text = vi.mocked(postSlack).mock.calls[0][1];
    expect(text).toContain("1 estimate approved");
    expect(text).toContain("Option opt_1");
  });

  it("claims nothing and posts nothing when the kill switch is off", async () => {
    vi.mocked(slackAlertsEnabled).mockReturnValue(false);
    expect(await notifyApprovedEstimates(supabase, [approved("est_1", "opt_1")])).toBe(0);
    expect(claimMany).not.toHaveBeenCalled();
    expect(postSlack).not.toHaveBeenCalled();
  });

  it("skips the whole pass when no approved estimate option is present", async () => {
    expect(
      await notifyApprovedEstimates(supabase, [
        { id: "est_1", options: [{ id: "opt_1", approval_status: "pending" }] },
      ])
    ).toBe(0);
    expect(claimMany).not.toHaveBeenCalled();
  });
});
