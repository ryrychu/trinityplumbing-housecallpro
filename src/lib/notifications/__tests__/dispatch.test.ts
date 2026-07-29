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
