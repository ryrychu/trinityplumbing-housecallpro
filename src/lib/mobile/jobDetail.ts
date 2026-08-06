import { getSupabaseServerClient } from "@/lib/supabase/client";
import { scheduleStatus } from "@/lib/dashboard/queries";

export interface JobNote {
  content: string;
  author: string | null;
  createdAt: string | null;
}

export interface JobDetail {
  id: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  address: string | null;
  technicianName: string | null;
  service: string | null;
  status: string | null;
  amountCents: number | null;
  invoice: { id: string; status: string | null; amountCents: number | null } | null;
  notes: JobNote[];
}

const fullName = (r?: { first_name?: string | null; last_name?: string | null } | null) =>
  r ? [r.first_name, r.last_name].filter(Boolean).join(" ") || null : null;

export async function getJobDetail(id: string): Promise<JobDetail | null> {
  const supabase = getSupabaseServerClient();

  const { data: job, error } = await supabase
    .from("jobs")
    .select(
      "id, work_status, total_amount_cents, scheduled_start, scheduled_end, technician_id, service_address_lat, service_address_lng, raw"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`job query failed: ${error.message}`);
  if (!job) return null;

  const raw = (job.raw ?? {}) as {
    customer?: { id?: string; mobile_number?: string; home_number?: string; work_number?: string };
    address?: { street?: string; city?: string };
    description?: string;
    job_fields?: { job_type?: { name?: string } };
    work_timestamps?: { on_my_way_at?: string | null };
    notes?: Array<{ content?: string; created_by?: string; created_at?: string }>;
  };

  const customerId = raw.customer?.id ?? null;

  const [{ data: customer }, { data: technician }, { data: invoices }] = await Promise.all([
    customerId
      ? supabase
          .from("customers")
          .select("id, first_name, last_name, phone, address_line1, city")
          .eq("id", customerId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    job.technician_id
      ? supabase
          .from("technicians")
          .select("id, first_name, last_name")
          .eq("id", job.technician_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Estimates are deliberately absent: HCP exposes csr_-prefixed ids on
    // /estimates and est_-prefixed ids on the job, so there is no key to join
    // on. Invoices DO carry job_id. See the spec's constraints.
    supabase.from("invoices").select("id, status, amount_cents").eq("job_id", id).limit(1),
  ]);

  const street = raw.address?.street?.trim() || customer?.address_line1?.trim() || null;
  const town = raw.address?.city?.trim() || customer?.city?.trim() || null;

  const phoneRaw =
    customer?.phone ||
    raw.customer?.mobile_number ||
    raw.customer?.home_number ||
    raw.customer?.work_number ||
    "";
  const digits = phoneRaw.replace(/\D/g, "");

  const firstInvoice = (invoices ?? [])[0];

  return {
    id: job.id,
    customerId,
    customerName: fullName(customer),
    customerPhone: digits || null,
    scheduledStart: job.scheduled_start,
    scheduledEnd: job.scheduled_end,
    address: [street, town].filter(Boolean).join(", ") || null,
    technicianName: fullName(technician),
    service: raw.job_fields?.job_type?.name?.trim() || raw.description?.split("\n")[0]?.trim() || null,
    // The shared implementation — same labels the dashboard and Slack digest use.
    status: scheduleStatus({ work_status: job.work_status, raw }),
    amountCents: job.total_amount_cents,
    invoice: firstInvoice
      ? { id: firstInvoice.id, status: firstInvoice.status, amountCents: firstInvoice.amount_cents }
      : null,
    notes: (raw.notes ?? []).map((n) => ({
      content: n.content ?? "",
      author: n.created_by ?? null,
      createdAt: n.created_at ?? null,
    })),
  };
}
