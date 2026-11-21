// The editor's change log and previews (migration 0009). Server-only.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChangeRow, ChangeStatus, FieldValues, NewChange, PreviewRow, PricebookEditStore } from "./types";

const CHANGE_COLS =
  "id, batch_id, kind, item_uuid, item_name, item_kind, category_uuid, before, after, status, requested_by, resolved_by, error_code, slack_channel_id, slack_message_ts, created_at, resolved_at";
const PREVIEW_COLS = "id, created_by_user_id, payload, expires_at, applied_at";

function check(op: string, error: { message: string } | null): void {
  if (error) throw new Error(`[pricebook] ${op} failed: ${error.message}`);
}

function toChange(r: Record<string, unknown>): ChangeRow {
  return {
    id: Number(r.id),
    batchId: String(r.batch_id),
    kind: r.kind as ChangeRow["kind"],
    itemUuid: String(r.item_uuid),
    itemName: String(r.item_name),
    itemKind: r.item_kind as ChangeRow["itemKind"],
    categoryUuid: (r.category_uuid as string | null) ?? null,
    before: (r.before as FieldValues | null) ?? null,
    after: (r.after as FieldValues) ?? {},
    status: r.status as ChangeStatus,
    requestedBy: String(r.requested_by),
    resolvedBy: (r.resolved_by as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    slackChannelId: (r.slack_channel_id as string | null) ?? null,
    slackMessageTs: (r.slack_message_ts as string | null) ?? null,
    createdAt: String(r.created_at),
    resolvedAt: (r.resolved_at as string | null) ?? null,
  };
}

function toPreview(r: Record<string, unknown>): PreviewRow {
  return {
    id: String(r.id),
    createdBy: String(r.created_by_user_id),
    payload: (r.payload as PreviewRow["payload"]) ?? [],
    expiresAt: String(r.expires_at),
    appliedAt: (r.applied_at as string | null) ?? null,
  };
}

const rows = (data: unknown) => (data ?? []) as Record<string, unknown>[];

export function supabasePricebookEditStore(db: SupabaseClient): PricebookEditStore {
  return {
    async insertChanges(input: NewChange[]) {
      if (input.length === 0) return [];
      const { data, error } = await db
        .from("pricebook_changes")
        .insert(
          input.map((c) => ({
            batch_id: c.batchId,
            kind: c.kind,
            item_uuid: c.itemUuid,
            item_name: c.itemName,
            item_kind: c.itemKind,
            category_uuid: c.categoryUuid,
            before: c.before,
            after: c.after,
            status: c.status,
            requested_by: c.requestedBy,
            error_code: c.errorCode,
          }))
        )
        .select(CHANGE_COLS);
      check("insertChanges", error);
      return rows(data).map(toChange);
    },
    async getChange(id) {
      const { data, error } = await db.from("pricebook_changes").select(CHANGE_COLS).eq("id", id).maybeSingle();
      check("getChange", error);
      return data ? toChange(data as Record<string, unknown>) : null;
    },
    async listBatch(batchId) {
      const { data, error } = await db.from("pricebook_changes").select(CHANGE_COLS).eq("batch_id", batchId).order("id");
      check("listBatch", error);
      return rows(data).map(toChange);
    },
    async listRecent(sinceIso, limit) {
      const { data, error } = await db
        .from("pricebook_changes")
        .select(CHANGE_COLS)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(limit);
      check("listRecent", error);
      return rows(data).map(toChange);
    },
    async listPendingServices() {
      const { data, error } = await db
        .from("pricebook_changes")
        .select(CHANGE_COLS)
        .eq("kind", "service_request")
        .eq("status", "pending")
        .order("id");
      check("listPendingServices", error);
      return rows(data).map(toChange);
    },
    async setStatus(ids, status, opts = {}) {
      if (ids.length === 0) return;
      const { error } = await db
        .from("pricebook_changes")
        .update({
          status,
          resolved_by: opts.resolvedBy ?? null,
          resolved_at: opts.resolvedAt ?? null,
          ...(opts.errorCode !== undefined ? { error_code: opts.errorCode } : {}),
        })
        .in("id", ids);
      check("setStatus", error);
    },
    async updateAfter(id, after) {
      const { error } = await db.from("pricebook_changes").update({ after }).eq("id", id);
      check("updateAfter", error);
    },
    async setSlackMessage(batchId, channelId, ts) {
      const { error } = await db.from("pricebook_changes").update({ slack_channel_id: channelId, slack_message_ts: ts }).eq("batch_id", batchId);
      check("setSlackMessage", error);
    },
    async createPreview(p) {
      const { error } = await db
        .from("pricebook_previews")
        .insert({ id: p.id, created_by_user_id: p.createdBy, payload: p.payload, expires_at: p.expiresAt });
      check("createPreview", error);
    },
    async getPreview(id) {
      const { data, error } = await db.from("pricebook_previews").select(PREVIEW_COLS).eq("id", id).maybeSingle();
      check("getPreview", error);
      return data ? toPreview(data as Record<string, unknown>) : null;
    },
    async claimPreview(id, by, nowIso) {
      const { data, error } = await db
        .from("pricebook_previews")
        .update({ applied_at: nowIso })
        .eq("id", id)
        .is("applied_at", null)
        .eq("created_by_user_id", by)
        .gt("expires_at", nowIso)
        .select(PREVIEW_COLS);
      check("claimPreview", error);
      const r = rows(data);
      return r.length === 1 ? toPreview(r[0]) : null;
    },
  };
}
