import { getSupabaseServerClient } from "@/lib/supabase/client";
import { weekRange, dayRange, localParts } from "./week";
import { classifyZone } from "@/lib/geo/zones";
import { zoneForTown } from "@/lib/geo/townZones";
import { distanceFromAverillPark } from "@/lib/geo/distance";
import { localDateKey as localDateKeyOf } from "@/lib/notifications/schedule";

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

// Canceled jobs must never inflate booked/scheduled revenue, and (Task 14)
// must not appear in the schedule a dispatcher reads either. These are the
// live canceled work_status values (go-live Step 2 census); "complete rated",
// "complete unrated", "scheduled", and "in progress" all still count as booked.
const CANCELED_JOB_STATUSES = new Set(["pro canceled", "user canceled"]);

// The ONE predicate for "is this job canceled" -- used by revenue sums,
// todaySchedule, and getWeekAheadSchedule alike. A null/unknown work_status is
// NOT cancellation (dropping it would silently hide real work), and the match
// is case-insensitive since HCP's casing isn't guaranteed. Both schedule
// surfaces MUST call this same function, not duplicate the `.has(...)` check,
// or the dashboard and the Slack digest can silently drift out of sync.
function isCanceledJob(j: { work_status: string | null }): boolean {
  return CANCELED_JOB_STATUSES.has((j.work_status ?? "").toLowerCase());
}

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
  // `raw` is the full HCP job payload (mapJob stores it verbatim), so street
  // address, job type and description are already synced — no new columns and
  // no re-sync are needed to render them.
  raw?: {
    customer?: { id?: string; mobile_number?: string; home_number?: string; work_number?: string };
    address?: { street?: string; street_line_2?: string; city?: string; state?: string; zip?: string };
    description?: string;
    job_fields?: { job_type?: { name?: string } };
    // HCP has no "en route" work_status; the tech tapping "On my way" stamps
    // work_timestamps.on_my_way_at instead. It is the ONLY source for that state.
    work_timestamps?: { on_my_way_at?: string | null; started_at?: string | null; completed_at?: string | null };
  };
}

interface EstimateRow {
  status: string | null;
  raw?: { options?: EstimateOption[]; scheduled_start?: string };
}

interface CustomerRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
}

interface TechRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

