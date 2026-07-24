import { getSupabaseServerClient } from "@/lib/supabase/client";
import { mapCustomer, mapEmployee, mapJob, mapEstimate, mapInvoice, mapLead } from "./mappers";
import { buildGeocodeTargets } from "./geocodeSpecs";
import { enrichRowsWithGeocode } from "@/lib/geo/geocode";
import { syncAttachments } from "./attachments";
import type { HcpCustomer, HcpJob, HcpEstimate, HcpInvoice, HcpLead } from "@/lib/housecall/types";

type SyncConfig = { table: string; mapper: (x: unknown) => Record<string, unknown> };

const TABLE_AND_MAPPER: Record<string, SyncConfig> = {
  customers: { table: "customers", mapper: (x) => mapCustomer(x as HcpCustomer) },
  employees: { table: "technicians", mapper: (x) => mapEmployee(x as Parameters<typeof mapEmployee>[0]) },
  jobs: { table: "jobs", mapper: (x) => mapJob(x as HcpJob) },
  estimates: { table: "estimates", mapper: (x) => mapEstimate(x as HcpEstimate) },
  invoices: { table: "invoices", mapper: (x) => mapInvoice(x as HcpInvoice) },
  leads: { table: "leads", mapper: (x) => mapLead(x as HcpLead) },
};

// Housecall Pro's OpenAPI spec does not document the webhook event payload, so
// whether `resource` arrives singular ("job") or plural ("jobs") is unverified.
// Accept either and normalize to the plural key that both TABLE_AND_MAPPER and
// GEOCODE_SPECS are keyed on. The cron backfill always passes plural keys, so
// normalization is a no-op there.
const RESOURCE_ALIASES: Record<string, string> = {
  customer: "customers",
  employee: "employees",
  job: "jobs",
  estimate: "estimates",
  invoice: "invoices",
  lead: "leads",
  pro: "employees",
};

function normalizeResource(resource: string): string {
  const key = resource.toLowerCase();
  return RESOURCE_ALIASES[key] ?? key;
}

export async function syncOneRecord(
  resource: string,
  event: string,
  data: unknown,
  action?: string
) {
  // Normalize once, up front: buildGeocodeTargets is keyed on the same strings
  // as TABLE_AND_MAPPER and returns [] for an unrecognized resource. Looking the
  // two up under different spellings would silently skip geocoding.
  const key = normalizeResource(resource);

  const config = TABLE_AND_MAPPER[key];
  if (!config) {
    throw new Error(`Unknown Housecall Pro resource for sync: ${resource}`);
  }

  const supabase = getSupabaseServerClient();

  // Delete events carry the record id; remove the row (and any attachments)
  // instead of upserting. syncOneRecord only ever upserted before, so a delete
  // event would otherwise re-insert the record.
  if (action === "deleted") {
    const id = (data as { id?: string })?.id;
    if (!id) throw new Error(`Delete event ${event} has no record id`);
    const { error } = await supabase.from(config.table).delete().eq("id", id);
    if (error) {
      throw new Error(`Failed to delete ${config.table} ${id} from event ${event}: ${error.message}`);
    }
    if (key === "customers" || key === "jobs") {
      await supabase
        .from("attachments")
        .delete()
        .eq("parent_type", key === "jobs" ? "job" : "customer")
        .eq("parent_id", id);
    }
    return;
  }

  const row = config.mapper(data);

  // Geocode this record's address (customers/jobs) before upserting. One record,
  // so at most one network call; cache hits are free.
  const targets = buildGeocodeTargets(key, [data], [row]);
  if (targets.length > 0) {
    await enrichRowsWithGeocode(supabase, targets, { remaining: 1 });
  }

  const { error } = await supabase.from(config.table).upsert(row);
  if (error) {
    throw new Error(`Failed to upsert ${config.table} row from event ${event}: ${error.message}`);
  }

  // Attachments ride embedded on customer/job payloads.
  if (key === "customers") {
    await syncAttachments(supabase, "customer", row.id as string, data);
  } else if (key === "jobs") {
    await syncAttachments(supabase, "job", row.id as string, data);
  }
}
