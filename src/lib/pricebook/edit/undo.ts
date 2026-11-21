// Undo a logged change or batch, up to 30 days back. Never overwrites an item
// that changed since: it stops for that item and reports what HCP holds now.
// Once an undo starts, a partial result is returned, never thrown away.
import type { PricebookItem } from "@/lib/mcp/pricebook";
import { EditError, errorCode, isAuthError, logChange, type EditDeps } from "./apply";
import { changedKeys, fieldsDiffer, itemValues, toHcpFields } from "./changes";
import type { ChangeRow, FieldValues } from "./types";

export const UNDO_DAYS = 30;

export type UndoResult = {
  aborted: string | null;
  undone: Array<{ id: number; name: string }>;
  dismissed: Array<{ id: number; name: string }>;
  skipped: Array<{ id: number; name: string; code: string; current?: FieldValues | null; fields?: string[] }>;
  unlogged: Array<{ uuid: string; name: string }>;
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
  const out: UndoResult = { aborted: null, undone: [], dismissed: [], skipped: [], unlogged: [], serviceBatches: [] };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
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

    // A field that had no value before (a number or taxable) can't be cleared in
    // HCP, so this row can't be fully undone: say so instead of reporting "undone".
    const before = r.before;
    const unset = changedKeys(r.after).filter((k) => before[k] === undefined);
    if (unset.length > 0) { out.skipped.push({ id: r.id, name: r.itemName, code: "cannot_restore_unset", fields: unset }); continue; }

    let current: PricebookItem | null;
    try {
      current = await deps.writer.getMaterial(r.itemUuid, r.categoryUuid);
    } catch (err) {
      out.skipped.push({ id: r.id, name: r.itemName, code: errorCode(err) });
      continue;
    }
    if (!current) { out.skipped.push({ id: r.id, name: r.itemName, code: "not_found", current: null }); continue; }
    if (fieldsDiffer(current, r.after)) { out.skipped.push({ id: r.id, name: r.itemName, code: "changed_since", current: itemValues(current) }); continue; }

    try {
      await deps.writer.updateMaterial(r.itemUuid, toHcpFields(r.before));
    } catch (err) {
      if (isAuthError(err)) {
        // The key can't write, so every remaining row would fail the same way.
        out.skipped.push({ id: r.id, name: r.itemName, code: "key_cannot_write" });
        for (const rest of rows.slice(i + 1)) out.skipped.push({ id: rest.id, name: rest.itemName, code: "key_cannot_write", current: null });
        out.aborted = "key_cannot_write";
        break;
      }
      out.skipped.push({ id: r.id, name: r.itemName, code: errorCode(err) });
      continue;
    }

    // HCP already holds the undo: record it and report, never throw.
    let statusOk = true;
    try {
      await deps.store.setStatus([r.id], "undone", { resolvedBy: editorId, resolvedAt: nowIso });
    } catch (err) {
      statusOk = false;
      console.error("[pricebook] change log write failed: " + (err instanceof Error ? err.message : String(err)));
    }
    const rowOk = await logChange(deps, { batchId: undoBatch, kind: "undo", itemUuid: r.itemUuid, itemName: r.itemName, itemKind: "material", categoryUuid: r.categoryUuid, before: r.after, after: r.before, status: "applied", requestedBy: editorId, errorCode: null });
    out.undone.push({ id: r.id, name: r.itemName });
    if (!statusOk || !rowOk) out.unlogged.push({ uuid: r.itemUuid, name: r.itemName });
  }
  return out;
}
