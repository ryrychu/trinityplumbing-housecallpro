import { getSupabaseServerClient } from "@/lib/supabase/client";
import { isOpenEstimate } from "@/lib/dashboard/queries";

export interface EstimateHit {
  id: string;
  customerName: string | null;
  amountCents: number | null;
  status: string | null;
}

export interface InvoiceHit {
  id: string;
  customerName: string | null;
  amountCents: number | null;
  status: string | null;
  dueDate: string | null;
  overdueDays: number | null;
}

const PAGE_SIZE = 1000;

// Same paging discipline as fetchAllRows in src/lib/dashboard/queries.ts:
// PostgREST truncates at 1000 rows silently, and this account holds ~2.9k
// invoices. A bare select would quietly hide a third of the debt.
async function fetchAll<T>(table: string, columns: string): Promise<T[]> {
  const supabase = getSupabaseServerClient();
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table} query failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

interface CustomerRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
}

async function customerNames(): Promise<Map<string, string>> {
  const rows = await fetchAll<CustomerRow>("customers", "id, first_name, last_name, company");
  return new Map(
    rows.map((c) => [
      c.id,
      [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company || "Unnamed customer",
    ])
  );
}

interface EstimateRow {
  id: string;
  customer_id: string | null;
  status: string | null;
  amount_cents: number | null;
  raw?: { options?: { approval_status?: string | null }[] };
}

export async function listOpenEstimates(): Promise<EstimateHit[]> {
  const [rows, names] = await Promise.all([
    fetchAll<EstimateRow>("estimates", "id, customer_id, status, amount_cents, raw"),
    customerNames(),
  ]);

  return rows
    // The shipped definition of "open", imported rather than copied — the
    // dashboard, the Slack digest and this screen must always agree on it.
    .filter(isOpenEstimate)
    .map((e) => ({
      id: e.id,
      customerName: e.customer_id ? names.get(e.customer_id) ?? null : null,
      amountCents: e.amount_cents,
      status: e.status,
    }))
    .sort((a, b) => (b.amountCents ?? 0) - (a.amountCents ?? 0));
}

// Live statuses: paid 2217 | canceled 570 | voided 42 | open 25. "open" is the
// unpaid state and there is no "pending"; canceled and voided are not debts.
const INVOICE_UNPAID = "open";

interface InvoiceRow {
  id: string;
  customer_id: string | null;
  status: string | null;
  amount_cents: number | null;
  due_date: string | null;
}

const DAY_MS = 86_400_000;

export async function listUnpaidInvoices(now: Date = new Date()): Promise<InvoiceHit[]> {
  const [rows, names] = await Promise.all([
    fetchAll<InvoiceRow>("invoices", "id, customer_id, status, amount_cents, due_date"),
    customerNames(),
  ]);

  return rows
    .filter((i) => (i.status ?? "").toLowerCase() === INVOICE_UNPAID)
    .map((i) => {
      const dueMs = i.due_date ? Date.parse(`${i.due_date}T00:00:00Z`) : NaN;
      const days = Number.isNaN(dueMs) ? null : Math.floor((now.getTime() - dueMs) / DAY_MS);
      return {
        id: i.id,
        customerName: i.customer_id ? names.get(i.customer_id) ?? null : null,
        amountCents: i.amount_cents,
        status: i.status,
        dueDate: i.due_date,
        overdueDays: days != null && days > 0 ? days : null,
      };
    })
    .sort((a, b) => (b.overdueDays ?? -1) - (a.overdueDays ?? -1));
}
