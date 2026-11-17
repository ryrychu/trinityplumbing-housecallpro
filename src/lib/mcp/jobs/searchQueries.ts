// Supabase reads behind the Trinity Jobs search tools. These only pre-select:
// a row comes back if a search word appears anywhere in a searched field,
// including inside raw JSON. search.ts then decides what really matched.
// Spec: docs/superpowers/specs/2026-11-18-chatgpt-jobs-search-design.md
import { getSupabaseServerClient } from "@/lib/supabase/client";
import { selectByIds } from "@/lib/supabase/selectByIds";
import type { CustomerAddress, CustomerCandidate, JobCandidate } from "./search";

const JOB_COLUMNS =
  "id, customer_id, scheduled_start, work_status, total_amount_cents, street:raw->address->>street, city:raw->address->>city, description:raw->>description, job_type:raw->job_fields->job_type->>name, on_my_way_at:raw->work_timestamps->>on_my_way_at";
const CUSTOMER_COLUMNS = "id, first_name, last_name, company, phone, city, notes, tags, addresses:raw->addresses";

const JOBS_PER_TERM = 200;
const CUSTOMERS_PER_TERM = 50;
const JOBS_PER_CUSTOMER_MATCH = 300;

interface JobRow {
  id: string;
  customer_id: string | null;
  scheduled_start: string | null;
  work_status: string | null;
  total_amount_cents: number | null;
  street: string | null;
  city: string | null;
  description: string | null;
  job_type: string | null;
  on_my_way_at: string | null;
}

interface CustomerNameRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  tags: string[] | null;
}

interface CustomerRow extends CustomerNameRow {
  phone: string | null;
  city: string | null;
  notes: string | null;
  addresses: unknown;
}

// Terms come from searchTerms(): lowercase [a-z0-9] only, so nothing in them
// can change the meaning of a PostgREST or() filter.
const anyContains = (columns: string[], term: string) => columns.map((c) => `${c}.ilike.%${term}%`).join(",");

export async function findJobCandidates(terms: string[]): Promise<JobCandidate[]> {
  if (terms.length === 0) return [];
  const supabase = getSupabaseServerClient();

  const perTerm = await Promise.all(
    terms.map(async (term) => {
      const [byJob, byCustomer] = await Promise.all([
        supabase
          .from("jobs")
          .select(JOB_COLUMNS)
          .or(
            anyContains(
              ["raw->address->>street", "raw->address->>city", "raw->>description", "raw->job_fields->job_type->>name"],
              term
            )
          )
          .limit(JOBS_PER_TERM),
        // A customer's own addresses deliberately don't pull in its jobs: a
        // customer with 13 locations would return every location's jobs.
        supabase
          .from("customers")
          .select("id")
          .or(anyContains(["first_name", "last_name", "company", "raw->>tags"], term))
          .limit(CUSTOMERS_PER_TERM),
      ]);
      if (byJob.error) throw new Error(`job search failed: ${byJob.error.message}`);
      if (byCustomer.error) throw new Error(`job search failed: ${byCustomer.error.message}`);

      const jobs = (byJob.data ?? []) as unknown as JobRow[];
      const ids = ((byCustomer.data ?? []) as unknown as { id: string }[]).map((r) => r.id);
      if (ids.length === 0) return jobs;

      const theirJobs = await supabase
        .from("jobs")
        .select(JOB_COLUMNS)
        .in("customer_id", ids)
        .limit(JOBS_PER_CUSTOMER_MATCH);
      if (theirJobs.error) throw new Error(`job search failed: ${theirJobs.error.message}`);
      return [...jobs, ...((theirJobs.data ?? []) as unknown as JobRow[])];
    })
  );

  const rows = new Map<string, JobRow>();
  for (const row of perTerm.flat()) rows.set(row.id, row);

  const customerIds = Array.from(
    new Set(Array.from(rows.values()).map((r) => r.customer_id).filter((id): id is string => !!id))
  );
  const customers = await selectByIds<CustomerNameRow>(
    supabase,
    "customers",
    "id, first_name, last_name, company, tags",
    customerIds
  );
  const byId = new Map(customers.map((c) => [c.id, c]));

  return Array.from(rows.values()).map((r) => toJobCandidate(r, r.customer_id ? byId.get(r.customer_id) : undefined));
}

export async function findCustomerCandidates(terms: string[], phoneDigits: string | null): Promise<CustomerCandidate[]> {
  if (terms.length === 0 && !phoneDigits) return [];
  const supabase = getSupabaseServerClient();

  const filters = terms.map((t) =>
    anyContains(["first_name", "last_name", "company", "city", "notes", "raw->>addresses", "raw->>tags"], t)
  );
  // The same two phone patterns as the mobile app's searchCustomers: the digits
  // as typed, and with `%` between each digit so a punctuated number matches.
  if (phoneDigits) {
    filters.push(`phone.ilike.%${phoneDigits}%,phone.ilike.%${phoneDigits.split("").join("%")}%`);
  }

  const results = await Promise.all(
    filters.map((f) => supabase.from("customers").select(CUSTOMER_COLUMNS).or(f).limit(CUSTOMERS_PER_TERM))
  );

  const rows = new Map<string, CustomerRow>();
  for (const r of results) {
    if (r.error) throw new Error(`customer search failed: ${r.error.message}`);
    for (const row of (r.data ?? []) as unknown as CustomerRow[]) rows.set(row.id, row);
  }
  return Array.from(rows.values()).map(toCustomerCandidate);
}

function toJobCandidate(r: JobRow, c: CustomerNameRow | undefined): JobCandidate {
  return {
    id: r.id,
    customerId: r.customer_id,
    scheduledStart: r.scheduled_start,
    workStatus: r.work_status,
    onMyWayAt: r.on_my_way_at,
    amountCents: r.total_amount_cents,
    street: r.street,
    city: r.city,
    description: r.description,
    jobType: r.job_type,
    customer: c
      ? {
          id: c.id,
          name: [c.first_name, c.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ") || null,
          company: c.company?.trim() || null,
          tags: c.tags ?? [],
        }
      : null,
  };
}

function toAddresses(raw: unknown): CustomerAddress[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<{ street?: unknown; city?: unknown } | null>).map((a) => ({
    street: typeof a?.street === "string" ? a.street : null,
    city: typeof a?.city === "string" ? a.city : null,
  }));
}

function toCustomerCandidate(r: CustomerRow): CustomerCandidate {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    company: r.company,
    phone: r.phone,
    city: r.city,
    notes: r.notes,
    tags: r.tags ?? [],
    addresses: toAddresses(r.addresses),
  };
}
