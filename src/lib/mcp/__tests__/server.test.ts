import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPricebookMcpServer } from "../server";
import { HcpPricebookError } from "@/lib/housecall/pricebook";
import type { Pricebook, PricebookItem, PricebookLoader } from "../pricebook";

function item(over: Partial<PricebookItem>): PricebookItem {
  return {
    kind: "service",
    uuid: over.name ?? "x",
    name: "Drain cleaning",
    category: "Drains",
    description: "Clear a clogged main line with a cable machine.",
    priceCents: 17500,
    costCents: null,
    unit: null,
    partNumber: null,
    updatedAt: null,
    taxable: null,
    ...over,
  };
}

const BOOK: Pricebook = {
  truncated: false,
  loadedAt: "2026-11-13T00:00:00.000Z",
  items: [
    item({ name: "Drain cleaning" }),
    item({ name: "Water heater flush", category: "Water Heaters", description: "Flush sediment from the tank.", priceCents: 0 }),
    item({ kind: "material", name: "PEX 1/2 in", category: "PEX Pipe", priceCents: 150, costCents: 90 }),
    item({ kind: "material", name: "Ball valve", category: "Valves", priceCents: 2500, costCents: 900 }),
  ],
};

async function connect(load: PricebookLoader) {
  const server = createPricebookMcpServer(load);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function text(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0].text;
}

describe("createPricebookMcpServer", () => {
  it("exposes exactly the four read-only tools", async () => {
    const client = await connect(async () => BOOK);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "list_materials",
      "list_services",
      "pricebook_audit_report",
      "search_pricebook",
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("returns audit counts", async () => {
    const client = await connect(async () => BOOK);
    const body = JSON.parse(text(await client.callTool({ name: "pricebook_audit_report", arguments: {} })));
    expect(body.totalItems).toBe(4);
    expect(body.counts.zero_price).toBe(1);
    expect(body.findings.zero_price[0]).toMatchObject({ name: "Water heater flush", price: "$0.00", priceCents: 0 });
    expect(body.staleCheck).toMatch(/^unavailable/);
  });

  it("searches and filters materials by category", async () => {
    const client = await connect(async () => BOOK);
    const search = JSON.parse(text(await client.callTool({ name: "search_pricebook", arguments: { query: "drain" } })));
    expect(search.items.map((i: { name: string }) => i.name)).toEqual(["Drain cleaning"]);

    const mats = JSON.parse(text(await client.callTool({ name: "list_materials", arguments: { category: "pex" } })));
    expect(mats.items.map((i: { name: string }) => i.name)).toEqual(["PEX 1/2 in"]);
    expect(mats.items[0].price).toBe("$1.50");

    const services = JSON.parse(text(await client.callTool({ name: "list_services", arguments: {} })));
    expect(services.count).toBe(2);
  });

  it("reports HCP failures with the status only", async () => {
    const client = await connect(async () => {
      throw new HcpPricebookError(429, "/api/price_book/services");
    });
    const res = await client.callTool({ name: "list_services", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("status 429");
    expect(text(res)).not.toContain("/api/");
  });

  it("hides unexpected errors behind a generic message", async () => {
    const client = await connect(async () => {
      throw new Error("secret internals");
    });
    const res = await client.callTool({ name: "search_pricebook", arguments: { query: "x" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Price book lookup failed. Try again in a minute.");
  });

  it("says when the price book was truncated", async () => {
    const client = await connect(async () => ({ ...BOOK, truncated: true }));
    const body = JSON.parse(text(await client.callTool({ name: "list_services", arguments: {} })));
    expect(body.truncated).toBe(true);
    expect(body.note).toMatch(/too large/);
  });
});
