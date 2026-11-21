// Preview → apply for materials, adding a material, and the write-access check.
// HCP is written one item at a time; each result is logged as it happens, so a
// failure partway leaves everything that landed recorded.
import { HcpWriteError, type HcpMaterialFields } from "@/lib/housecall/pricebookWrite";
import type { PricebookItem } from "@/lib/mcp/pricebook";
import { buildPreview, describeChange, fieldsDiffer, itemValues, parseMoney, priceCheck, toHcpFields, type Issue, type Money, type Preview, type PreviewRequest } from "./changes";
import type { FieldValues, PricebookEditStore } from "./types";

export interface MaterialWriter {
  updateMaterial(uuid: string, f: HcpMaterialFields): Promise<void>;
  createMaterial(categoryUuid: string, f: HcpMaterialFields & { name: string; price: number }): Promise<{ uuid: string }>;
  getMaterial(uuid: string, categoryUuid: string): Promise<PricebookItem | null>;
}
export type EditDeps = { store: PricebookEditStore; writer: MaterialWriter; loadItems(): Promise<PricebookItem[]>; now(): Date; newId(): string };

export class EditError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EditError";
    this.code = code;
  }
}

export const PREVIEW_TTL_MS = 15 * 60_000;
export const KEY_CANNOT_WRITE = "The Housecall Pro API key can't write to the price book. Make a key with write access in HCP and update HOUSECALL_API_KEY.";

export function isAuthError(err: unknown): boolean {
  return err instanceof HcpWriteError && (err.status === 401 || err.status === 403);
}

export async function createPreview(deps: EditDeps, req: PreviewRequest, editorId: string): Promise<Preview & { previewId: string | null; expiresAt: string | null }> {
  const preview = buildPreview(req, await deps.loadItems());
  if (preview.blocks.length > 0 || preview.changes.length === 0) return { ...preview, previewId: null, expiresAt: null };
  const id = deps.newId();
  const expiresAt = new Date(deps.now().getTime() + PREVIEW_TTL_MS).toISOString();
  await deps.store.createPreview({ id, createdBy: editorId, payload: preview.changes, expiresAt });
  return { ...preview, previewId: id, expiresAt };
}

export type ApplyResult = {
  batchId: string;
  applied: Array<{ uuid: string; name: string; change: string }>;
  failed: Array<{ uuid: string; name: string; code: string }>;
  skipped: Array<{ uuid: string; name: string; code: string; current: FieldValues | null }>;
};

export async function applyPreview(deps: EditDeps, previewId: string, editorId: string): Promise<ApplyResult> {
  const nowIso = deps.now().toISOString();
  const claimed = await deps.store.claimPreview(previewId, editorId, nowIso);
  if (!claimed) {
    const p = await deps.store.getPreview(previewId);
    if (!p) throw new EditError("preview_not_found", "That preview doesn't exist. Preview the changes again.");
    if (p.createdBy !== editorId) throw new EditError("preview_other_editor", "That preview was made by the other editor. Preview the changes again yourself.");
    if (p.appliedAt) throw new EditError("preview_already_applied", "That preview was already applied.");
    throw new EditError("preview_expired", "That preview expired (they last 15 minutes). Preview the changes again.");
  }

  const batchId = deps.newId();
  const result: ApplyResult = { batchId, applied: [], failed: [], skipped: [] };
  for (const c of claimed.payload) {
    const current = c.categoryUuid ? await deps.writer.getMaterial(c.uuid, c.categoryUuid) : null;
    if (!current) { result.skipped.push({ uuid: c.uuid, name: c.name, code: "not_found", current: null }); continue; }
    if (fieldsDiffer(current, c.before)) { result.skipped.push({ uuid: c.uuid, name: c.name, code: "changed_since", current: itemValues(current) }); continue; }
    const base = { batchId, kind: "material_update" as const, itemUuid: c.uuid, itemName: c.name, itemKind: "material" as const, categoryUuid: c.categoryUuid, before: c.before, after: c.after, requestedBy: editorId };
    try {
      await deps.writer.updateMaterial(c.uuid, toHcpFields(c.after));
    } catch (err) {
      if (isAuthError(err)) throw new EditError("key_cannot_write", KEY_CANNOT_WRITE);
      const code = err instanceof HcpWriteError ? `http_${err.status}` : "error";
      await deps.store.insertChanges([{ ...base, status: "failed", errorCode: code }]);
      result.failed.push({ uuid: c.uuid, name: c.name, code });
      continue;
    }
    await deps.store.insertChanges([{ ...base, status: "applied", errorCode: null }]);
    result.applied.push({ uuid: c.uuid, name: c.name, change: describeChange(c.before, c.after) });
  }
  return result;
}

export type NewMaterial = { categoryUuid: string; name: string; price: Money; cost?: Money; description?: string; unit?: string; partNumber?: string; taxable?: boolean; allowBelowCost?: boolean };

export async function addMaterial(deps: EditDeps, input: NewMaterial, editorId: string): Promise<{ created: { uuid: string; name: string } | null; blocks: Issue[]; warnings: Issue[] }> {
  const name = input.name.trim();
  const price = parseMoney(input.price);
  const cost = input.cost !== undefined ? parseMoney(input.cost) : null;
  const blocks: Issue[] = [];
  const warnings: Issue[] = [];
  if (price === null) blocks.push({ uuid: null, name, code: "bad_money", message: `"${input.price}" isn't a price.` });
  // A cost that doesn't parse is refused, not silently dropped.
  if (input.cost !== undefined && cost === null) blocks.push({ uuid: null, name, code: "bad_money", message: `"${input.cost}" isn't a cost.` });
  const bad = priceCheck(name, "", price, cost, Boolean(input.allowBelowCost));
  if (bad) blocks.push(bad);
  if (blocks.length > 0 || price === null) return { created: null, blocks, warnings };

  const items = await deps.loadItems();
  if (items.some((i) => i.kind === "material" && i.name.trim().toLowerCase() === name.toLowerCase())) {
    warnings.push({ uuid: null, name, code: "duplicate_name", message: `Another material is already called "${name}".` });
  }
  const after: FieldValues = { name, priceCents: price };
  if (cost !== null) after.costCents = cost;
  if (input.description !== undefined) after.description = input.description.trim();
  if (input.unit !== undefined) after.unit = input.unit.trim();
  if (input.partNumber !== undefined) after.partNumber = input.partNumber.trim();
  if (input.taxable !== undefined) after.taxable = input.taxable;

  let uuid: string;
  try {
    ({ uuid } = await deps.writer.createMaterial(input.categoryUuid, { ...toHcpFields(after), name, price }));
  } catch (err) {
    if (isAuthError(err)) throw new EditError("key_cannot_write", KEY_CANNOT_WRITE);
    throw err;
  }
  await deps.store.insertChanges([{ batchId: deps.newId(), kind: "material_create", itemUuid: uuid, itemName: name, itemKind: "material", categoryUuid: input.categoryUuid, before: null, after, status: "applied", requestedBy: editorId, errorCode: null }]);
  return { created: { uuid, name }, blocks, warnings };
}

export async function checkWriteAccess(deps: EditDeps): Promise<{ ok: boolean; status?: number; item?: string }> {
  const m = (await deps.loadItems()).find((i) => i.kind === "material" && i.categoryUuid);
  if (!m) throw new EditError("no_materials", "There are no materials in the price book to test with.");
  try {
    await deps.writer.updateMaterial(m.uuid, { name: m.name });
    return { ok: true, item: m.name };
  } catch (err) {
    if (err instanceof HcpWriteError) return { ok: false, status: err.status, item: m.name };
    throw err;
  }
}
