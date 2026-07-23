import { getSupabaseServerClient } from "@/lib/supabase/client";

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
  const estimates = (estimatesResult.data ?? []) as Array<{ status: string | null }>;
  const invoices = (invoicesResult.data ?? []) as Array<{ status: string | null }>;

  return {
    jobsInProgress: jobs.filter((j) => j.work_status === "in_progress").length,
    emergencyCalls: jobs.filter((j) => j.is_emergency).length,
    commercialJobs: jobs.filter((j) => j.is_commercial).length,
    openEstimates: estimates.filter((e) => e.status === "open").length,
    pendingInvoices: invoices.filter((i) => i.status === "pending").length,
    revenueBookedCents: jobs
      .filter((j) => j.work_status === "in_progress" || j.work_status === "scheduled")
      .reduce((sum, j) => sum + (j.total_amount_cents ?? 0), 0),
  };
}
