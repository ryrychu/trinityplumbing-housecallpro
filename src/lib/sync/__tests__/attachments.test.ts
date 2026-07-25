import { describe, it, expect, vi } from "vitest";
import { extractAttachmentRows, syncAttachments } from "../attachments";
import type { SupabaseClient } from "@supabase/supabase-js";

// Deterministic: rehost() must never actually hit the network in tests. A
// real fetch to a fake URL can hang until timeout instead of rejecting, so
// stub it to reject immediately — rehost()'s try/catch turns this into a
// null storage_path, which is the behavior under test.
vi.stubGlobal(
  "fetch",
  vi.fn(() => Promise.reject(new Error("blocked")))
);

describe("extractAttachmentRows", () => {
  it("maps each attachment to a row with parent linkage and metadata", () => {
    const rows = extractAttachmentRows("job", "j1", {
      attachments: [
        { id: "a1", url: "https://hcp/f1.pdf", content_type: "application/pdf", file_name: "invoice.pdf" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("a1");
    expect(rows[0].parent_type).toBe("job");
    expect(rows[0].parent_id).toBe("j1");
    expect(rows[0].hcp_url).toBe("https://hcp/f1.pdf");
    expect(rows[0].file_name).toBe("invoice.pdf");
    expect(rows[0].storage_path).toBeNull();
  });

  // Live HCP attachments are {id, file_name, url, file_type} — there is no
  // content_type key (OpenAPI Attachment schema confirms it). Reading the wrong
  // name left the column null and uploaded re-hosted files with no content type.
  it("maps HCP file_type into content_type", () => {
    const rows = extractAttachmentRows("job", "j1", {
      attachments: [{ id: "a1", url: "https://hcp/f.png", file_type: "image/png", file_name: "f.png" }],
    });
    expect(rows[0].content_type).toBe("image/png");
  });

  it("still accepts content_type as an alias", () => {
    const rows = extractAttachmentRows("job", "j1", {
      attachments: [{ id: "a1", url: "https://hcp/f.pdf", content_type: "application/pdf" }],
    });
    expect(rows[0].content_type).toBe("application/pdf");
  });

  it("returns [] when there are no attachments", () => {
    expect(extractAttachmentRows("customer", "c1", {})).toEqual([]);
    expect(extractAttachmentRows("customer", "c1", { attachments: [] })).toEqual([]);
  });
});

describe("syncAttachments", () => {
  it("does not upsert when there are no attachments", async () => {
    const upsert = vi.fn(() => Promise.resolve({ error: null }));
    const supabase = { from: vi.fn(() => ({ upsert })) } as unknown as SupabaseClient;
    await syncAttachments(supabase, "job", "j1", { attachments: [] });
    expect(upsert).not.toHaveBeenCalled();
  });

  // Metadata-only path used by the incremental cron backfill: it must upsert the
  // row WITHOUT re-hosting (no fetch, no storage), leaving storage_path null.
  it("with rehost:false, upserts metadata without calling fetch or storage", async () => {
    const fetchSpy = vi.mocked(fetch);
    fetchSpy.mockClear();
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const storageFrom = vi.fn();
    const supabase = {
      from: vi.fn(() => ({ upsert })),
      storage: { from: storageFrom },
    } as unknown as SupabaseClient;

    await syncAttachments(
      supabase,
      "job",
      "j1",
      { attachments: [{ id: "a1", url: "https://hcp/f1.pdf", created_at: "2026-01-02T03:04:05Z" }] },
      { rehost: false }
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageFrom).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledOnce();
    const arg = upsert.mock.calls[0][0] as Array<{ storage_path: string | null; created_at: string | null }>;
    expect(arg[0].storage_path).toBeNull();
    expect(arg[0].created_at).toBe("2026-01-02T03:04:05Z");
  });

  // hcp_url is a presigned S3 link that expires in 1 hour, so re-hosting is the
  // only way a file stays retrievable. Network calls are bounded per cron run
  // (mirrors GeocodeBudget) so a first backfill cannot blow the 300s timeout.
  it("stops re-hosting once the run budget is exhausted, but still upserts metadata", async () => {
    const fetchSpy = vi.mocked(fetch);
    fetchSpy.mockClear();
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const supabase = { from: vi.fn(() => ({ upsert })) } as unknown as SupabaseClient;
    const budget = { remaining: 1 };

    await syncAttachments(
      supabase,
      "job",
      "j1",
      { attachments: [{ id: "a1", url: "https://hcp/1" }, { id: "a2", url: "https://hcp/2" }] },
      { budget }
    );

    expect(fetchSpy).toHaveBeenCalledOnce(); // second attachment skipped by budget
    expect(budget.remaining).toBe(0);
    const rows = upsert.mock.calls[0][0] as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["a1", "a2"]); // metadata for both
  });

  it("does not touch the network when the budget starts at zero", async () => {
    const fetchSpy = vi.mocked(fetch);
    fetchSpy.mockClear();
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const supabase = { from: vi.fn(() => ({ upsert })) } as unknown as SupabaseClient;

    await syncAttachments(
      supabase,
      "job",
      "j1",
      { attachments: [{ id: "a1", url: "https://hcp/1" }] },
      { budget: { remaining: 0 } }
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("upserts extracted rows into the attachments table", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    // No `storage` on the mock: rehost() accesses supabase.storage inside its
    // try/catch, throws, and returns null — so storage_path stays null and the
    // metadata upsert still happens. This is the intended best-effort behavior.
    const supabase = { from: vi.fn(() => ({ upsert })) } as unknown as SupabaseClient;
    await syncAttachments(supabase, "job", "j1", {
      attachments: [{ id: "a1", url: "https://hcp/f1.pdf" }],
    });
    expect(supabase.from).toHaveBeenCalledWith("attachments");
    expect(upsert).toHaveBeenCalledOnce();
    const arg = upsert.mock.calls[0][0] as Array<{ id: string; storage_path: string | null }>;
    expect(arg[0].id).toBe("a1");
    expect(arg[0].storage_path).toBeNull();
  });
});
