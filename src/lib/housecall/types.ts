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

export interface HcpEstimate {
  id: string;
  job_id?: string;
  customer?: { id: string };
  status?: string;
  total_amount?: number;
}

export interface HcpInvoice {
  id: string;
  job_id?: string;
  customer?: { id: string };
  status?: string;
  total_amount?: number;
  due_at?: string;
}

export interface HcpListResponse<T> {
  page: number;
  total_pages: number;
  [resourceKey: string]: unknown;
}
