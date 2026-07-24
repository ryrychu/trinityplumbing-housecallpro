import { getSupabaseServerClient } from "@/lib/supabase/client";

// Live HCP estimates (Task 0) have no "open" status. `estimates.status` stores
// the estimate `work_status`; per-option customer approval lives in
// raw.options[].approval_status. An estimate is "open" (an outstanding
// opportunity) when it hasn't been won or canceled, no option has been approved,
// and at least one option is still awaiting a response (approval_status null).
// These value sets are tunable as the live lifecycle is better understood.
const TERMINAL_ESTIMATE_STATUSES = new Set([
  "created job from estimate", // won -> became a job
  "user canceled",
  "pro canceled",
]);
const APPROVED_STATUSES = new Set(["approved", "pro approved"]);

// Live HCP job work_status values, censused over all 3,038 synced jobs during
// go-live Step 2:
//   complete rated 1158 | complete unrated 892 | pro canceled 412 |
//   scheduled 244 | user canceled 241 | in progress 91
// Note the SPACE: HCP sends "in progress", not "in_progress". Matching the
// underscored form made jobsInProgress and revenueBooked silently report 0.
const JOB_IN_PROGRESS = "in progress";
const JOB_SCHEDULED = "scheduled";

// Live HCP invoice statuses over all 2,854 synced invoices:
//   paid 2217 | canceled 570 | voided 42 | open 25
// There is no "pending" status in the account; "open" is the unpaid state.
const INVOICE_PENDING = "open";

interface EstimateOption {
  approval_status?: string | null;
}

function isOpenEstimate(e: { status: string | null; raw?: { options?: EstimateOption[] } }): boolean {
  if (TERMINAL_ESTIMATE_STATUSES.has((e.status ?? "").toLowerCase())) return false;
  const options = e.raw?.options ?? [];
  if (options.some((o) => APPROVED_STATUSES.has((o.approval_status ?? "").toLowerCase()))) return false;
  return options.some((o) => !o.approval_status);
}

export interface DashboardSnapshot {
  jobsInProgress: number;
  emergencyCalls: number;
  commercialJobs: number;
  openEstimates: number;
  pendingInvoices: number;
  // Sum of all in_progress + scheduled job amounts. NOT date-scoped yet — a
  // "this week" filter is a Phase 1.x fast-follow, so the name stays literal.
  revenueBookedCents: number;
}

// PostgREST caps every response at 1000 rows (db-max-rows). A bare select("*")
// therefore silently truncates: with 3,038 jobs the dashboard reported 19 jobs
// in progress instead of 91, and 24 pending invoices instead of 25. Always page
// through with .range() and select only the columns each metric needs — `raw`
// is a large jsonb blob and only the estimate logic reads it.
const PAGE_SIZE = 1000;

async function fetchAllRows<T>(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  table: string,
  columns: string
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Dashboard query failed for ${table}: ${error.message}`);
    }
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const supabase = getSupabaseServerClient();

  const [jobsResult, estimatesResult, invoicesResult] = await Promise.all([
    fetchAllRows(supabase, "jobs", "work_status, is_emergency, is_commercial, total_amount_cents"),
    fetchAllRows(supabase, "estimates", "status, raw"),
    fetchAllRows(supabase, "invoices", "status"),
  ]).then((r) => r.map((data) => ({ data })));

  const jobs = (jobsResult.data ?? []) as Array<{
    work_status: string | null;
    is_emergency: boolean;
    is_commercial: boolean;
    total_amount_cents: number | null;
  }>;
  const estimates = (estimatesResult.data ?? []) as Array<{
    status: string | null;
    raw?: { options?: EstimateOption[] };
  }>;
  const invoices = (invoicesResult.data ?? []) as Array<{ status: string | null }>;

  return {
    jobsInProgress: jobs.filter((j) => j.work_status === JOB_IN_PROGRESS).length,
    // NOTE: these two are structurally 0 against the live account — Trinity does
    // not tag jobs "emergency"/"commercial" in HCP (only 22 of 3,038 jobs carry
    // any tag, and the names are unrelated: "HomeServe", "My Website", "3LD"...).
    // mapJob derives these flags from tag names, so no code change can populate
    // them; it needs a tagging convention in HCP or a different signal. See
    // docs/PHASE-1.x-BACKLOG.md.
    emergencyCalls: jobs.filter((j) => j.is_emergency).length,
    commercialJobs: jobs.filter((j) => j.is_commercial).length,
    openEstimates: estimates.filter(isOpenEstimate).length,
    pendingInvoices: invoices.filter((i) => i.status === INVOICE_PENDING).length,
    revenueBookedCents: jobs
      .filter((j) => j.work_status === JOB_IN_PROGRESS || j.work_status === JOB_SCHEDULED)
      .reduce((sum, j) => sum + (j.total_amount_cents ?? 0), 0),
  };
}
