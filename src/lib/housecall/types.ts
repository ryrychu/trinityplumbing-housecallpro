export interface HcpCustomer {
  id: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  email?: string;
  mobile_number?: string;
  notes?: string;
  tags?: Array<{ id: string; name: string }>;
  attachments?: Array<{ id: string; url: string; content_type?: string; file_name?: string }>;
  updated_at?: string; // ISO; drives incremental cursor sync
  addresses?: Array<{
    street: string;
    street_line_2?: string;
    city: string;
    state: string;
    zip: string;
    latitude?: number;
    longitude?: number;
  }>;
}

export interface HcpEmployee {
  id: string;
  first_name?: string;
  last_name?: string;
  color_hex?: string;
}

export interface HcpJob {
  id: string;
  customer?: { id: string };
  assigned_employees?: Array<{ id: string }>;
  work_status?: string;
  tags?: Array<{ id: string; name: string }>;
  schedule?: { scheduled_start?: string; scheduled_end?: string };
  total_amount?: number; // cents
  updated_at?: string; // ISO; drives incremental cursor sync
  // Live HCP jobs carry a full address object but no coordinates (Task 0); the
  // sync geocodes street/city/state/zip -> service_address_lat/lng.
  address?: {
    street?: string;
    street_line_2?: string;
    city?: string;
    state?: string;
    zip?: string;
    latitude?: number;
    longitude?: number;
  };
  notes?: Array<{ id: string; content: string; created_at: string }>;
  attachments?: Array<{ id: string; url: string; content_type?: string; file_name?: string }>;
}

// Confirmed against the live account (Task 0): estimates carry `work_status`
// (not `status`) and their amount lives in `options[].total_amount` (no
// top-level amount). There is no estimate.job_id — the job carries
// `original_estimate_id` instead.
export interface HcpEstimate {
  id: string;
  job_id?: string;
  customer?: { id: string };
  work_status?: string;
  updated_at?: string; // ISO; drives incremental cursor sync
  options?: Array<{ total_amount?: number; approval_status?: string; status?: string }>;
}

// Confirmed against the live account (Task 0): invoices use `amount` (not
// `total_amount`). The old note here — "carry no top-level customer/job link,
// they associate with a job via a shared invoice_number" — was half wrong and
// is corrected by docs/PHASE-1.x-BACKLOG.md item 4:
//
//   - `job_id` IS present and direct (e.g. "job_a955…"). It is the ONLY link
//     an invoice has to a human, so it is how both the mirror
//     (src/lib/sync/invoiceCustomer.ts) and the Slack paid-invoice alert
//     (src/lib/notifications/dispatch.ts) reach a customer name.
//   - `customer` is genuinely absent. The live key census is id/items/taxes/
//     amount/due_at/job_id/status/paid_at/invoice_date/service_date.
//
// `customer` therefore stays declared but must be treated as never present on
// this resource. It is NOT deleted because both readers accept it as a
// shortcut when it appears, and because HcpEstimate's identical-looking
// `customer` IS real — deleting one and not the other invites the confusion
// that produced the "Unknown customer" bug in the first place.
//
// `paid_at`: read by the paid-invoice watermark (src/app/api/cron/sync/route.ts)
// to advance sync_cursors["invoices_paid"], and rendered on each Slack line so
// a reconcile-run alert cannot be mistaken for a payment that just landed.
export interface HcpInvoice {
  id: string;
  job_id?: string;
  customer?: {
    id: string;
    first_name?: string | null;
    last_name?: string | null;
    company?: string | null;
  };
  status?: string;
  amount?: number;
  invoice_number?: string;
  due_at?: string;
  paid_at?: string;
  updated_at?: string; // ISO; drives incremental cursor sync
}

export interface HcpLead {
  id: string;
  customer?: { id: string };
  status?: string;
  lead_source?: string;
  created_at?: string;
  updated_at?: string; // ISO; drives incremental cursor sync
}

export interface HcpListResponse {
  page: number;
  total_pages: number;
  [resourceKey: string]: unknown;
}
