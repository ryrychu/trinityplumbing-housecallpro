// Real query functions for the jobs connector, plus its kill switch. Kept out
// of server.ts so the tools (and their tests) never import Supabase wiring.
import { getCustomerDetail, searchCustomers } from "@/lib/mobile/customers";
import { getJobDetail } from "@/lib/mobile/jobDetail";
import { listOpenEstimates, listUnpaidInvoices } from "@/lib/mobile/money";
import { mirrorSyncedAt } from "@/lib/mobile/mirrorFreshness";
import { getDashboardSnapshot, getScheduleDays } from "@/lib/dashboard/queries";
import { CUSTOMER_MATCH_LIMIT, type JobsDeps } from "./server";

export function liveJobsDeps(): JobsDeps {
  return {
    searchCustomers: (query) => searchCustomers(query, CUSTOMER_MATCH_LIMIT),
    getCustomerDetail,
    getJobDetail,
    getScheduleDays,
    listOpenEstimates,
    listUnpaidInvoices: () => listUnpaidInvoices(),
    getRevenue: () => getDashboardSnapshot(),
    mirrorSyncedAt,
    now: () => new Date(),
  };
}

// Off unless exactly "true", like SLACK_ALERTS_ENABLED: the code can deploy
// before customer data is reachable, and unsetting it cuts access.
export function mcpJobsEnabled(): boolean {
  return process.env.MCP_JOBS_ENABLED === "true";
}
