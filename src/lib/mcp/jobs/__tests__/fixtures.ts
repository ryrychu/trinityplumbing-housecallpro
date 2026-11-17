// Sample rows and a stubbed JobsDeps for the jobs connector tests. Synthetic
// data only: no real customers.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CustomerDetail, CustomerHit } from "@/lib/mobile/customers";
import type { JobDetail } from "@/lib/mobile/jobDetail";
import type { MirrorResource } from "@/lib/mobile/mirrorFreshness";
import type { TodayScheduleRow } from "@/lib/dashboard/queries";
import { createJobsMcpServer, type JobsDeps } from "../server";
import type { CustomerCandidate, JobCandidate } from "../search";

export const SYNCED_AT = "2026-11-17T12:45:00.000Z";
// 8:00 AM Eastern on Tue Nov 17 2026.
export const NOW = new Date("2026-11-17T13:00:00.000Z");

export const CUSTOMER_HIT: CustomerHit = {
  id: "cus_1",
  name: "Pat Example",
  phone: "5185550142",
  address: "12 Elm St, Averill Park",
};

export const CUSTOMER_DETAIL: CustomerDetail = {
  ...CUSTOMER_HIT,
  company: null,
  email: "pat@example.com",
  lifetimeCents: 52500,
  jobs: [
    // 9:30 AM Eastern on Nov 10.
    { id: "job_1", scheduledStart: "2026-11-10T14:30:00Z", service: "Drain cleaning", status: "Completed", amountCents: 17500 },
    { id: "job_2", scheduledStart: null, service: "Water heater repair", status: "Needs Scheduling", amountCents: null },
  ],
};

export const CUSTOMER_CANDIDATE: CustomerCandidate = {
  id: "cus_1",
  firstName: "Pat",
  lastName: "Example",
  company: null,
  phone: "5185550142",
  city: "Averill Park",
  notes: null,
  tags: [],
  addresses: [{ street: "12 Elm St", city: "Averill Park" }],
};

// A gym owner billed under her own name with 13 locations; the Aviation Road
// gym is the 10th saved address. Synthetic, modelled on the case that found
// the gap.
export const GYM_CUSTOMER: CustomerCandidate = {
  id: "cus_gym",
  firstName: "Kay ",
  lastName: "Example",
  company: "Gymco ",
  phone: null,
  city: "Albany",
  notes: null,
  tags: [],
  addresses: Array.from({ length: 13 }, (_, i) =>
    i === 9 ? { street: "99 Aviation Road", city: "Queensbury" } : { street: `${i + 1}0 Main St`, city: "Albany" }
  ),
};

export function jobCandidate(over: Partial<JobCandidate> = {}): JobCandidate {
  return {
    id: "job_x",
    customerId: "cus_gym",
    scheduledStart: null,
    workStatus: "complete rated",
    onMyWayAt: null,
    amountCents: 25000,
    street: "99 Aviation Road",
    city: "Queensbury",
    description: "Commercial Service Call Fee",
    jobType: null,
    customer: { id: "cus_gym", name: "Kay Example", company: "Gymco", tags: [] },
    ...over,
  };
}

const GYM_JOB_DATES = [
  "2026-11-23T18:00:00Z",
  "2026-11-11T19:00:00Z",
  "2026-10-02T16:00:00Z",
  "2026-04-06T15:00:00Z",
  "2026-04-03T13:00:00Z",
  "2026-03-23T19:00:00Z",
  "2026-03-09T17:00:00Z",
  "2026-03-04T20:00:00Z",
  "2025-07-16T17:00:00Z",
  "2025-04-29T15:00:00Z",
];

// Ten jobs at the Aviation Road gym, newest first. Nothing in them says
// "planet" or "fitness", like the real records.
export function gymJobs(): JobCandidate[] {
  return GYM_JOB_DATES.map((d, i) =>
    jobCandidate({ id: `job_g${i + 1}`, scheduledStart: d, workStatus: i === 0 ? "scheduled" : "complete rated" })
  );
}

export const JOB_DETAIL: JobDetail = {
  id: "job_1",
  customerId: "cus_1",
  customerName: "Pat Example",
  customerPhone: "5185550142",
  scheduledStart: "2026-11-10T14:30:00Z",
  scheduledEnd: "2026-11-10T16:00:00Z",
  address: "12 Elm St, Averill Park",
  technicianName: "Dan Tech",
  service: "Drain cleaning",
  status: "Completed",
  amountCents: 17500,
  invoice: { id: "inv_1", status: "paid", amountCents: 17500 },
  notes: [{ content: "Cabled the main line.", author: "Dan Tech", createdAt: "2026-11-10T16:05:00Z" }],
};

export function scheduleRow(over: Partial<TodayScheduleRow>): TodayScheduleRow {
  return {
    id: "job_9",
    scheduledStart: "2026-11-17T14:30:00Z",
    customerName: "Pat Example",
    technicianName: "Dan Tech",
    zone: "Averill Park",
    compass: "E",
    miles: 3,
    driveMinutes: 8,
    address: "12 Elm St, Averill Park",
    service: "Drain cleaning",
    customerPhone: "5185550142",
    status: "Scheduled",
    lat: 42.6,
    lng: -73.5,
    ...over,
  };
}

export function stubDeps(over: Partial<JobsDeps> = {}) {
  const freshnessCalls: MirrorResource[][] = [];
  const deps: JobsDeps = {
    findCustomerCandidates: async () => [CUSTOMER_CANDIDATE],
    findJobCandidates: async () => [],
    getCustomerDetail: async (id) => (id === CUSTOMER_DETAIL.id ? CUSTOMER_DETAIL : null),
    getJobDetail: async (id) => (id === JOB_DETAIL.id ? JOB_DETAIL : null),
    getScheduleDays: async () => [],
    listOpenEstimates: async () => [],
    listUnpaidInvoices: async () => [],
    getRevenue: async () => ({ revenueBookedThisWeekCents: 0, revenueScheduledNextWeekCents: 0 }),
    mirrorSyncedAt: async (resources) => {
      freshnessCalls.push(resources);
      return SYNCED_AT;
    },
    now: () => NOW,
    ...over,
  };
  return { deps, freshnessCalls };
}

export async function connect(deps: JobsDeps) {
  const server = createJobsMcpServer(deps);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

export function text(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0].text;
}
