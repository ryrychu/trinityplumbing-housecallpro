// The MCP server for the ChatGPT jobs & customers connector: read-only lookups
// over Trinity's Supabase copy of HouseCall Pro. Every tool wraps an existing
// query function; nothing here queries the database itself.
// Spec: docs/superpowers/specs/2026-11-17-chatgpt-jobs-connector-design.md
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CustomerDetail } from "@/lib/mobile/customers";
import type { JobDetail } from "@/lib/mobile/jobDetail";
import type { EstimateHit, InvoiceHit } from "@/lib/mobile/money";
import type { MirrorResource } from "@/lib/mobile/mirrorFreshness";
import type { DashboardSnapshot, TodayScheduleRow } from "@/lib/dashboard/queries";
import { localDateKey } from "@/lib/notifications/schedule";
import { dayLabelFromKey, timeLabel } from "@/lib/slack/format";
import { formatMoney } from "@/lib/mcp/pricebook";
import { scheduleStatus } from "@/lib/dashboard/queries";
import {
  JOB_MATCH_LIMIT,
  customerName,
  formatAddress,
  matchCustomer,
  matchJob,
  rankCustomers,
  rankJobs,
  searchNote,
  searchTerms,
  termsMatched,
  type CustomerCandidate,
  type CustomerMatch,
  type JobCandidate,
  type JobMatchOn,
  type Match,
} from "./search";
import type { Candidates } from "./searchQueries";

export interface ScheduleDay {
  dateKey: string;
  rows: TodayScheduleRow[];
}

export type Revenue = Pick<DashboardSnapshot, "revenueBookedThisWeekCents" | "revenueScheduledNextWeekCents">;

// Injected so tests can stub every lookup without touching Supabase.
export interface JobsDeps {
  findCustomerCandidates(terms: string[], phoneDigits: string | null): Promise<Candidates<CustomerCandidate>>;
  findJobCandidates(terms: string[]): Promise<Candidates<JobCandidate>>;
  getCustomerDetail(id: string): Promise<CustomerDetail | null>;
  getJobDetail(id: string): Promise<JobDetail | null>;
  getScheduleDays(anchor: Date, days: number): Promise<ScheduleDay[]>;
  listOpenEstimates(): Promise<EstimateHit[]>;
  listUnpaidInvoices(): Promise<InvoiceHit[]>;
  getRevenue(): Promise<Revenue>;
  mirrorSyncedAt(resources: MirrorResource[]): Promise<string | null>;
  now(): Date;
}

export const CUSTOMER_MATCH_LIMIT = 25;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const SOURCE_NOTE =
  "Data comes from Trinity's copy of HouseCall Pro, updated about every 15 minutes; dataAsOf is when it was last synced. Read-only.";

// Sent to ChatGPT when it connects. MCP can't make ChatGPT ask the user
// anything; this, the tool descriptions and each result's note are how the
// connector gets it to check partial matches before answering.
export const SERVER_INSTRUCTIONS =
  "Trinity Jobs searches Trinity Plumbing's copy of HouseCall Pro. People ask in plain language by business name or street (\"the jobs at Planet Fitness on Aviation Rd\"), and customers are often filed under an owner or company name instead. Use search_jobs for questions about work at a place, and find_customer for questions about a customer. When a result has unmatchedTerms, tell the user which words didn't match, show what did match, and ask them to confirm before answering. When nothing matches, ask for a street, town, customer name or rough date. Never invent jobs or customers that aren't in a result.";

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

function scheduleJob(r: TodayScheduleRow) {
  return {
    id: r.id,
    time: timeLabel(r.scheduledStart),
    scheduledStart: r.scheduledStart,
    customer: r.customerName,
    phone: r.customerPhone,
    address: r.address,
    service: r.service,
    technician: r.technicianName,
    status: r.status,
    zone: r.zone,
  };
}

function customerResult(c: CustomerCandidate, m: CustomerMatch) {
  return {
    id: c.id,
    name: customerName(c),
    company: c.company?.trim() || null,
    phone: c.phone,
    address: c.addresses[0] ? formatAddress(c.addresses[0]) : null,
    addressCount: c.addresses.length,
    matchedAddresses: m.matchedAddresses,
    matched: m.matched,
  };
}

function jobResult(j: JobCandidate, matched: Match<JobMatchOn>[]) {
  return {
    id: j.id,
    date: dateOf(j.scheduledStart),
    time: j.scheduledStart ? timeLabel(j.scheduledStart) : null,
    status: scheduleStatus({ work_status: j.workStatus, raw: { work_timestamps: { on_my_way_at: j.onMyWayAt } } }),
    service: j.jobType?.trim() || j.description?.split("\n")[0]?.trim() || null,
    address: formatAddress({ street: j.street, city: j.city }),
    customer: j.customer?.name ?? null,
    company: j.customer?.company ?? null,
    customerId: j.customerId,
    amount: formatMoney(j.amountCents),
    amountCents: j.amountCents,
    matched,
  };
}

