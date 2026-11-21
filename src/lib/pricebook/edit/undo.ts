// Undo a logged change or batch, up to 30 days back. Never overwrites an item
// that changed since: it stops for that item and reports what HCP holds now.
import { HcpWriteError } from "@/lib/housecall/pricebookWrite";
import { EditError, KEY_CANNOT_WRITE, isAuthError, type EditDeps } from "./apply";
import { fieldsDiffer, itemValues, toHcpFields } from "./changes";
import type { ChangeRow, FieldValues } from "./types";

export const UNDO_DAYS = 30;

export type UndoResult = {
  undone: Array<{ id: number; name: string }>;
  dismissed: Array<{ id: number; name: string }>;
  skipped: Array<{ id: number; name: string; code: string; current?: FieldValues | null }>;
  serviceBatches: string[];
};

export async function undoChange(deps: EditDeps, ref: { changeId?: number; batchId?: string }, editorId: string): Promise<UndoResult> {
  let rows: ChangeRow[] = [];
  if (ref.changeId !== undefined) {
    const r = await deps.store.getChange(ref.changeId);
    rows = r ? [r] : [];
  } else if (ref.batchId) {
    rows = await deps.store.listBatch(ref.batchId);
  }
  if (rows.length === 0) throw new EditError("change_not_found", "No change with that id. Use recent_changes to find it.");

  const now = deps.now();
  const nowIso = now.toISOString();
  const cutoff = now.getTime() - UNDO_DAYS * 86_400_000;
  const undoBatch = deps.newId();
  const out: UndoResult = { undone: [], dismissed: [], skipped: [], serviceBatches: [] };

  for (const r of rows) {
    if (Date.parse(r.createdAt) < cutoff) { out.skipped.push({ id: r.id, name: r.itemName, code: "too_old" }); continue; }
    if (r.kind === "material_create") { out.skipped.push({ id: r.id, name: r.itemName, code: "create_cannot_be_undone" }); continue; }
    if (r.kind === "service_request" && r.status === "pending") {
      await deps.store.setStatus([r.id], "dismissed", { resolvedBy: editorId, resolvedAt: nowIso });
      out.dismissed.push({ id: r.id, name: r.itemName });
      if (!out.serviceBatches.includes(r.batchId)) out.serviceBatches.push(r.batchId);
      continue;
    }
    if (r.kind !== "material_update" || r.status !== "applied" || !r.before || !r.categoryUuid) {
      out.skipped.push({ id: r.id, name: r.itemName, code: "not_undoable" });
      continue;
    }

    const current = await deps.writer.getMaterial(r.itemUuid, r.categoryUuid);
    if (!current) { out.skipped.push({ id: r.id, name: r.itemName, code: "not_found", current: null }); continue; }
    if (fieldsDiffer(current, r.after)) { out.skipped.push({ id: r.id, name: r.itemName, code: "changed_since", current: itemValues(current) }); continue; }
    try {
      await deps.writer.updateMaterial(r.itemUuid, toHcpFields(r.before));
    } catch (err) {
      if (isAuthError(err)) throw new EditError("key_cannot_write", KEY_CANNOT_WRITE);
      out.skipped.push({ id: r.id, name: r.itemName, code: err instanceof HcpWriteError ? `http_${err.status}` : "error" });
      continue;
    }
    await deps.store.setStatus([r.id], "undone", { resolvedBy: editorId, resolvedAt: nowIso });
    await deps.store.insertChanges([{ batchId: undoBatch, kind: "undo", itemUuid: r.itemUuid, itemName: r.itemName, itemKind: "material", categoryUuid: r.categoryUuid, before: r.after, after: r.before, status: "applied", requestedBy: editorId, errorCode: null }]);
    out.undone.push({ id: r.id, name: r.itemName });
  }
  return out;
}
