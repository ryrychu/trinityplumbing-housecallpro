// Preview → apply for materials, adding a material, and the write-access check.
// HCP is written one item at a time; each result is logged as it happens. Once a
// preview is claimed or a write has landed, a partial result is returned, never
// thrown away: the caller must always learn what reached HCP.
import { HcpWriteError, type HcpMaterialFields } from "@/lib/housecall/pricebookWrite";
import type { PricebookItem } from "@/lib/mcp/pricebook";
import { buildPreview, describeChange, fieldsDiffer, itemValues, parseMoney, priceCheck, toHcpFields, type Issue, type Money, type Preview, type PreviewRequest } from "./changes";
import type { FieldValues, NewChange, PlannedChange, PricebookEditStore } from "./types";

export interface MaterialWriter {
  updateMaterial(uuid: string, f: HcpMaterialFields): Promise<void>;
  createMaterial(categoryUuid: string, f: HcpMaterialFields & { name: string; price: number; cost: number }): Promise<{ uuid: string }>;
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

export function errorCode(err: unknown): string {
  return err instanceof HcpWriteError ? `http_${err.status}` : "error";
}

// Logs a change row. Returns false (and logs the message only) if the write fails,
// so the caller can report the item as unlogged instead of throwing.
export async function logChange(deps: EditDeps, row: NewChange): Promise<boolean> {
  try {
    await deps.store.insertChanges([row]);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pricebook] change log write failed: " + message);
    return false;
  }
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
  aborted: string | null;
  applied: Array<{ uuid: string; name: string; change: string }>;
  failed: Array<{ uuid: string; name: string; code: string }>;
  skipped: Array<{ uuid: string; name: string; code: string; current: FieldValues | null }>;
  unlogged: Array<{ uuid: string; name: string }>;
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
  const result: ApplyResult = { batchId, aborted: null, applied: [], failed: [], skipped: [], unlogged: [] };
  const payload: PlannedChange[] = claimed.payload;

  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    const base = { batchId, kind: "material_update" as const, itemUuid: c.uuid, itemName: c.name, itemKind: "material" as const, categoryUuid: c.categoryUuid, before: c.before, after: c.after, requestedBy: editorId };

    let current: PricebookItem | null;
    try {
      current = c.categoryUuid ? await deps.writer.getMaterial(c.uuid, c.categoryUuid) : null;
    } catch (err) {
      const code = errorCode(err);
      result.failed.push({ uuid: c.uuid, name: c.name, code });
      if (!(await logChange(deps, { ...base, status: "failed", errorCode: code }))) result.unlogged.push({ uuid: c.uuid, name: c.name });
      continue;
    }
    if (!current) { result.skipped.push({ uuid: c.uuid, name: c.name, code: "not_found", current: null }); continue; }
    if (fieldsDiffer(current, c.before)) { result.skipped.push({ uuid: c.uuid, name: c.name, code: "changed_since", current: itemValues(current) }); continue; }

    try {
      await deps.writer.updateMaterial(c.uuid, toHcpFields(c.after));
    } catch (err) {
      if (isAuthError(err)) {
        // The key can't write, so nothing after this item can land either.
        result.failed.push({ uuid: c.uuid, name: c.name, code: "key_cannot_write" });
        if (!(await logChange(deps, { ...base, status: "failed", errorCode: "key_cannot_write" }))) result.unlogged.push({ uuid: c.uuid, name: c.name });
        for (const rest of payload.slice(i + 1)) result.skipped.push({ uuid: rest.uuid, name: rest.name, code: "key_cannot_write", current: null });
        result.aborted = "key_cannot_write";
        break;
      }
      const code = errorCode(err);
      result.failed.push({ uuid: c.uuid, name: c.name, code });
      if (!(await logChange(deps, { ...base, status: "failed", errorCode: code }))) result.unlogged.push({ uuid: c.uuid, name: c.name });
      continue;
    }

