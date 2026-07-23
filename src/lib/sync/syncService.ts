import { getSupabaseServerClient } from "@/lib/supabase/client";
import { mapCustomer, mapEmployee, mapJob, mapEstimate, mapInvoice } from "./mappers";
import { buildGeocodeTargets } from "./geocodeSpecs";
import { enrichRowsWithGeocode } from "@/lib/geo/geocode";
import type { HcpCustomer, HcpJob, HcpEstimate, HcpInvoice } from "@/lib/housecall/types";

type SyncConfig = { table: string; mapper: (x: unknown) => Record<string, unknown> };

const TABLE_AND_MAPPER: Record<string, SyncConfig> = {
  customers: { table: "customers", mapper: (x) => mapCustomer(x as HcpCustomer) },
  employees: { table: "technicians", mapper: (x) => mapEmployee(x as Parameters<typeof mapEmployee>[0]) },
  jobs: { table: "jobs", mapper: (x) => mapJob(x as HcpJob) },
  estimates: { table: "estimates", mapper: (x) => mapEstimate(x as HcpEstimate) },
  invoices: { table: "invoices", mapper: (x) => mapInvoice(x as HcpInvoice) },
};

export async function syncOneRecord(resource: string, event: string, data: unknown) {
  const config = TABLE_AND_MAPPER[resource];
  if (!config) {
    throw new Error(`Unknown Housecall Pro resource for sync: ${resource}`);
  }

  const supabase = getSupabaseServerClient();
  const row = config.mapper(data);

  // Geocode this record's address (customers/jobs) before upserting. One record,
  // so at most one network call; cache hits are free.
  const targets = buildGeocodeTargets(resource, [data], [row]);
  if (targets.length > 0) {
    await enrichRowsWithGeocode(supabase, targets, { remaining: 1 });
  }

  const { error } = await supabase.from(config.table).upsert(row);

  if (error) {
    throw new Error(`Failed to upsert ${config.table} row from event ${event}: ${error.message}`);
  }
}
