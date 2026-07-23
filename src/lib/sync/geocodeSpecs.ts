// Which synced resources get geocoded, where their address comes from, and
// which row columns receive the coordinates. Shared by the cron backfill and
// the webhook receiver so both enrich the same way. Keys match the resource
// keys in syncService's TABLE_AND_MAPPER (which equal the table names for the
// two geocoded resources).
import type { AddressParts, GeocodeTarget } from "@/lib/geo/geocode";
import type { HcpCustomer, HcpJob } from "@/lib/housecall/types";

interface GeocodeSpec {
  extract: (item: unknown) => AddressParts;
  latField: string;
  lngField: string;
}

const GEOCODE_SPECS: Record<string, GeocodeSpec> = {
  customers: {
    extract: (item) => {
      const a = (item as HcpCustomer).addresses?.[0];
      return { street: a?.street, city: a?.city, state: a?.state, zip: a?.zip };
    },
    latField: "lat",
    lngField: "lng",
  },
  jobs: {
    extract: (item) => {
      const a = (item as HcpJob).address;
      return { street: a?.street, city: a?.city, state: a?.state, zip: a?.zip };
    },
    latField: "service_address_lat",
    lngField: "service_address_lng",
  },
};

// Build geocode targets for a resource, or [] if the resource isn't geocoded.
// `rows[i]` must be the mapped row for `items[i]`.
export function buildGeocodeTargets(
  resource: string,
  items: unknown[],
  rows: Record<string, unknown>[]
): GeocodeTarget[] {
  const spec = GEOCODE_SPECS[resource];
  if (!spec) return [];
  return items.map((item, i) => ({
    row: rows[i],
    parts: spec.extract(item),
    latField: spec.latField,
    lngField: spec.lngField,
  }));
}
