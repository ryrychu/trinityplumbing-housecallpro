import { HcpCustomer, HcpJob, HcpEstimate, HcpInvoice } from "@/lib/housecall/types";

export function mapCustomer(c: HcpCustomer) {
  const address = c.addresses?.[0];
  return {
    id: c.id,
    first_name: c.first_name ?? null,
    last_name: c.last_name ?? null,
    company: c.company ?? null,
    email: c.email ?? null,
    phone: c.mobile_number ?? null,
    address_line1: address?.street ?? null,
    address_line2: address?.street_line_2 ?? null,
    city: address?.city ?? null,
    state: address?.state ?? null,
    zip: address?.zip ?? null,
    lat: address?.latitude ?? null,
    lng: address?.longitude ?? null,
    raw: c,
    updated_at: new Date().toISOString(),
  };
}

export function mapEmployee(e: { id: string; first_name?: string; last_name?: string; color_hex?: string }) {
  return {
    id: e.id,
    first_name: e.first_name ?? null,
    last_name: e.last_name ?? null,
    color_hex: e.color_hex ?? null,
    raw: e,
    updated_at: new Date().toISOString(),
  };
}

export function mapJob(j: HcpJob) {
  const tagNames = (j.tags ?? []).map((t) => (t.name ?? "").toLowerCase());
  return {
    id: j.id,
    customer_id: j.customer?.id ?? null,
    technician_id: j.assigned_employees?.[0]?.id ?? null,
    work_status: j.work_status ?? null,
    is_emergency: tagNames.includes("emergency"),
    is_commercial: tagNames.includes("commercial"),
    scheduled_start: j.schedule?.scheduled_start ?? null,
    scheduled_end: j.schedule?.scheduled_end ?? null,
    total_amount_cents: j.total_amount ?? null,
    service_address_lat: j.address?.latitude ?? null,
    service_address_lng: j.address?.longitude ?? null,
    raw: j,
    updated_at: new Date().toISOString(),
  };
}

export function mapEstimate(e: HcpEstimate) {
  return {
    id: e.id,
    job_id: e.job_id ?? null,
    customer_id: e.customer?.id ?? null,
    status: e.status ?? null,
    amount_cents: e.total_amount ?? null,
    raw: e,
    updated_at: new Date().toISOString(),
  };
}

export function mapInvoice(i: HcpInvoice) {
  return {
    id: i.id,
    job_id: i.job_id ?? null,
    customer_id: i.customer?.id ?? null,
    status: i.status ?? null,
    amount_cents: i.total_amount ?? null,
    due_date: i.due_at ? i.due_at.slice(0, 10) : null,
    raw: i,
    updated_at: new Date().toISOString(),
  };
}
