// Attachments arrive embedded in customer/job payloads (attachments: [...]),
// not as their own webhook event. We always upsert metadata; re-hosting the
// file into Supabase Storage is best-effort and must never fail the parent
// record's core upsert (same philosophy as geocoding).
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AttachmentRow {
  id: string;
  parent_type: "customer" | "job";
  parent_id: string;
  file_name: string | null;
  content_type: string | null;
  hcp_url: string | null;
  storage_path: string | null;
  created_at: string | null;
  raw: unknown;
  updated_at: string;
}

const STORAGE_BUCKET = "hcp-attachments";

interface RawAttachment {
  id: string;
  url?: string;
  content_type?: string;
  file_name?: string;
  created_at?: string;
}

function readAttachments(payload: unknown): RawAttachment[] {
  const a = (payload as { attachments?: unknown })?.attachments;
  return Array.isArray(a) ? (a as RawAttachment[]) : [];
}

export function extractAttachmentRows(
  parentType: "customer" | "job",
  parentId: string,
  payload: unknown
): AttachmentRow[] {
  const nowIso = new Date().toISOString();
  return readAttachments(payload).map((att) => ({
    id: att.id,
    parent_type: parentType,
    parent_id: parentId,
    file_name: att.file_name ?? null,
    content_type: att.content_type ?? null,
    hcp_url: att.url ?? null,
    storage_path: null,
    created_at: att.created_at ?? null,
    raw: att,
    updated_at: nowIso,
  }));
}

// Best-effort: download the HCP file and re-host it in Supabase Storage.
// Returns the storage path on success, or null on any failure (leaves the row
// pointing at hcp_url only). Never throws.
async function rehost(
  supabase: SupabaseClient,
  row: AttachmentRow
): Promise<string | null> {
  if (!row.hcp_url) return null;
  try {
    const res = await fetch(row.hcp_url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const path = `${row.parent_type}/${row.parent_id}/${row.id}`;
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, bytes, {
        contentType: row.content_type ?? undefined,
        upsert: true,
      });
    if (error) return null;
    return path;
  } catch {
    return null;
  }
}

export async function syncAttachments(
  supabase: SupabaseClient,
  parentType: "customer" | "job",
  parentId: string,
  payload: unknown,
  opts: { rehost?: boolean } = { rehost: true }
): Promise<void> {
  const rows = extractAttachmentRows(parentType, parentId, payload);
  if (rows.length === 0) return;

  // Metadata-only mode (incremental cron backfill): skip the network re-host to
  // avoid serverless timeouts over thousands of records. storage_path stays null
  // and the real-time webhook path re-hosts later. Default keeps rehost on.
  if (opts.rehost !== false) {
    for (const row of rows) {
      row.storage_path = await rehost(supabase, row);
    }
  }

  const { error } = await supabase.from("attachments").upsert(rows);
  if (error) {
    throw new Error(`Failed to upsert attachments for ${parentType} ${parentId}: ${error.message}`);
  }
}