export interface TodayScheduleRow {
  id: string;
  scheduledStart: string | null;
  customerName: string | null;
  technicianName: string | null;
  zone: string;
  compass: string;
  miles: number | null;
  driveMinutes: number | null;
  // "123 Main St, Averill Park" — what a tech actually needs to drive to.
  // Null when the job carries no street and the customer record has none either.
  address: string | null;
  // The HCP job type ("Water Heater Repair"), falling back to the job
  // description. Null when the job carries neither.
  service: string | null;
  // Digits only, as HCP stores them — formatting for display is the renderer's
  // job, and the dashboard may want to build a tel: link from the raw digits.
  customerPhone: string | null;
  // Display label: "Scheduled" | "En Route" | "In Progress" | "Completed" |
  // "Needs Scheduling" | "Canceled". Null when HCP sent an unrecognized status.
  status: string | null;
  // Job coordinates, when geocoding resolved them. Carried so callers can
  // measure this job against an arbitrary point (the nearby-work lookup) rather
  // than only against Averill Park, which is all `miles` records.
  lat: number | null;
  lng: number | null;
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

// "123 Main St, Averill Park" from whichever parts exist. The job's own address
// wins over the customer record's: a customer can have several properties, and
// the job is the one being driven to today.
function scheduleAddress(j: JobRow, cust?: CustomerRow): string | null {
  const street = j.raw?.address?.street?.trim() || cust?.address_line1?.trim() || null;
  const town = j.raw?.address?.city?.trim() || cust?.city?.trim() || null;
  return [street, town].filter(Boolean).join(", ") || null;
}

// HCP's structured job type is the clean label ("Drain Cleaning"); the free-text
// description is the fallback for accounts/jobs that never set one. Descriptions
// can run several sentences, so only the first line is kept and it is capped —
// a wrapped paragraph would swamp the digest it is meant to make scannable.
const SERVICE_MAX_CHARS = 60;

function scheduleService(j: JobRow): string | null {
  const jobType = j.raw?.job_fields?.job_type?.name?.trim();
  if (jobType) return jobType;

  const firstLine = (j.raw?.description ?? "").split("\n")[0].trim();
  if (!firstLine) return null;
  return firstLine.length > SERVICE_MAX_CHARS
    ? `${firstLine.slice(0, SERVICE_MAX_CHARS - 1).trimEnd()}…`
    : firstLine;
}

// The customer record is the maintained number; the job's embedded customer
// snapshot is the fallback for a job whose customer row hasn't synced yet.
// Mobile first — it is the one a tech can text from the truck.
function schedulePhone(j: JobRow, cust?: CustomerRow): string | null {
  const c = j.raw?.customer;
  const raw = cust?.phone || c?.mobile_number || c?.home_number || c?.work_number || null;
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits || null;
}

// HCP's work_status has no "en route" — the enum is needs scheduling /
// scheduled / in progress / complete rated / complete unrated / user canceled /
// pro canceled. "On my way" only stamps work_timestamps.on_my_way_at, so a job
// that is dispatched but not started still reads "scheduled" and must be
// upgraded here or the digest can never show the state Dave asked for.
function scheduleStatus(j: JobRow): string | null {
  const status = (j.work_status ?? "").toLowerCase();
  const ts = j.raw?.work_timestamps;

  if (status.startsWith("complete")) return "Completed";
  if (CANCELED_JOB_STATUSES.has(status)) return "Canceled";
  if (status === "in progress") return "In Progress";
  if (status === "scheduled") return ts?.on_my_way_at ? "En Route" : "Scheduled";
  if (status === "needs scheduling") return "Needs Scheduling";
  // An unknown status is left out rather than echoed raw: HCP lowercases its
  // enum, so an unmapped value would render as "pro canceled"-style lowercase
  // noise among title-cased labels.
  return null;
}

// Shared by the dashboard's todaySchedule and the Slack week-ahead digest.
// Both MUST render from one implementation, or the two can silently drift.
function buildScheduleRow(
  j: JobRow,
  custById: Map<string, CustomerRow>,
  techById: Map<string, TechRow>,
  fullName: (r?: { first_name: string | null; last_name: string | null }) => string | null
): TodayScheduleRow {
  const cust = custById.get(j.raw?.customer?.id ?? "");
  const town = j.raw?.address?.city ?? cust?.city ?? null;
  const hasCoords = j.service_address_lat != null && j.service_address_lng != null;
  // Town-first design: even without coordinates a known town resolves its
  // zone. Only fall through to "Unknown" when the town is also unrecognized.
  let z: { zone: string; compass: string; source: "town" | "distance" };
  let miles: number | null = null;
  let driveMinutes: number | null = null;
  if (hasCoords) {
    const lat = j.service_address_lat as number;
    const lng = j.service_address_lng as number;
    z = classifyZone(lat, lng, town);
    const dist = distanceFromAverillPark(lat, lng);
    miles = dist.miles;
    driveMinutes = dist.driveMinutes;
  } else {
    const townZone = zoneForTown(town);
    z = townZone
      ? { zone: townZone, compass: "", source: "town" }
      : { zone: "Unknown", compass: "", source: "distance" };
  }
  return {
    id: j.id,
    scheduledStart: j.scheduled_start,
    customerName: fullName(cust),
    technicianName: fullName(techById.get(j.technician_id ?? "")),
    zone: z.zone,
    compass: z.compass,
    miles,
    driveMinutes,
    address: scheduleAddress(j, cust),
    service: scheduleService(j),
    customerPhone: schedulePhone(j, cust),
    status: scheduleStatus(j),
    lat: j.service_address_lat,
    lng: j.service_address_lng,
  };
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
    fetchAllRows<CustomerRow>(supabase, "customers", "id, first_name, last_name, phone, address_line1, city"),
    fetchAllRows<TechRow>(supabase, "technicians", "id, first_name, last_name"),
  ]);

  const custById = new Map(customers.map((c) => [c.id, c]));
  const techById = new Map(technicians.map((t) => [t.id, t]));
  const fullName = (r?: { first_name: string | null; last_name: string | null }) =>
    r ? [r.first_name, r.last_name].filter(Boolean).join(" ") || null : null;

  const inWindow = (iso: string | null, w: { startIso: string; endIso: string }) =>
    !!iso && iso >= w.startIso && iso < w.endIso;

  const todayJobs = jobs.filter((j) => inWindow(j.scheduled_start, today));

  // technicianWorkload (below) intentionally reads the UNFILTERED todayJobs --
  // a canceled job still occupied a technician's calendar slot, and workload
  // is out of scope for Task 14. Only the schedule list dispatchers read gets
  // canceled jobs filtered out, via the shared isCanceledJob predicate.
  const todaySchedule = todayJobs
    .filter((j) => !isCanceledJob(j))
    .slice()
    .sort((a, b) => (a.scheduled_start ?? "").localeCompare(b.scheduled_start ?? ""))
    .map((j) => buildScheduleRow(j, custById, techById, fullName));

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
    .filter((j) => inWindow(j.scheduled_start, thisWeek) && !isCanceledJob(j))
    .reduce((s, j) => s + (j.total_amount_cents ?? 0), 0);
  const scheduledNextWeek = jobs
    .filter((j) => inWindow(j.scheduled_start, nextWeek) && !isCanceledJob(j))
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