export function createJobsMcpServer(deps: JobsDeps): McpServer {
  const server = new McpServer({ name: "trinity-jobs", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "find_customer",
    {
      title: "Find customer",
      description: `Find customers by name, company, any saved address, town, tag, note or phone number. Pass the user's words as they said them. Each customer lists which words matched, which saved addresses matched, and the id that get_customer_history needs. Returns up to ${CUSTOMER_MATCH_LIMIT}. ${SOURCE_NOTE}`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .describe("The user's words, e.g. 'Smith', 'planet fitness on aviation rd' or '518 555 0142'."),
      },
      annotations: READ_ONLY,
    },
    async ({ query }) => {
      const words = searchTerms(query);
      // The phone number counts as one more search word when reporting.
      const terms = words.phoneDigits ? [...words.terms, words.phoneDigits] : words.terms;
      if (terms.length === 0) {
        return ok(deps, ["customers"], {
          query,
          terms,
          matchedTerms: [],
          unmatchedTerms: [],
          count: 0,
          truncated: false,
          customers: [],
          note: searchNote("customers", [], [], [], 0, null, false),
        });
      }
      try {
        const { candidates, capped } = await deps.findCustomerCandidates(words.terms, words.phoneDigits);
        const ranked = rankCustomers(
          candidates
            .map((customer) => ({ customer, ...matchCustomer(customer, words.terms, words.phoneDigits) }))
            .filter((r) => r.matched.length > 0)
        );
        const shown = ranked.slice(0, CUSTOMER_MATCH_LIMIT);
        const truncated = ranked.length > CUSTOMER_MATCH_LIMIT || capped;
        const { matchedTerms, unmatchedTerms } = termsMatched(terms, ranked.map((r) => r.matched));
        const note = searchNote(
          "customers",
          terms,
          matchedTerms,
          unmatchedTerms,
          shown.length,
          ranked.length > CUSTOMER_MATCH_LIMIT ? CUSTOMER_MATCH_LIMIT : null,
          capped
        );
        return await ok(deps, ["customers"], {
          query,
          terms,
          matchedTerms,
          unmatchedTerms,
          count: shown.length,
          truncated,
          customers: shown.map((r) => customerResult(r.customer, r)),
          ...(note && { note }),
        });
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

  server.registerTool(
    "get_schedule",
    {
      title: "Schedule",
      description: `Trinity's jobs day by day (Eastern time), the same schedule as the dashboard and /trinity week. Canceled jobs are left out. Optionally only one technician's jobs. ${SOURCE_NOTE}`,
      inputSchema: {
        startDate: z
          .string()
          .regex(/^20\d{2}-\d{2}-\d{2}$/)
          .optional()
          .describe("First day, as YYYY-MM-DD in Eastern time, 2000-2099. Defaults to today."),
        days: z.number().int().min(1).max(14).optional().describe("How many days, 1 to 14. Defaults to 7."),
        technician: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .optional()
          .describe("Only jobs whose technician name contains this text, e.g. 'Dan'."),
      },
      annotations: READ_ONLY,
    },
    async ({ startDate, days, technician }) => {
      // 16:00 UTC is midday Eastern under either offset, so the anchor always
      // falls inside the requested day (the same trick as /trinity in
      // src/lib/slack/commands.ts). Round-tripping through localDateKey also
      // catches dates like 2026-02-30 that the regex lets through.
      let anchor = deps.now();
      if (startDate) {
        anchor = new Date(`${startDate}T16:00:00Z`);
        if (Number.isNaN(anchor.getTime()) || localDateKey(anchor) !== startDate) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `"${startDate}" isn't a real date. Use YYYY-MM-DD, e.g. 2026-11-17.` }],
          };
        }
      }
      const dayCount = days ?? 7;
      const needle = technician?.trim().toLowerCase();

      try {
        const schedule = (await deps.getScheduleDays(anchor, dayCount)).map((d) => {
          const rows = needle
            ? d.rows.filter((r) => (r.technicianName ?? "").toLowerCase().includes(needle))
            : d.rows;
          return { date: d.dateKey, label: dayLabelFromKey(d.dateKey), jobCount: rows.length, jobs: rows.map(scheduleJob) };
        });
        return await ok(deps, ["jobs", "customers"], {
          startDate: schedule[0]?.date ?? startDate ?? localDateKey(anchor),
          days: dayCount,
          technician: technician ?? null,
          totalJobs: schedule.reduce((n, d) => n + d.jobCount, 0),
          schedule,
        });
      } catch (err) {
        return fail("get_schedule", "Couldn't read the schedule just now. Try again in a minute.", err);
      }
    }
  );

  server.registerTool(
    "get_money_summary",
    {
      title: "Money summary",
      description: `Open estimates, unpaid and overdue invoices (most overdue first), and revenue booked this week and scheduled next week. Totals leave out items with no amount; missingAmountCount says how many. ${SOURCE_NOTE}`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const [estimates, invoices, revenue] = await Promise.all([
          deps.listOpenEstimates(),
          deps.listUnpaidInvoices(),
          deps.getRevenue(),
        ]);
        const sum = (rows: { amountCents: number | null }[]) => rows.reduce((t, r) => t + (r.amountCents ?? 0), 0);
        const missing = (rows: { amountCents: number | null }[]) => rows.filter((r) => r.amountCents === null).length;
        const estimatesCents = sum(estimates);
        const invoicesCents = sum(invoices);
        return await ok(deps, ["estimates", "invoices", "jobs"], {
          openEstimates: {
            count: estimates.length,
            total: formatMoney(estimatesCents),
            totalCents: estimatesCents,
            missingAmountCount: missing(estimates),
            items: estimates.map((e) => ({ ...e, amount: formatMoney(e.amountCents) })),
          },
          unpaidInvoices: {
            count: invoices.length,
            overdueCount: invoices.filter((i) => i.overdueDays !== null).length,
            total: formatMoney(invoicesCents),
            totalCents: invoicesCents,
            missingAmountCount: missing(invoices),
            items: invoices.map((i) => ({ ...i, amount: formatMoney(i.amountCents) })),
          },
          revenueBookedThisWeek: formatMoney(revenue.revenueBookedThisWeekCents),
          revenueBookedThisWeekCents: revenue.revenueBookedThisWeekCents,
          revenueScheduledNextWeek: formatMoney(revenue.revenueScheduledNextWeekCents),
          revenueScheduledNextWeekCents: revenue.revenueScheduledNextWeekCents,
        });
      } catch (err) {
        return fail("get_money_summary", "Couldn't read estimates and invoices just now. Try again in a minute.", err);
      }
    }
  );

  server.registerTool(
    "search_jobs",
    {
      title: "Search jobs",
      description: `Find jobs by place, business or kind of work: the job's street, town, description or job type, or the customer's name, company or tag. Pass the user's words as they said them. Each job lists which words matched it. Canceled jobs are included and marked Canceled. Returns up to ${JOB_MATCH_LIMIT}, the jobs matching the most words first, then newest first. ${SOURCE_NOTE}`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .describe("The user's words, e.g. 'planet fitness on aviation rd' or 'water heater in Troy'."),
      },
      annotations: READ_ONLY,
    },
    async ({ query }) => {
      // Jobs have no phone field, so a phone number in the question is ignored here.
      const { terms } = searchTerms(query);
      if (terms.length === 0) {
        return ok(deps, ["jobs", "customers"], {
          query,
          terms,
          matchedTerms: [],
          unmatchedTerms: [],
          count: 0,
          truncated: false,
          jobs: [],
          note: searchNote("jobs", [], [], [], 0, null, false),
        });
      }
      try {
        const { candidates, capped } = await deps.findJobCandidates(terms);
        const ranked = rankJobs(
          candidates.map((job) => ({ job, matched: matchJob(job, terms) })).filter((r) => r.matched.length > 0)
        );
        const shown = ranked.slice(0, JOB_MATCH_LIMIT);
        const truncated = ranked.length > JOB_MATCH_LIMIT || capped;
        const { matchedTerms, unmatchedTerms } = termsMatched(terms, ranked.map((r) => r.matched));
        const note = searchNote(
          "jobs",
          terms,
          matchedTerms,
          unmatchedTerms,
          shown.length,
          ranked.length > JOB_MATCH_LIMIT ? JOB_MATCH_LIMIT : null,
          capped
        );
        return await ok(deps, ["jobs", "customers"], {
          query,
          terms,
          matchedTerms,
          unmatchedTerms,
          count: shown.length,
          truncated,
          jobs: shown.map((r) => jobResult(r.job, r.matched)),
          ...(note && { note }),
        });
      } catch (err) {
        return fail("search_jobs", "Couldn't search jobs just now. Try again in a minute.", err);
      }
    }
  );

  return server;
}
