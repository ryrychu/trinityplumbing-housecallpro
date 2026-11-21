// Housecall Pro price book WRITES, used only by the Trinity Price Book Editor
// (src/lib/mcp/pricebookEdit). The read client (./pricebook.ts) stays GET-only.
//
// Checked against housecall.v1.yaml (2026-11-21):
//   PUT  /api/price_book/materials/{uuid}   body: name, description, price, cost,
//        unit_of_measure, part_number, flat_rate_enabled, taxable (money in cents)
//   POST /api/price_book/materials?material_category_uuid=…   same body
//   There is no single-material GET (that path is PUT/DELETE only), so
//   getMaterial lists the category. Services have no write endpoint at all.
// This module never calls DELETE.
import { normalizeMaterial, type PricebookItem } from "@/lib/mcp/pricebook";
import type { HcpMaterial } from "./pricebook";

const BASE_URL = "https://api.housecallpro.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export type HcpMaterialFields = {
  name?: string;
  description?: string;
  price?: number;
  cost?: number;
  unit_of_measure?: string;
  part_number?: string;
  taxable?: boolean;
};

// Status and a templated path only: HCP error bodies are never forwarded.
export class HcpWriteError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string) {
    super(`Housecall Pro price book write failed (status ${status}) on ${path}`);
    this.name = "HcpWriteError";
    this.status = status;
    this.path = path;
  }
}

export class HousecallPricebookWriter {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey?: string, fetchImpl: typeof fetch = fetch) {
    const key = apiKey ?? process.env.HOUSECALL_API_KEY;
    if (!key) throw new Error("Missing env var: HOUSECALL_API_KEY");
    this.apiKey = key;
    this.fetchImpl = fetchImpl;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  async updateMaterial(uuid: string, fields: HcpMaterialFields): Promise<void> {
    const path = "/api/price_book/materials/{uuid}";
    const res = await this.fetchImpl(`${BASE_URL}/api/price_book/materials/${encodeURIComponent(uuid)}`, {
      method: "PUT",
      headers: this.headers(true),
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new HcpWriteError(res.status, path);
  }

  // HCP requires material_category_uuid (query and body), name, price and cost.
  async createMaterial(categoryUuid: string, fields: HcpMaterialFields & { name: string; price: number; cost: number }): Promise<{ uuid: string }> {
    const path = "/api/price_book/materials";
    const qs = new URLSearchParams({ material_category_uuid: categoryUuid });
    const res = await this.fetchImpl(`${BASE_URL}${path}?${qs}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ material_category_uuid: categoryUuid, ...fields }),
    });
    if (!res.ok) throw new HcpWriteError(res.status, path);
    const body = (await res.json().catch(() => null)) as { uuid?: unknown } | null;
    if (!body || typeof body.uuid !== "string") throw new HcpWriteError(502, path);
    return { uuid: body.uuid };
  }

  async getMaterial(uuid: string, categoryUuid: string): Promise<PricebookItem | null> {
    const path = "/api/price_book/materials";
    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE), material_category_uuid: categoryUuid });
      const res = await this.fetchImpl(`${BASE_URL}${path}?${qs}`, { method: "GET", headers: this.headers(false) });
      if (!res.ok) throw new HcpWriteError(res.status, path);
      const json = (await res.json()) as Record<string, unknown>;
      const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.materials) ? json.materials : [];
      const hit = (raw as HcpMaterial[]).find((m) => m.uuid === uuid);
      if (hit) return { ...normalizeMaterial(hit), categoryUuid };
      const total = typeof json.total_pages_count === "number" ? json.total_pages_count : undefined;
      if (total !== undefined ? page >= total : raw.length === 0) return null;
    }
    return null;
  }

  // Every material in one category (up to MAX_PAGES pages), for batches that
  // re-read many items in the same category.
  async listMaterials(categoryUuid: string): Promise<PricebookItem[]> {
    const path = "/api/price_book/materials";
    const out: PricebookItem[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const qs = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE), material_category_uuid: categoryUuid });
      const res = await this.fetchImpl(`${BASE_URL}${path}?${qs}`, { method: "GET", headers: this.headers(false) });
      if (!res.ok) throw new HcpWriteError(res.status, path);
      const json = (await res.json()) as Record<string, unknown>;
      const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.materials) ? json.materials : [];
      for (const m of raw as HcpMaterial[]) out.push({ ...normalizeMaterial(m), categoryUuid });
      const total = typeof json.total_pages_count === "number" ? json.total_pages_count : undefined;
      if (total !== undefined ? page >= total : raw.length === 0) break;
    }
    return out;
  }
}
