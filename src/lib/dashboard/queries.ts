import { getSupabaseServerClient } from "@/lib/supabase/client";
import { weekRange, dayRange } from "./week";
import { classifyZone } from "@/lib/geo/zones";

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
// underscored form made jobsInProgress silently report 0.
const JOB_IN_PROGRESS = "in progress";

// Live HCP invoice statuses over all 2,854 synced invoices:
//   paid 2217 | canceled 570 | voided 42 | open 25
// There is no "pending" status in the account; "open" is the unpaid state.
const INVOICE_PENDING = "open";

interface EstimateOption {
  approval_status?: string | null;
}

function isOpenEstimate(e: {
  status: string | null;
  raw?: { options?: EstimateOption[]; scheduled_start?: string };
}): boolean {
  if (TERMINAL_ESTIMATE_STATUSES.has((e.status ?? "").toLowerCase())) return false;
  const options = e.raw?.options ?? [];
  if (options.some((o) => APPROVED_STATUSES.has((o.approval_status ?? "").toLowerCase()))) return false;
  return options.some((o) => !o.approval_status);
}

interface JobRow {
  id: string;
  work_status: string | null;
  is_emergency: boolean;
  is_commercial: boolean;
  total_amount_cents: number | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  technician_id: string | null;
  service_address_lat: number | null;
  service_address_lng: number | null;
  raw?: { customer?: { id?: string }; address?: { city?: string } };
}

interface EstimateRow {
  status: string | null;
  raw?: { options?: EstimateOption[]; scheduled_start?: string };
}

interface CustomerRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  city: string | null;
}

interface TechRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

interface TodayScheduleRow {
  id: string;
  scheduledStart: string | null;
  customerName: string | null;
  technicianName: string | null;
  zone: string;
  compass: string;
}

interface TechWorkloadRow {
  technicianId: string | null;
  technicianName: string | null;
  jobCount: number;
  scheduledHours: number;
}

export interface DashboardSnapshot {
  jobsInProgress: number;
  emergencyCalls: number;
  commercialJobs: number;
  openEstimates: number;
  pendingInvoices: number;
  upcomingEstimates: number;
  // Sum of job amounts scheduled within the current Mon-Sun week.
  revenueBookedThisWeekCents: number;
  // Sum of job amounts scheduled within the following Mon-Sun week.
  revenueScheduledNextWeekCents: number;
  todaySchedule: TodayScheduleRow[];
  technicianWorkload: TechWorkloadRow[];
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

export async function getDashboardSnapshot(now: Date = new Date()): Promise<DashboardSnapshot> {
  const supabase = getSupabaseServerClient();
  const thisWeek = weekRange(now, "this");
  const nextWeek = weekRange(now, "next");
  const today = dayRange(now);

  const [jobs, estimates, invoices, customers, technicians] = await Promise.all([
    fetchAllRows<JobRow>(
      supabase,
      "jobs",
      "id, work_status, is_emergency, is_commercial, total_amount_cents, scheduled_start, scheduled_end, technician_id, service_address_lat, service_address_lng, raw"
    ),
    fetchAllRows<EstimateRow>(supabase, "estimates", "status, raw"),
    fetchAllRows<{ status: string | null }>(supabase, "invoices", "status"),
    fetchAllRows<CustomerRow>(supabase, "customers", "id, first_name, last_name, city"),
    fetchAllRows<TechRow>(supabase, "technicians", "id, first_name, last_name"),
  ]);

  const custById = new Map(customers.map((c) => [c.id, c]));
  const techById = new Map(technicians.map((t) => [t.id, t]));
  const fullName = (r?: { first_name: string | null; last_name: string | null }) =>
    r ? [r.first_name, r.last_name].filter(Boolean).join(" ") || null : null;

  const inWindow = (iso: string | null, w: { startIso: string; endIso: string }) =>
    !!iso && iso >= w.startIso && iso < w.endIso;

  const todayJobs = jobs.filter((j) => inWindow(j.scheduled_start, today));

  const todaySchedule = todayJobs
    .slice()
    .sort((a, b) => (a.scheduled_start ?? "").localeCompare(b.scheduled_start ?? ""))
    .map((j) => {
      const cust = custById.get(j.raw?.customer?.id ?? "");
      const town = j.raw?.address?.city ?? cust?.city ?? null;
      const hasCoords = j.service_address_lat != null && j.service_address_lng != null;
      const z = hasCoords
        ? classifyZone(j.service_address_lat as number, j.service_address_lng as number, town)
        : { zone: "Unknown", compass: "", source: "distance" as const };
      return {
        id: j.id,
        scheduledStart: j.scheduled_start,
        customerName: fullName(cust),
        technicianName: fullName(techById.get(j.technician_id ?? "")),
        zone: z.zone,
        compass: z.compass,
      };
    });

  const workloadMap = new Map<string, { jobCount: number; ms: number }>();
  for (const j of todayJobs) {
    const key = j.technician_id ?? "__unassigned";
    const cur = workloadMap.get(key) ?? { jobCount: 0, ms: 0 };
    cur.jobCount += 1;
    if (j.scheduled_start && j.scheduled_end) {
      cur.ms += Math.max(0, Date.parse(j.scheduled_end) - Date.parse(j.scheduled_start));
    }
    workloadMap.set(key, cur);
  }
  const technicianWorkload = Array.from(workloadMap.entries()).map(([techId, v]) => ({
    technicianId: techId === "__unassigned" ? null : techId,
    technicianName: techId === "__unassigned" ? "Unassigned" : fullName(techById.get(techId)),
    jobCount: v.jobCount,
    scheduledHours: Math.round((v.ms / 3_600_000) * 10) / 10,
  }));

  const bookedThisWeek = jobs
    .filter((j) => inWindow(j.scheduled_start, thisWeek))
    .reduce((s, j) => s + (j.total_amount_cents ?? 0), 0);
  const scheduledNextWeek = jobs
    .filter((j) => inWindow(j.scheduled_start, nextWeek))
    .reduce((s, j) => s + (j.total_amount_cents ?? 0), 0);

  const upcomingEstimates = estimates.filter(
    (e) => isOpenEstimate(e) && !!e.raw?.scheduled_start && e.raw.scheduled_start >= today.startIso
  ).length;

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
    upcomingEstimates,
    revenueBookedThisWeekCents: bookedThisWeek,
    revenueScheduledNextWeekCents: scheduledNextWeek,
    todaySchedule,
    technicianWorkload,
  };
}
