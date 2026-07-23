import { NextResponse } from "next/server";
import { HousecallClient } from "@/lib/housecall/client";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import { mapCustomer, mapEmployee, mapJob, mapEstimate, mapInvoice } from "@/lib/sync/mappers";

async function syncAllPages<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; page: number; totalPages: number }>,
  table: string,
  mapper: (x: T) => Record<string, unknown>
) {
  const supabase = getSupabaseServerClient();
  let page = 1;
  let totalPages = 1;

  do {
    const result = await fetchPage(page);
    totalPages = result.totalPages;

    if (result.items.length > 0) {
      const rows = result.items.map(mapper);
      const { error } = await supabase.from(table).upsert(rows);
      if (error) {
        throw new Error(`Backfill upsert failed for ${table} page ${page}: ${error.message}`);
      }
    }

    page += 1;
  } while (page <= totalPages);
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hcp = new HousecallClient();

  await syncAllPages((p) => hcp.listCustomers(p), "customers", mapCustomer);
  await syncAllPages((p) => hcp.listEmployees(p), "technicians", mapEmployee);
  await syncAllPages((p) => hcp.listJobs(p), "jobs", mapJob);
  await syncAllPages((p) => hcp.listEstimates(p), "estimates", mapEstimate);
  await syncAllPages((p) => hcp.listInvoices(p), "invoices", mapInvoice);

  return NextResponse.json({ ok: true, syncedAt: new Date().toISOString() }, { status: 200 });
}
