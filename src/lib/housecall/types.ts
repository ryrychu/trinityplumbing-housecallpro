export interface HcpCustomer {
  id: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  email?: string;
  mobile_number?: string;
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
  address?: { latitude?: number; longitude?: number };
  notes?: Array<{ id: string; content: string; created_at: string }>;
  attachments?: Array<{ id: string; url: string; content_type: string }>;
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
  options?: Array<{ total_amount?: number; approval_status?: string; status?: string }>;
}

// Confirmed against the live account (Task 0): invoices use `amount` (not
// `total_amount`) and carry no top-level customer/job link — they associate
// with a job via a shared `invoice_number`.
export interface HcpInvoice {
  id: string;
  job_id?: string;
  customer?: { id: string };
  status?: string;
  amount?: number;
  due_at?: string;
}

export interface HcpListResponse {
  page: number;
  total_pages: number;
  [resourceKey: string]: unknown;
}
