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

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const supabase = getSupabaseServerClient();

  const [jobsResult, estimatesResult, invoicesResult] = await Promise.all([
    supabase.from("jobs").select("*"),
    supabase.from("estimates").select("*"),
    supabase.from("invoices").select("*"),
  ]);

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
    jobsInProgress: jobs.filter((j) => j.work_status === "in_progress").length,
    emergencyCalls: jobs.filter((j) => j.is_emergency).length,
    commercialJobs: jobs.filter((j) => j.is_commercial).length,
    openEstimates: estimates.filter(isOpenEstimate).length,
    pendingInvoices: invoices.filter((i) => i.status === "pending").length,
    revenueBookedCents: jobs
      .filter((j) => j.work_status === "in_progress" || j.work_status === "scheduled")
      .reduce((sum, j) => sum + (j.total_amount_cents ?? 0), 0),
  };
}
