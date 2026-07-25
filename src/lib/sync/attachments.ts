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

// Re-host network calls are bounded per cron run (same shape as GeocodeBudget)
// so a first backfill over thousands of records cannot exceed the 300s
// serverless limit. Shared by reference across every syncAttachments call in a
// run, so the cap is run-wide rather than per parent record.
export interface RehostBudget {
  remaining: number;
}

interface RawAttachment {
  id: string;
  url?: string;
  // Live HCP sends `file_type`; the OpenAPI Attachment schema is
  // {id, file_name, url, file_type} with no content_type. `content_type` is
  // tolerated as an alias in case a webhook payload uses it.
  file_type?: string;
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
    content_type: att.file_type ?? att.content_type ?? null,
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
  opts: { rehost?: boolean; budget?: RehostBudget } = {}
): Promise<void> {
  const rows = extractAttachmentRows(parentType, parentId, payload);
  if (rows.length === 0) return;

  // hcp_url is a presigned S3 link that expires in 1 hour (X-Amz-Expires=3600),
  // so metadata alone is NOT a durable record — re-hosting is the only way a
  // file stays retrievable. Still best-effort: a failure leaves storage_path
  // null and never blocks the metadata upsert below.
  //
  // `budget`, when supplied, caps network calls across the whole run; once it is
  // spent the remaining rows are stored metadata-only and a later run picks them
  // up. Metadata-only mode (rehost:false) leaves storage_path null entirely.
  if (opts.rehost !== false) {
    for (const row of rows) {
      if (opts.budget) {
        if (opts.budget.remaining <= 0) break;
        opts.budget.remaining -= 1;
      }
      row.storage_path = await rehost(supabase, row);
    }
  }

  const { error } = await supabase.from("attachments").upsert(rows);
  if (error) {
    throw new Error(`Failed to upsert attachments for ${parentType} ${parentId}: ${error.message}`);
  }
}
