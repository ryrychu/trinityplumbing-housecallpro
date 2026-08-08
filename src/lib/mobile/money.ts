import { getSupabaseServerClient } from "@/lib/supabase/client";
import { isOpenEstimate, scheduleStatus } from "@/lib/dashboard/queries";
import { localDateKey } from "@/lib/notifications/schedule";

export interface EstimateHit {
  id: string;
  // Null when the estimate carries no customer, OR when that customer is not
  // in the mirror. These rows link to /app/customers/<id>, and a link built
  // from an id the customers table does not hold is a dead end — so an
  // unresolvable customer renders as plain text rather than a link that 404s.
  customerId: string | null;
  customerName: string | null;
  amountCents: number | null;
  /**
   * A display label from scheduleStatus() — "Scheduled", "In Progress",
   * "Completed", "Needs Scheduling" — never HCP's raw lowercase enum. Null for
   * a work_status scheduleStatus does not recognise, which the screen renders
   * as "Awaiting a response" rather than inventing a label.
   */
  status: string | null;
}

export interface InvoiceHit {
  id: string;
  /** Null when unresolvable — see the note on EstimateHit.customerId. */
  customerId: string | null;
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
      customerId: e.customer_id && names.has(e.customer_id) ? e.customer_id : null,
      customerName: e.customer_id ? names.get(e.customer_id) ?? null : null,
      amountCents: e.amount_cents,
      // Through scheduleStatus(), not echoed raw. `estimates.status` holds
      // HCP's work_status, and HCP lowercases its enum -- so this screen was
      // rendering "in progress" and "complete unrated" among title-cased
      // labels everywhere else in the app. queries.ts already predicted this
      // exact noise; the fix is to reuse the one mapping rather than add a
      // second, which is also what keeps the vocabulary identical to the run
      // sheet and the job screen.
      status: scheduleStatus({ work_status: e.status }),
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

// due_date is a pure YYYY-MM-DD calendar date (src/lib/sync/mappers.ts slices
// HCP's due_at to 10 chars). Overdue must be counted in *calendar* days, not
// by diffing raw instants: parsing due_date as T00:00:00Z and comparing
// against `now`'s UTC milliseconds (the earlier version of this function)
// puts the day boundary 4-5 hours off America/New_York midnight, so an
// invoice could flip overdue up to a day early or late depending on the time
// of day the request runs. Converting both sides to a UTC-midnight timestamp
// of their calendar date ONLY -- never a wall-clock instant -- makes the diff
// an exact whole number of days, so DST cannot enter the arithmetic at all.
// Same rule dayRange/localParts (src/lib/dashboard/queries.ts, week.ts) apply
// to job scheduling.
function utcMidnightOfDateKey(dateKey: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export async function listUnpaidInvoices(now: Date = new Date()): Promise<InvoiceHit[]> {
  const [rows, names] = await Promise.all([
    fetchAll<InvoiceRow>("invoices", "id, customer_id, status, amount_cents, due_date"),
    customerNames(),
  ]);

  // localDateKey always returns a well-formed YYYY-MM-DD, so this is never null.
  const todayUtcMs = utcMidnightOfDateKey(localDateKey(now))!;

  return rows
    .filter((i) => (i.status ?? "").toLowerCase() === INVOICE_UNPAID)
    .map((i) => {
      const dueUtcMs = i.due_date ? utcMidnightOfDateKey(i.due_date) : null;
      const days = dueUtcMs == null ? null : Math.round((todayUtcMs - dueUtcMs) / DAY_MS);
      return {
        id: i.id,
        customerId: i.customer_id && names.has(i.customer_id) ? i.customer_id : null,
        customerName: i.customer_id ? names.get(i.customer_id) ?? null : null,
        amountCents: i.amount_cents,
        status: i.status,
        dueDate: i.due_date,
        overdueDays: days != null && days > 0 ? days : null,
      };
    })
    .sort((a, b) => (b.overdueDays ?? -1) - (a.overdueDays ?? -1));
}
