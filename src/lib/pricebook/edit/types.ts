// Shared types for the Trinity Price Book Editor: change log rows, previews and the store port.
export type FieldValues = { name?: string; description?: string; priceCents?: number; costCents?: number; unit?: string; partNumber?: string; taxable?: boolean };
export type ChangeKind = "material_update" | "material_create" | "service_request" | "undo";
export type ChangeStatus = "applied" | "failed" | "undone" | "pending" | "done" | "dismissed";
export type ChangeRow = { id: number; batchId: string; kind: ChangeKind; itemUuid: string; itemName: string; itemKind: "material" | "service"; categoryUuid: string | null; before: FieldValues | null; after: FieldValues; status: ChangeStatus; requestedBy: string; resolvedBy: string | null; errorCode: string | null; slackChannelId: string | null; slackMessageTs: string | null; createdAt: string; resolvedAt: string | null };
export type NewChange = Pick<ChangeRow, "batchId" | "kind" | "itemUuid" | "itemName" | "itemKind" | "categoryUuid" | "before" | "after" | "status" | "requestedBy" | "errorCode">;
export type PlannedChange = { uuid: string; name: string; category: string | null; categoryUuid: string | null; before: FieldValues; after: FieldValues };
export type PreviewRow = { id: string; createdBy: string; payload: PlannedChange[]; expiresAt: string; appliedAt: string | null };
export interface PricebookEditStore {
  insertChanges(rows: NewChange[]): Promise<ChangeRow[]>;
  getChange(id: number): Promise<ChangeRow | null>;
  listBatch(batchId: string): Promise<ChangeRow[]>;
  listRecent(sinceIso: string, limit: number): Promise<ChangeRow[]>;
  listPendingServices(): Promise<ChangeRow[]>;
  setStatus(ids: number[], status: ChangeStatus, opts?: { resolvedBy?: string | null; resolvedAt?: string | null; errorCode?: string | null }): Promise<void>;
  updateAfter(id: number, after: FieldValues): Promise<void>;
  updateChange(id: number, patch: { before: FieldValues | null; after: FieldValues }): Promise<void>;
  setSlackMessage(batchId: string, channelId: string, ts: string): Promise<void>;
  createPreview(p: Omit<PreviewRow, "appliedAt">): Promise<void>;
  getPreview(id: string): Promise<PreviewRow | null>;
  /** Atomically marks the preview applied when unexpired, unapplied and owned by `by`; returns it, else null. */
  claimPreview(id: string, by: string, nowIso: string): Promise<PreviewRow | null>;
}
