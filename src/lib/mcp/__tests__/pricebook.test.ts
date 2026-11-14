import { describe, it, expect, vi } from "vitest";
import {
  normalizeService,
  normalizeMaterial,
  createPricebookLoader,
  searchPricebook,
  auditPricebook,
  formatMoney,
  type PricebookItem,
} from "../pricebook";

function item(over: Partial<PricebookItem>): PricebookItem {
  return {
    kind: "service",
    uuid: Math.random().toString(36).slice(2),
    name: "Drain cleaning",
    category: "Drains",
    description: "Clear a clogged main line with a cable machine.",
    priceCents: 17500,
    costCents: 2000,
    unit: null,
    partNumber: null,
    updatedAt: null,
    taxable: false,
    ...over,
  };
}

describe("normalize", () => {
  it("maps a service and fills gaps", () => {
    const s = normalizeService({ uuid: "s1", name: "  Water heater flush ", price: 15000, category: { name: "Water Heaters" } });
    expect(s).toEqual({
      kind: "service",
      uuid: "s1",
      name: "Water heater flush",
      category: "Water Heaters",
      description: "",
      priceCents: 15000,
      costCents: null,
      unit: null,
      partNumber: null,
      updatedAt: null,
      taxable: null,
    });
  });

  it("maps a material, preferring its own category name over the walked one", () => {
    expect(normalizeMaterial({ uuid: "m1", name: "PEX 1/2", material_category_name: "PEX" }, "Walked").category).toBe("PEX");
    expect(normalizeMaterial({ uuid: "m2", name: "Valve", part_number: "V-1", cost: 500, updated_at: "2026-01-01T00:00:00Z" }, "Valves")).toMatchObject({
      kind: "material",
      category: "Valves",
      partNumber: "V-1",
      costCents: 500,
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });
});

function fakeClient() {
  return {
    listServices: vi.fn(async () => ({ items: [{ uuid: "s1", name: "Service" }], truncated: false })),
    listMaterialCategories: vi.fn(async (parent?: string) => {
      if (!parent) return { items: [{ uuid: "c1", name: "Pipe" }, { uuid: "c2", name: "Valves" }], truncated: false };
      if (parent === "c1") return { items: [{ uuid: "c1a", name: "PEX" }], truncated: false };
      return { items: [], truncated: false };
    }),
    listMaterials: vi.fn(async (cat: string) => ({ items: [{ uuid: `m-${cat}`, name: `Material ${cat}` }], truncated: false })),
  };
}

describe("createPricebookLoader", () => {
  it("walks the category tree and merges services and materials", async () => {
    const client = fakeClient();
    const book = await createPricebookLoader(client)();
    expect(book.items.map((i) => i.uuid).sort()).toEqual(["m-c1", "m-c1a", "m-c2", "s1"]);
    expect(book.items.find((i) => i.uuid === "m-c1a")?.category).toBe("PEX");
    expect(book.truncated).toBe(false);
    expect(client.listMaterialCategories).toHaveBeenCalledWith("c1");
  });

  it("stops at maxCategories and marks the result truncated", async () => {
    const book = await createPricebookLoader(fakeClient(), { maxCategories: 1 })();
    expect(book.truncated).toBe(true);
    expect(book.items.filter((i) => i.kind === "material")).toHaveLength(1);
  });

  it("marks truncated when any list was truncated", async () => {
    const client = fakeClient();
    client.listServices.mockResolvedValueOnce({ items: [], truncated: true });
    expect((await createPricebookLoader(client)()).truncated).toBe(true);
  });

  it("caches for ttlMs and does not cache failures", async () => {
    let t = 0;
    const client = fakeClient();
    const load = createPricebookLoader(client, { ttlMs: 1000, now: () => t });
    await load();
    await load();
    expect(client.listServices).toHaveBeenCalledTimes(1);
    t = 1001;
    await load();
    expect(client.listServices).toHaveBeenCalledTimes(2);

    const failing = fakeClient();
    failing.listServices.mockRejectedValueOnce(new Error("boom"));
    const load2 = createPricebookLoader(failing, { now: () => 0 });
    await expect(load2()).rejects.toThrow("boom");
    await expect(load2()).resolves.toBeDefined();
  });
});

describe("searchPricebook", () => {
  const items = [
    item({ name: "Water heater install", kind: "service" }),
    item({ name: "Anode rod", kind: "material", partNumber: "WH-ANODE", category: "Water Heaters", description: "" }),
    item({ name: "Drain snake", description: "Cable rental" }),
  ];

  it("matches name, description, category and part number case-insensitively", () => {
    expect(searchPricebook(items, "WATER").map((i) => i.name)).toEqual(["Water heater install", "Anode rod"]);
    expect(searchPricebook(items, "wh-anode")).toHaveLength(1);
    expect(searchPricebook(items, "cable")).toHaveLength(2);
  });

  it("respects kind and limit, and returns nothing for a blank query", () => {
    expect(searchPricebook(items, "water", "material").map((i) => i.name)).toEqual(["Anode rod"]);
    expect(searchPricebook(items, "a", undefined, 1)).toHaveLength(1);
    expect(searchPricebook(items, "   ")).toEqual([]);
  });
});

describe("auditPricebook", () => {
  const now = new Date("2026-11-13T00:00:00Z");

  it("flags each rule", () => {
    const items = [
      item({ name: "Free thing", priceCents: 0 }),
      item({ name: "No price", priceCents: null }),
      item({ name: "Loss leader", priceCents: 1000, costCents: 5000 }),
      item({ name: "Blank", description: "  " }),
      item({ name: "Terse", description: "Unclog." }),
      item({ name: "Dup", kind: "material" }),
      item({ name: " dup ", kind: "material" }),
      item({ name: "Dup", kind: "service" }),
      item({ name: "Old", updatedAt: "2024-01-01T00:00:00Z" }),
      item({ name: "Fresh", updatedAt: "2026-10-01T00:00:00Z" }),
    ];
    const r = auditPricebook(items, { now });
    expect(r.totalItems).toBe(10);
    expect(r.findings.zero_price.map((i) => i.name)).toEqual(["Free thing", "No price"]);
    expect(r.findings.below_cost.map((i) => i.name)).toEqual(["Loss leader"]);
    expect(r.findings.missing_description.map((i) => i.name)).toEqual(["Blank"]);
    expect(r.findings.short_description.map((i) => i.name)).toEqual(["Terse"]);
    expect(r.findings.duplicate_name.map((i) => i.name)).toEqual(["Dup", " dup "]);
    expect(r.findings.stale.map((i) => i.name)).toEqual(["Old"]);
    expect(r.staleCheck).toBe("ran");
    expect(r.counts.zero_price).toBe(2);
  });

  it("does not flag below_cost when cost is zero or unknown", () => {
    const r = auditPricebook([item({ priceCents: 100, costCents: 0 }), item({ priceCents: 100, costCents: null })], { now });
    expect(r.counts.below_cost).toBe(0);
  });

  it("reports the stale check as unavailable when HCP gives no dates", () => {
    const r = auditPricebook([item({})], { now });
    expect(r.staleCheck).toBe("unavailable");
    expect(r.counts.stale).toBe(0);
  });

  it("honours staleMonths", () => {
    const r = auditPricebook([item({ updatedAt: "2026-08-01T00:00:00Z" })], { now, staleMonths: 2 });
    expect(r.counts.stale).toBe(1);
  });
});

describe("formatMoney", () => {
  it("formats cents as dollars", () => {
    expect(formatMoney(123450)).toBe("$1,234.50");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(null)).toBe("n/a");
  });
});
