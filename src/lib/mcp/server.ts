// The MCP server ChatGPT talks to: four read-only price book tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HcpPricebookError } from "@/lib/housecall/pricebook";
import {
  auditPricebook,
  formatMoney,
  searchPricebook,
  type Pricebook,
  type PricebookItem,
  type PricebookLoader,
} from "./pricebook";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const TRUNCATED_NOTE =
  "The price book was too large to load completely; some items are missing from this result.";

function row(i: PricebookItem) {
  return {
    kind: i.kind,
    name: i.name,
    category: i.category,
    price: formatMoney(i.priceCents),
    priceCents: i.priceCents,
    cost: formatMoney(i.costCents),
    costCents: i.costCents,
    unit: i.unit,
    partNumber: i.partNumber,
    description: i.description,
    updatedAt: i.updatedAt,
    uuid: i.uuid,
  };
}

function ok(book: Pricebook, body: Record<string, unknown>) {
  const payload = book.truncated ? { truncated: true, note: TRUNCATED_NOTE, ...body } : body;
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown) {
  // Status only. Never the HCP response body, a stack trace, or a credential.
  const text =
    err instanceof HcpPricebookError
      ? `HouseCall Pro price book request failed (status ${err.status}). Try again in a minute.`
      : "Price book lookup failed. Try again in a minute.";
  return { isError: true, content: [{ type: "text" as const, text }] };
}

export function createPricebookMcpServer(load: PricebookLoader): McpServer {
  const server = new McpServer({ name: "trinity-pricebook", version: "1.0.0" });

  server.registerTool(
    "pricebook_audit_report",
    {
      title: "Price book audit",
      description:
        "Check the Trinity Plumbing HouseCall Pro price book for problems: $0 prices, prices below cost, missing or very short descriptions, duplicate names, and items not updated in a long time. Read-only.",
      inputSchema: {
        staleMonths: z.number().int().min(1).max(120).optional().describe("Flag items not updated in this many months (default 12)."),
      },
      annotations: READ_ONLY,
    },
    async ({ staleMonths }) => {
      try {
        const book = await load();
        const report = auditPricebook(book.items, { staleMonths });
        const findings = Object.fromEntries(Object.entries(report.findings).map(([k, v]) => [k, v.map(row)]));
        return ok(book, {
          totalItems: report.totalItems,
          staleCheck:
            report.staleCheck === "ran"
              ? "ran"
              : "unavailable: HouseCall Pro did not return last-updated dates for these items",
          counts: report.counts,
          findings,
          loadedAt: book.loadedAt,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "search_pricebook",
    {
      title: "Search price book",
      description:
        "Search Trinity's HouseCall Pro price book by words in the name, description, category or part number. Returns up to 50 matches. Read-only.",
      inputSchema: {
        query: z.string().min(1).max(100).describe("Words to search for, e.g. 'water heater' or 'drain'."),
        kind: z.enum(["service", "material"]).optional().describe("Only services or only materials."),
      },
      annotations: READ_ONLY,
    },
    async ({ query, kind }) => {
      try {
        const book = await load();
        const matches = searchPricebook(book.items, query, kind);
        return ok(book, { query, count: matches.length, items: matches.map(row) });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description: "List every service in Trinity's HouseCall Pro price book with price, category and description. Read-only.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const book = await load();
        const services = book.items.filter((i) => i.kind === "service");
        return ok(book, { count: services.length, items: services.map(row) });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "list_materials",
    {
      title: "List materials",
      description:
        "List materials in Trinity's HouseCall Pro price book with price and cost, optionally only those whose category name contains the given text. Read-only.",
      inputSchema: {
        category: z.string().max(100).optional().describe("Part of a category name, e.g. 'PEX' or 'valves'."),
      },
      annotations: READ_ONLY,
    },
    async ({ category }) => {
      try {
        const book = await load();
        const needle = category?.trim().toLowerCase();
        const materials = book.items.filter(
          (i) => i.kind === "material" && (!needle || (i.category ?? "").toLowerCase().includes(needle))
        );
        return ok(book, { category: category ?? null, count: materials.length, items: materials.map(row) });
      } catch (err) {
        return fail(err);
      }
    }
  );

  return server;
}
