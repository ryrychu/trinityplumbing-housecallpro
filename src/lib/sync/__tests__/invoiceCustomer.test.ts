import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fillInvoiceCustomerIds } from "../invoiceCustomer";

// Same array-backed stand-in shape the notification tests use: record every
// `.in()` lookup so the "one query per page, deduped" claim is testable.
function fakeSupabase(jobs: Array<{ id: string; customer_id: string | null }>) {
  const calls: string[][] = [];
  const client = {
    from: (table: string) => ({
      select: () => ({
        in: (_column: string, ids: string[]) => {
          expect(table).toBe("jobs");
          calls.push(ids);
          return Promise.resolve({
            data: jobs.filter((j) => ids.includes(j.id)),
            error: null,
          });
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("fillInvoiceCustomerIds", () => {
  it("fills customer_id from the invoice's job", async () => {
    const { client } = fakeSupabase([{ id: "job_a", customer_id: "cus_1" }]);
    const rows = [{ id: "inv_1", job_id: "job_a", customer_id: null }];

    await fillInvoiceCustomerIds(client, rows);

    expect(rows[0].customer_id).toBe("cus_1");
  });

  it("issues ONE deduped lookup for a whole page", async () => {
    const { client, calls } = fakeSupabase([
      { id: "job_a", customer_id: "cus_1" },
      { id: "job_b", customer_id: "cus_2" },
    ]);
    const rows = [
      { id: "inv_1", job_id: "job_a", customer_id: null },
      { id: "inv_2", job_id: "job_b", customer_id: null },
      { id: "inv_3", job_id: "job_a", customer_id: null },
    ];

    await fillInvoiceCustomerIds(client, rows);

    expect(calls).toEqual([["job_a", "job_b"]]);
    expect(rows.map((r) => r.customer_id)).toEqual(["cus_1", "cus_2", "cus_1"]);
  });

  it("never queries when no row needs filling", async () => {
    const { client, calls } = fakeSupabase([{ id: "job_a", customer_id: "cus_1" }]);
    const rows = [
      { id: "inv_1", job_id: null, customer_id: null },
      { id: "inv_2", job_id: "job_a", customer_id: "cus_already" },
    ];

    await fillInvoiceCustomerIds(client, rows);

    expect(calls).toEqual([]);
    expect(rows[1].customer_id).toBe("cus_already");
  });

  it("leaves customer_id null when the job is not mirrored, or carries no customer", async () => {
    const { client } = fakeSupabase([{ id: "job_b", customer_id: null }]);
    const rows = [
      { id: "inv_1", job_id: "job_missing", customer_id: null },
      { id: "inv_2", job_id: "job_b", customer_id: null },
    ];

    await fillInvoiceCustomerIds(client, rows);

    expect(rows.map((r) => r.customer_id)).toEqual([null, null]);
  });

  // This runs inside the sync's per-page loop, immediately before the upsert
  // that keeps the dashboard alive. A jobs lookup that fails must degrade to
  // "no name", never take the invoice sync down with it.
  it("leaves rows untouched and does not throw when the jobs query errors", async () => {
    const client = {
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({ data: null, error: { message: "db down" } }),
        }),
      }),
    } as unknown as SupabaseClient;
    const rows = [{ id: "inv_1", job_id: "job_a", customer_id: null }];

    await expect(fillInvoiceCustomerIds(client, rows)).resolves.toBeUndefined();
    expect(rows[0].customer_id).toBeNull();
  });

  // PostgREST builds `.in()` into the URL, so an unbounded id list on a full
  // ~2.9k-invoice reconcile page would risk a request-line limit. Pages are 50
  // records, but the chunk guard is what makes that safe rather than lucky.
  it("chunks a large id set instead of sending one unbounded query", async () => {
    const jobs = Array.from({ length: 250 }, (_, i) => ({ id: `job_${i}`, customer_id: `cus_${i}` }));
    const { client, calls } = fakeSupabase(jobs);
    const rows = jobs.map((j, i) => ({ id: `inv_${i}`, job_id: j.id, customer_id: null as string | null }));

    await fillInvoiceCustomerIds(client, rows);

    expect(calls.length).toBeGreaterThan(1);
    expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(200);
    expect(rows.map((r) => r.customer_id)).toEqual(jobs.map((j) => j.customer_id));
  });
});
