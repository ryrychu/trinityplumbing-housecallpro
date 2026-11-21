// The "Trinity Price Book Editor" ChatGPT connector, for Dave and Ella only.
// Materials: preview → apply (HCP written directly), add, undo. Services:
// HCP's API can't change them, so they become a Slack checklist.
// Spec: docs/superpowers/specs/2026-11-21-pricebook-edit-design.md
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatMoney, searchPricebook } from "@/lib/mcp/pricebook";
import { EditError, addMaterial, applyPreview, checkWriteAccess, createPreview, type EditDeps } from "@/lib/pricebook/edit/apply";
import { describeChange } from "@/lib/pricebook/edit/changes";
import { NOT_EDITOR_TEXT } from "@/lib/pricebook/edit/deps";
import { requestServiceChanges, rerenderBatch, type ServiceDeps } from "@/lib/pricebook/edit/serviceChecklist";
import type { ChangeRow } from "@/lib/pricebook/edit/types";
import { undoChange } from "@/lib/pricebook/edit/undo";

export interface PricebookEditToolDeps {
  edit: EditDeps;
  service: ServiceDeps;
  editors: Map<string, string>;
  listCategories(): Promise<Array<{ uuid: string; name: string; parentUuid: string | null }>>;
  serviceConfigMissing(): string | null;
}

export const SERVER_INSTRUCTIONS = [
  "Trinity Price Book Editor changes Trinity Plumbing's Housecall Pro price book for Dave and Ella.",
  "Materials (parts) are changed directly: ALWAYS call preview_material_changes first, show the user the full old → new list and every warning, and call apply_material_changes only after they say yes to that exact preview.",
  "Services (flat-rate jobs) can't be changed through Housecall Pro's API: use request_service_changes, which posts them to a Slack checklist for Dave or Ella to make in HCP, and tell the user that.",
  "Use find_items to get ids; never invent ids. Prices are in dollars. Deleting items isn't possible here.",
  "If something was changed by mistake, use recent_changes to find it and undo_change to put it back.",
].join(" ");

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
type ToolResult = { isError?: boolean; content: { type: "text"; text: string }[] };
const json = (b: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(b, null, 2) }] });
const refuse = (t: string): ToolResult => ({ isError: true, content: [{ type: "text", text: t }] });
const MONEY = z.union([z.number(), z.string().max(20)]);

const KEY_CANNOT_WRITE_CODE = "key_cannot_write";
const KEY_NEEDED = "Dave needs to make a Housecall Pro API key with write access.";

