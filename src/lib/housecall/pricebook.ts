// Read-only Housecall Pro price book client, used by the ChatGPT connector
// (src/lib/mcp/). Deliberately separate from HousecallClient: that one feeds
// the Supabase sync; this one is called live per ChatGPT request.
//
// GET ONLY. The connector is read-only by design (see
// docs/superpowers/specs/2026-11-13-chatgpt-pricebook-connector-design.md).
// Do not add create/update/delete methods here; a test enforces it.

const BASE_URL = "https://api.housecallpro.com";
const PAGE_SIZE = 100;
export const MAX_PAGES = 40;

export interface HcpPricebookService {
  uuid: string;
  name?: string;
  description?: string;
  task_number?: string;
  price?: number; // cents, per HCP's money convention
  cost?: number;
  unit_of_measure?: string;
  taxable?: boolean;
  category?: { uuid?: string; name?: string } | null;
  updated_at?: string;
  created_at?: string;
}

export interface HcpMaterialCategory {
  uuid: string;
  name?: string;
  parent_uuid?: string | null;
}

export interface HcpMaterial {
  uuid: string;
  name?: string;
  description?: string;
  price?: number;
  cost?: number;
  unit_of_measure?: string;
  part_number?: string;
  material_category_uuid?: string;
  material_category_name?: string;
  taxable?: boolean;
  updated_at?: string;
  created_at?: string;
}

export interface ListAll<T> {
  items: T[];
  truncated: boolean;
}

// The message carries only the status: HCP error bodies are never forwarded
// to ChatGPT.
export class HcpPricebookError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`Housecall Pro price book request failed (status ${status}) on ${path}`);
    this.name = "HcpPricebookError";
    this.status = status;
  }
}

export class HousecallPricebookClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey?: string, fetchImpl: typeof fetch = fetch) {
    const key = apiKey ?? process.env.HOUSECALL_API_KEY;
    if (!key) throw new Error("Missing env var: HOUSECALL_API_KEY");
    this.apiKey = key;
    this.fetchImpl = fetchImpl;
  }

  listServices(): Promise<ListAll<HcpPricebookService>> {
    return this.listAll<HcpPricebookService>("/api/price_book/services", "services", {});
  }

  listMaterialCategories(parentUuid?: string): Promise<ListAll<HcpMaterialCategory>> {
    const params: Record<string, string> = parentUuid ? { parent_uuid: parentUuid } : {};
    return this.listAll<HcpMaterialCategory>("/api/price_book/material_categories", "material_categories", params);
  }

  listMaterials(categoryUuid: string): Promise<ListAll<HcpMaterial>> {
    return this.listAll<HcpMaterial>("/api/price_book/materials", "materials", {
      material_category_uuid: categoryUuid,
    });
  }

  private async listAll<T>(path: string, resourceKey: string, params: Record<string, string>): Promise<ListAll<T>> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE), ...params });
      const res = await this.fetchImpl(`${BASE_URL}${path}?${qs}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      });
      if (!res.ok) throw new HcpPricebookError(res.status, path);

      const json = (await res.json()) as Record<string, unknown>;
      // The OpenAPI file disagrees with itself on the list envelope (`data`
      // in the schemas, a resource-named key in one response), so accept both.
      const raw = Array.isArray(json.data) ? json.data : Array.isArray(json[resourceKey]) ? json[resourceKey] : [];
      const batch = raw as T[];
      items.push(...batch);

      const totalPages = typeof json.total_pages_count === "number" ? json.total_pages_count : undefined;
      const done = totalPages !== undefined ? page >= totalPages : batch.length === 0;
      if (done) return { items, truncated: false };
    }
    return { items, truncated: true };
  }
}
