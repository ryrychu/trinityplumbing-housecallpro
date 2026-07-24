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