export function createPricebookEditMcpServer(deps: PricebookEditToolDeps, callerUserId: string | null): McpServer {
  const server = new McpServer({ name: "trinity-pricebook-edit", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  const editor = callerUserId !== null && deps.editors.has(callerUserId) ? callerUserId : null;
  const nameOf = (id: string) => deps.editors.get(id) ?? id;

  async function run(tool: string, body: (editorId: string) => Promise<ToolResult>): Promise<ToolResult> {
    if (!editor) return refuse(NOT_EDITOR_TEXT);
    try {
      return await body(editor);
    } catch (err) {
      if (err instanceof EditError) return refuse(err.message);
      console.error(`[mcp-pricebook-edit] ${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
      return refuse("Something went wrong on Trinity's side. Check recent_changes before retrying.");
    }
  }

  const view = (r: ChangeRow) => ({ id: r.id, batchId: r.batchId, when: r.createdAt, by: nameOf(r.requestedBy), kind: r.kind, item: r.itemName, change: describeChange(r.before, r.after), status: r.status, error: r.errorCode });

  server.registerTool("find_items", {
    title: "Find price book items",
    description: "Search services and materials by name, category or part number. Returns ids, kind, category, price, cost and description.",
    inputSchema: { query: z.string().min(1).max(200), kind: z.enum(["service", "material"]).optional() },
    annotations: READ,
  }, async ({ query, kind }) => run("find_items", async () => {
    const items = searchPricebook(await deps.edit.loadItems(), query, kind, 50);
    return json({ items: items.map((i) => ({ id: i.uuid, kind: i.kind, name: i.name, category: i.category, categoryId: i.categoryUuid ?? null, price: formatMoney(i.priceCents), cost: formatMoney(i.costCents), description: i.description, partNumber: i.partNumber })) });
  }));

  server.registerTool("list_categories", {
    title: "List material categories",
    description: "The material category tree with ids, for add_material.",
    inputSchema: {},
    annotations: READ,
  }, async () => run("list_categories", async () => json({ categories: await deps.listCategories() })));

  server.registerTool("recent_changes", {
    title: "Recent price book changes",
    description: "Changes made through this editor in the last `days` (default 7, max 30): who, when, what, status. Includes pending service changes.",
    inputSchema: { days: z.number().int().min(1).max(30).optional() },
    annotations: READ,
  }, async ({ days }) => run("recent_changes", async () => {
    const since = new Date(deps.edit.now().getTime() - (days ?? 7) * 86_400_000).toISOString();
    const rows = await deps.edit.store.listRecent(since, 100);
    const pending = await deps.edit.store.listPendingServices();
    return json({ changes: rows.map(view), pendingServiceChanges: pending.map(view) });
  }));

  server.registerTool("check_write_access", {
    title: "Check write access",
    description: "Saves one material back unchanged to check that the Housecall Pro API key can write. Changes nothing.",
    inputSchema: {},
    annotations: { ...WRITE, idempotentHint: true },
  }, async () => run("check_write_access", async () => {
    const r = await checkWriteAccess(deps.edit);
    return json(r.ok
      ? { ok: true, note: `The HCP key can write (tested on ${r.item}, nothing changed).` }
      : { ok: false, status: r.status, note: "The HCP API key can't write to the price book. Dave needs to make a key with write access in HCP." });
  }));

  const editSchema = z.object({
    uuid: z.string().min(1).max(200),
    price: MONEY.optional(),
    cost: MONEY.optional(),
    description: z.string().max(2000).optional(),
    name: z.string().min(1).max(200).optional(),
    partNumber: z.string().max(100).optional(),
    unit: z.string().max(50).optional(),
    taxable: z.boolean().optional(),
  });

  server.registerTool("preview_material_changes", {
    title: "Preview material changes",
    description: "Builds the exact old → new list for material changes, with warnings and blocks, and returns a previewId (valid 15 minutes). Changes nothing. Give `items` (per item) or `rule` (e.g. category + pricePercent).",
    inputSchema: {
      items: z.array(editSchema).max(50).optional(),
      rule: z.object({
        match: z.object({ query: z.string().max(200).optional(), category: z.string().max(200).optional() }),
        pricePercent: z.number().min(-90).max(500).optional(),
        costPercent: z.number().min(-90).max(500).optional(),
        round: z.enum(["cent", "dollar", "99"]).optional(),
      }).optional(),
      allowBelowCost: z.boolean().optional(),
    },
    annotations: READ,
  }, async (args) => run("preview_material_changes", async (editorId) => {
    const p = await createPreview(deps.edit, args, editorId);
    return json({
      previewId: p.previewId,
      expiresAt: p.expiresAt,
      changes: p.changes.map((c) => ({ uuid: c.uuid, name: c.name, category: c.category, change: describeChange(c.before, c.after), before: c.before, after: c.after })),
      warnings: p.warnings,
      blocks: p.blocks,
      note: p.previewId ? "Show this list to the user and apply only if they confirm." : "Nothing can be applied: fix the blocks (or there was nothing to change).",
    });
  }));

  server.registerTool("apply_material_changes", {
    title: "Apply material changes",
    description: "Applies a previewId from preview_material_changes in Housecall Pro. Only after the user confirmed that exact preview.",
    inputSchema: { previewId: z.string().min(1).max(100) },
    annotations: WRITE,
  }, async ({ previewId }) => run("apply_material_changes", async (editorId) => {
    // Read first: for an unlogged item the preview holds the only record of its old values.
    const planned = (await deps.edit.store.getPreview(previewId))?.payload ?? [];
    const r = await applyPreview(deps.edit, previewId, editorId);
    const notes: string[] = [];
    if (r.aborted === KEY_CANNOT_WRITE_CODE) {
      notes.push(`Housecall Pro stopped accepting writes partway: the API key can't write. ${r.applied.length} item(s) were applied before it stopped; the rest were not changed. ${KEY_NEEDED}`);
    } else if (r.applied.length === 0) {
      notes.push("Nothing was applied. See failed and skipped for why.");
    } else {
      notes.push("Applied in HCP. The read-only Trinity Price Book connector may show old values for up to 2 minutes. Undo with undo_change and this batchId.");
    }
    if (r.unlogged.length > 0) {
      const lines = r.unlogged.map((u) => {
        const p = planned.find((c) => c.uuid === u.uuid);
        return p ? `${u.name} (was: ${describeChange(p.after, p.before)})` : u.name;
      });
      notes.push(`These were changed in HCP but not recorded in the change log, so undo_change can't put them back: ${lines.join("; ")}. Their old values are shown so they can be restored by hand.`);
    }
    return json({ ...r, note: notes.join(" ") });
  }));

  server.registerTool("add_material", {
    title: "Add a material",
    description: "Creates a new material in a category (ids from list_categories). Checks price vs cost first. Can't be deleted afterwards.",
    inputSchema: {
      categoryUuid: z.string().min(1).max(200),
      name: z.string().min(1).max(200),
      price: MONEY,
      cost: MONEY.optional(),
      description: z.string().max(2000).optional(),
      unit: z.string().max(50).optional(),
      partNumber: z.string().max(100).optional(),
      taxable: z.boolean().optional(),
      allowBelowCost: z.boolean().optional(),
    },
    annotations: WRITE,
  }, async (args) => run("add_material", async (editorId) => json(await addMaterial(deps.edit, args, editorId))));

  server.registerTool("request_service_changes", {
    title: "Request service changes",
    description: "Housecall Pro's API can't change services. This records the wanted changes and posts them to the #pricebook-changes Slack checklist for Dave or Ella to make in HCP.",
    inputSchema: {
      items: z.array(z.object({
        uuid: z.string().min(1).max(200),
        price: MONEY.optional(),
        description: z.string().max(2000).optional(),
        name: z.string().min(1).max(200).optional(),
      })).min(1).max(50),
      allowBelowCost: z.boolean().optional(),
    },
    annotations: WRITE,
  }, async ({ items, allowBelowCost }) => run("request_service_changes", async (editorId) => {
    const missing = deps.serviceConfigMissing();
    if (missing) return refuse(`The Slack checklist isn't set up yet: ${missing}.`);
    try {
      return json(await requestServiceChanges(deps.service, items, editorId, { allowBelowCost }));
    } catch (err) {
      if (err instanceof EditError) throw err;
      console.error(`[mcp-pricebook-edit] request_service_changes failed: ${err instanceof Error ? err.message : String(err)}`);
      return refuse("Couldn't post to the Slack checklist, so nothing was requested. It's safe to try again.");
    }
  }));

  server.registerTool("undo_change", {
    title: "Undo a change",
    description: "Puts back the old values for a change id or a whole batchId (from recent_changes), up to 30 days. Skips items changed since. Dismisses pending service requests.",
    inputSchema: { changeId: z.number().int().positive().optional(), batchId: z.string().min(1).max(100).optional() },
    annotations: WRITE,
  }, async ({ changeId, batchId }) => run("undo_change", async (editorId) => {
    if (changeId === undefined && !batchId) return refuse("Give a changeId or a batchId from recent_changes.");
    const r = await undoChange(deps.edit, { changeId, batchId }, editorId);
    for (const b of r.serviceBatches) await rerenderBatch(deps.service, b).catch(() => undefined);
    const notes: string[] = [];
    if (r.aborted === KEY_CANNOT_WRITE_CODE) {
      notes.push(`Housecall Pro stopped accepting writes partway: the API key can't write. ${r.undone.length} item(s) were put back before it stopped; the rest were not changed. ${KEY_NEEDED}`);
    }
    if (r.unlogged.length > 0) {
      notes.push(`These were put back in HCP but the change log wasn't updated: ${r.unlogged.map((u) => u.name).join(", ")}.`);
    }
    return json(notes.length > 0 ? { ...r, note: notes.join(" ") } : r);
  }));

  return server;
}
