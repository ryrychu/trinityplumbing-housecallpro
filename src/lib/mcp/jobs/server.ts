// The MCP server for the ChatGPT jobs & customers connector: read-only lookups
// over Trinity's Supabase copy of HouseCall Pro. Every tool wraps an existing
// query function; nothing here queries the database itself.
// Spec: docs/superpowers/specs/2026-11-17-chatgpt-jobs-connector-design.md
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CustomerDetail, CustomerHit } from "@/lib/mobile/customers";
import type { JobDetail } from "@/lib/mobile/jobDetail";
import type { EstimateHit, InvoiceHit } from "@/lib/mobile/money";
import type { MirrorResource } from "@/lib/mobile/mirrorFreshness";
import type { DashboardSnapshot, TodayScheduleRow } from "@/lib/dashboard/queries";
import { localDateKey } from "@/lib/notifications/schedule";
import { timeLabel } from "@/lib/slack/format";
import { formatMoney } from "@/lib/mcp/pricebook";

export interface ScheduleDay {
  dateKey: string;
  rows: TodayScheduleRow[];
}

export type Revenue = Pick<DashboardSnapshot, "revenueBookedThisWeekCents" | "revenueScheduledNextWeekCents">;

// Injected so tests can stub every lookup without touching Supabase.
export interface JobsDeps {
  searchCustomers(query: string): Promise<CustomerHit[]>;
  getCustomerDetail(id: string): Promise<CustomerDetail | null>;
  getJobDetail(id: string): Promise<JobDetail | null>;
  getScheduleDays(anchor: Date, days: number): Promise<ScheduleDay[]>;
  listOpenEstimates(): Promise<EstimateHit[]>;
  listUnpaidInvoices(): Promise<InvoiceHit[]>;
  getRevenue(): Promise<Revenue>;
  mirrorSyncedAt(resources: MirrorResource[]): Promise<string | null>;
  now(): Date;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const SOURCE_NOTE =
  "Data comes from Trinity's copy of HouseCall Pro, updated about every 15 minutes; dataAsOf is when it was last synced. Read-only.";

type ToolResult = { isError?: boolean; content: { type: "text"; text: string }[] };

function dateOf(iso: string | null): string | null {
  return iso ? localDateKey(new Date(iso)) : null;
}

// Every successful result carries the age of the data it came from.
async function ok(deps: JobsDeps, resources: MirrorResource[], body: Record<string, unknown>): Promise<ToolResult> {
  const dataAsOf = await deps.mirrorSyncedAt(resources).catch(() => null);
  return { content: [{ type: "text", text: JSON.stringify({ ...body, dataAsOf }, null, 2) }] };
}

// A fixed message for ChatGPT; the real error goes to the server log only. The
// query layer's error text can include customer rows, so it never leaves here.
function fail(tool: string, message: string, err: unknown): ToolResult {
  console.error(`[mcp-jobs] ${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function createJobsMcpServer(deps: JobsDeps): McpServer {
  const server = new McpServer({ name: "trinity-jobs", version: "1.0.0" });

  server.registerTool(
    "find_customer",
    {
      title: "Find customer",
      description: `Find Trinity Plumbing customers by name or phone number. Returns up to 25 matches, each with the id that get_customer_history needs. ${SOURCE_NOTE}`,
      inputSchema: {
        query: z.string().min(1).max(100).describe("A name or phone number, e.g. 'Smith' or '518 555 0142'."),
      },
      annotations: READ_ONLY,
    },
    async ({ query }) => {
      try {
        const customers = await deps.searchCustomers(query);
        return await ok(deps, ["customers"], { query, count: customers.length, customers });
      } catch (err) {
        return fail("find_customer", "Couldn't search customers just now. Try again in a minute.", err);
      }
    }
  );

  server.registerTool(
    "get_customer_history",
    {
      title: "Customer history",
      description: `One customer's contact details, lifetime spend and every job Trinity has done or scheduled for them. Get the id from find_customer. ${SOURCE_NOTE}`,
      inputSchema: {
        customerId: z.string().min(1).max(100).describe("The customer id from find_customer."),
      },
      annotations: READ_ONLY,
    },
    async ({ customerId }) => {
      try {
        const c = await deps.getCustomerDetail(customerId);
        if (!c) {
          return await ok(deps, ["customers"], {
            found: false,
            customerId,
            note: "No customer with that id. Use find_customer to look up the id.",
          });
        }
        return await ok(deps, ["customers", "jobs"], {
          found: true,
          customer: { id: c.id, name: c.name, company: c.company, phone: c.phone, email: c.email, address: c.address },
          lifetime: formatMoney(c.lifetimeCents),
          lifetimeCents: c.lifetimeCents,
          jobCount: c.jobs.length,
          jobs: c.jobs.map((j) => ({
            id: j.id,
            date: dateOf(j.scheduledStart),
            scheduledStart: j.scheduledStart,
            service: j.service,
            status: j.status,
            amount: formatMoney(j.amountCents),
            amountCents: j.amountCents,
          })),
        });
      } catch (err) {
        return fail("get_customer_history", "Couldn't read that customer's history just now. Try again in a minute.", err);
      }
    }
  );

  server.registerTool(
    "get_job",
    {
      title: "Job details",
      description: `One job in full: customer, address, technician, date and time (Eastern), service, status, amount, invoice and the notes written on it. Job ids come from get_customer_history or get_schedule. ${SOURCE_NOTE}`,
      inputSchema: {
        jobId: z.string().min(1).max(100).describe("The job id from get_customer_history or get_schedule."),
      },
      annotations: READ_ONLY,
    },
    async ({ jobId }) => {
      try {
        const j = await deps.getJobDetail(jobId);
        if (!j) {
          return await ok(deps, ["jobs"], {
            found: false,
            jobId,
            note: "No job with that id. Job ids come from get_customer_history or get_schedule.",
          });
        }
        return await ok(deps, ["jobs", "invoices"], {
          found: true,
          job: {
            id: j.id,
            customerId: j.customerId,
            customerName: j.customerName,
            customerPhone: j.customerPhone,
            address: j.address,
            technician: j.technicianName,
            service: j.service,
            status: j.status,
            date: dateOf(j.scheduledStart),
            time: j.scheduledStart ? timeLabel(j.scheduledStart) : null,
            scheduledStart: j.scheduledStart,
            scheduledEnd: j.scheduledEnd,
            amount: formatMoney(j.amountCents),
            amountCents: j.amountCents,
            invoice: j.invoice
              ? {
                  id: j.invoice.id,
                  status: j.invoice.status,
                  amount: formatMoney(j.invoice.amountCents),
                  amountCents: j.invoice.amountCents,
                }
              : null,
            notes: j.notes,
          },
        });
      } catch (err) {
        return fail("get_job", "Couldn't read that job just now. Try again in a minute.", err);
      }
    }
  );

  return server;
}