// Monday-Sunday of the local week containing `now`, grouped by local day.
// Every day is present even when empty, so the digest can say "No jobs".
//
// Filters out canceled jobs via the same isCanceledJob predicate
// getDashboardSnapshot's todaySchedule uses (Task 14). Both surfaces MUST
// filter identically, or a dispatcher could see a job on the live dashboard
// that silently disagrees with the Slack digest for the same day -- exactly
// the drift buildScheduleRow exists to prevent.
export async function getWeekAheadSchedule(
  now: Date = new Date()
): Promise<Array<{ dateKey: string; rows: TodayScheduleRow[] }>> {
  return getScheduleDays(new Date(weekRange(now, "this").startIso), 7);
}

// `dayCount` consecutive local days starting from the calendar day containing
// `startAnchor`, each bucket present even when empty. Generalized out of
// getWeekAheadSchedule so the nearby-work lookup can ask for a 14-day horizon
// from today without duplicating the DST-safe bucketing or the canceled-job
// filter — a second implementation of either is exactly how the dashboard and
// the Slack digest would start disagreeing about the same day.
export async function getScheduleDays(
  startAnchor: Date,
  dayCount: number
): Promise<Array<{ dateKey: string; rows: TodayScheduleRow[] }>> {
  const supabase = getSupabaseServerClient();

  // Never select("*"): PostgREST caps responses at 1000 rows and truncates
  // silently. fetchAllRows pages; the column list stays explicit.
  const [jobs, customers, technicians] = await Promise.all([
    fetchAllRows<JobRow>(
      supabase,
      "jobs",
      "id, work_status, is_emergency, is_commercial, total_amount_cents, scheduled_start, scheduled_end, technician_id, service_address_lat, service_address_lng, raw"
    ),
    fetchAllRows<CustomerRow>(supabase, "customers", "id, first_name, last_name, phone, address_line1, city"),
    fetchAllRows<TechRow>(supabase, "technicians", "id, first_name, last_name"),
  ]);

  const custById = new Map(customers.map((c) => [c.id, c]));
  const techById = new Map(technicians.map((t) => [t.id, t]));
  const fullName = (r?: { first_name: string | null; last_name: string | null }) =>
    r ? [r.first_name, r.last_name].filter(Boolean).join(" ") || null : null;

  // Build the local day buckets from the anchor's calendar date. NOT built by
  // adding i * 86_400_000ms to a single UTC instant: a span containing a DST
  // transition has a 23- or 25-hour day, so fixed 24h-multiples can drift off
  // local midnight for every day after the transition. Instead we advance the
  // *calendar* date (y, m0, d + i) and anchor each day at 16:00 UTC -- noon-ish
  // Eastern under either offset (-04:00 or -05:00), never within hours of a DST
  // boundary -- so it always resolves to the correct calendar day before handing
  // off to dayRange for that day's true local midnight-to-midnight boundaries.
  const start = localParts(startAnchor);
  const buckets: Array<{ dateKey: string; rows: TodayScheduleRow[]; startIso: string; endIso: string }> = [];
  for (let i = 0; i < dayCount; i += 1) {
    const noonAnchor = new Date(Date.UTC(start.y, start.m0, start.d + i, 16, 0, 0));
    const range = dayRange(noonAnchor);
    buckets.push({
      dateKey: localDateKeyOf(noonAnchor),
      rows: [],
      startIso: range.startIso,
      endIso: range.endIso,
    });
  }
  if (buckets.length === 0) return [];

  const spanStart = buckets[0].startIso;
  const spanEnd = buckets[buckets.length - 1].endIso;

  const inSpan = jobs
    .filter(
      (j) =>
        !!j.scheduled_start &&
        j.scheduled_start >= spanStart &&
        j.scheduled_start < spanEnd &&
        !isCanceledJob(j)
    )
    .slice()
    .sort((a, b) => (a.scheduled_start ?? "").localeCompare(b.scheduled_start ?? ""));

  for (const j of inSpan) {
    const iso = j.scheduled_start as string;
    const bucket = buckets.find((b) => iso >= b.startIso && iso < b.endIso);
    if (bucket) bucket.rows.push(buildScheduleRow(j, custById, techById, fullName));
  }

  return buckets.map(({ dateKey, rows }) => ({ dateKey, rows }));
}