    const logged = await logChange(deps, { ...base, status: "applied", errorCode: null });
    result.applied.push({ uuid: c.uuid, name: c.name, change: describeChange(c.before, c.after) });
    if (!logged) result.unlogged.push({ uuid: c.uuid, name: c.name });
  }
  return result;
}

export type NewMaterial = { categoryUuid: string; name: string; price: Money; cost: Money; description?: string; unit?: string; partNumber?: string; taxable?: boolean; allowBelowCost?: boolean };

export async function addMaterial(deps: EditDeps, input: NewMaterial, editorId: string): Promise<{ created: { uuid: string; name: string } | null; blocks: Issue[]; warnings: Issue[] }> {
  const name = input.name.trim();
  const price = parseMoney(input.price);
  // HCP requires a cost on create; it is never defaulted to 0 (that would fake a 100% margin).
  const cost = input.cost === undefined || input.cost === null ? null : parseMoney(input.cost);
  const blocks: Issue[] = [];
  const warnings: Issue[] = [];
  if (name === "") blocks.push({ uuid: null, name: null, code: "bad_name", message: "The material needs a name." });
  if (price === null) blocks.push({ uuid: null, name, code: "bad_money", message: `"${input.price}" isn't a price.` });
  if (cost === null) {
    const given = input.cost === undefined || input.cost === null ? "" : String(input.cost).trim();
    blocks.push({ uuid: null, name, code: "bad_money", message: given === "" ? "A new material needs a cost (HCP requires one)." : `"${input.cost}" isn't a cost.` });
  }
  const bad = priceCheck(name, "", price, cost, Boolean(input.allowBelowCost));
  if (bad) blocks.push(bad);
  if (blocks.length > 0 || price === null || cost === null) return { created: null, blocks, warnings };

  const items = await deps.loadItems();
  if (items.some((i) => i.kind === "material" && i.name.trim().toLowerCase() === name.toLowerCase())) {
    warnings.push({ uuid: null, name, code: "duplicate_name", message: `Another material is already called "${name}".` });
  }
  const after: FieldValues = { name, priceCents: price, costCents: cost };
  if (input.description !== undefined) after.description = input.description.trim();
  if (input.unit !== undefined) after.unit = input.unit.trim();
  if (input.partNumber !== undefined) after.partNumber = input.partNumber.trim();
  if (input.taxable !== undefined) after.taxable = input.taxable;

  let uuid: string;
  try {
    ({ uuid } = await deps.writer.createMaterial(input.categoryUuid, { ...toHcpFields(after), name, price, cost }));
  } catch (err) {
    if (isAuthError(err)) throw new EditError("key_cannot_write", KEY_CANNOT_WRITE);
    throw err;
  }
  const logged = await logChange(deps, { batchId: deps.newId(), kind: "material_create", itemUuid: uuid, itemName: name, itemKind: "material", categoryUuid: input.categoryUuid, before: null, after, status: "applied", requestedBy: editorId, errorCode: null });
  // Created in HCP already, so a retry would duplicate it: report, don't throw.
  if (!logged) {
    warnings.push({ uuid, name, code: "unlogged", message: "Created in HCP but not recorded in the change log." });
  }
  return { created: { uuid, name }, blocks, warnings };
}

// Saves one material back unchanged to prove the key can write. Only a 401 or 403
// counts as "can't write"; any other error is a real failure and is rethrown.
// normalizeMaterial already trims names, so the first non-empty name is the best check.
export async function checkWriteAccess(deps: EditDeps): Promise<{ ok: boolean; status?: number; item?: string }> {
  const m = (await deps.loadItems()).find((i) => i.kind === "material" && i.name.trim() !== "");
  if (!m) throw new EditError("no_materials", "There are no materials in the price book to test with.");
  try {
    await deps.writer.updateMaterial(m.uuid, { name: m.name });
    return { ok: true, item: m.name };
  } catch (err) {
    if (err instanceof HcpWriteError && isAuthError(err)) return { ok: false, status: err.status, item: m.name };
    throw err;
  }
}
