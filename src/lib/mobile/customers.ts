import { getSupabaseServerClient } from "@/lib/supabase/client";
import { normalizePhone } from "./phone";

export interface CustomerHit {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
}

export interface CustomerDetail extends CustomerHit {
  company: string | null;
  email: string | null;
  lifetimeCents: number;
  jobs: {
    id: string;
    scheduledStart: string | null;
    service: string | null;
    status: string | null;
    amountCents: number | null;
  }[];
}

const DEFAULT_LIMIT = 25;

// PostgREST's or() takes a comma-separated filter list, so a comma, parenthesis
// or asterisk in user input would change the query's meaning rather than being
// searched for. Strip them instead of escaping — none are meaningful in a name,
// address or phone number.
function sanitize(term: string): string {
  return term.replace(/[,()*"\\]/g, " ").trim();
}

export async function searchCustomers(query: string, limit = DEFAULT_LIMIT): Promise<CustomerHit[]> {
  const term = sanitize(query);
  // A blank query must not become "select everything" — that is 1,497 rows and
  // a pointless round trip on every keystroke before the user has typed.
  if (!term) return [];

  const digits = normalizePhone(term);
  const textCols = ["first_name", "last_name", "company", "address_line1", "city"];
  const filters = textCols.map((c) => `${c}.ilike.%${term}%`);
  if (digits.length >= 3) filters.push(`phone.ilike.%${digits}%`);

  const { data, error } = await getSupabaseServerClient()
    .from("customers")
    .select("id, first_name, last_name, company, phone, address_line1, city")
    .or(filters.join(","))
    .limit(limit);

  if (error) throw new Error(`customer search failed: ${error.message}`);

  return (data ?? []).map(toHit);
}

interface CustomerRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  email?: string | null;
}

function toHit(c: CustomerRow): CustomerHit {
  return {
    id: c.id,
    name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company || "Unnamed customer",
    phone: c.phone ? normalizePhone(c.phone) : null,
    address: [c.address_line1, c.city].filter(Boolean).join(", ") || null,
  };
}

export async function getCustomerDetail(id: string): Promise<CustomerDetail | null> {
  const supabase = getSupabaseServerClient();

  const { data: customer, error } = await supabase
    .from("customers")
    .select("id, first_name, last_name, company, phone, email, address_line1, city")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`customer query failed: ${error.message}`);
  if (!customer) return null;

  // Bounded: one customer's history, newest first. No customer in the account
  // is anywhere near 500 jobs, and the range keeps the 1000-row cap explicit.
  const { data: jobs, error: jobsError } = await supabase
    .from("jobs")
    .select("id, work_status, scheduled_start, total_amount_cents, raw")
    .eq("customer_id", id)
    .order("scheduled_start", { ascending: false })
    .range(0, 499);

  if (jobsError) throw new Error(`customer jobs query failed: ${jobsError.message}`);

  const rows = (jobs ?? []) as Array<{
    id: string;
    work_status: string | null;
    scheduled_start: string | null;
    total_amount_cents: number | null;
    raw?: { job_fields?: { job_type?: { name?: string } }; description?: string };
  }>;

  const CANCELED = new Set(["pro canceled", "user canceled"]);

  return {
    ...toHit(customer),
    company: customer.company,
    email: customer.email ?? null,
    // Canceled work never happened, so it must not inflate lifetime value.
    lifetimeCents: rows
      .filter((j) => !CANCELED.has((j.work_status ?? "").toLowerCase()))
      .reduce((sum, j) => sum + (j.total_amount_cents ?? 0), 0),
    jobs: rows.map((j) => ({
      id: j.id,
      scheduledStart: j.scheduled_start,
      service:
        j.raw?.job_fields?.job_type?.name?.trim() || j.raw?.description?.split("\n")[0]?.trim() || null,
      status: j.work_status,
      amountCents: j.total_amount_cents,
    })),
  };
}
