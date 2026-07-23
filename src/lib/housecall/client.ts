// Housecall Pro API client.
//
// Confirmed API shape (Task 0): base URL, list response envelope, and
// pagination params are recorded here once verified against the live account.
// Assumptions from the Phase 1 plan until Task 0 confirms otherwise:
//   - Base URL: https://api.housecallpro.com
//   - Auth: Authorization: Bearer <HOUSECALL_API_KEY>
//   - Pagination: ?page=<n>&page_size=<n>
//   - List envelope: { <resource>: [...], page, total_pages }
// If the live check finds different values, update BASE_URL and the request()
// method below; the rest of the codebase depends only on this file's interface.
import { HcpCustomer, HcpEmployee, HcpJob, HcpEstimate, HcpInvoice } from "./types";

const BASE_URL = "https://api.housecallpro.com";

interface ListResult<T> {
  items: T[];
  page: number;
  totalPages: number;
}

export class HousecallClient {
  private apiKey: string;

  constructor() {
    const key = process.env.HOUSECALL_API_KEY;
    if (!key) throw new Error("Missing env var: HOUSECALL_API_KEY");
    this.apiKey = key;
  }

  private async request<T>(
    path: string,
    resourceKey: string,
    page = 1,
    sorted = false
  ): Promise<ListResult<T>> {
    // HCP has no modified-since filter but honors sort_by/sort_direction (Task 0
    // / item 4 probe). Newest-first ordering lets the cron stop paging early once
    // it reaches records older than its cursor.
    const sort = sorted ? "&sort_by=updated_at&sort_direction=desc" : "";
    const res = await fetch(`${BASE_URL}${path}?page=${page}&page_size=50${sort}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Housecall Pro API error ${res.status} on ${path}: ${body}`);
    }

    const json = await res.json();
    return {
      items: (json[resourceKey] ?? []) as T[],
      page: json.page ?? page,
      totalPages: json.total_pages ?? page,
    };
  }

  // The four incremental resources are fetched newest-first so the cron can
  // stop early at its cursor. Employees (6 rows) stay a plain full resync.
  listCustomers(page = 1) {
    return this.request<HcpCustomer>("/customers", "customers", page, true);
  }

  listEmployees(page = 1) {
    return this.request<HcpEmployee>("/employees", "employees", page);
  }

  listJobs(page = 1) {
    return this.request<HcpJob>("/jobs", "jobs", page, true);
  }

  listEstimates(page = 1) {
    return this.request<HcpEstimate>("/estimates", "estimates", page, true);
  }

  listInvoices(page = 1) {
    return this.request<HcpInvoice>("/invoices", "invoices", page, true);
  }
}
