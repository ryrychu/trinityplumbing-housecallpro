import { describe, it, expect, vi } from "vitest";
import { addMaterial, applyPreview, checkWriteAccess, createPreview, type EditDeps, type NewMaterial } from "../apply";
import { HcpWriteError } from "@/lib/housecall/pricebookWrite";
import type { PricebookItem } from "@/lib/mcp/pricebook";
import type { NewChange } from "../types";
import { DAVE, ELLA, NOW, fakeWriter, ids, item, memoryStore } from "./fakes";

function setup(items: PricebookItem[] = [item({ uuid: "m1" }), item({ uuid: "m2", name: "PEX elbow", priceCents: 300, costCents: 100 })]) {
  const hcp = fakeWriter(items);
  let clock = NOW;
  const mem = memoryStore(() => clock);
  const deps: EditDeps = { store: mem.store, writer: hcp.writer, loadItems: async () => hcp.all(), now: () => clock, newId: ids() };
  return { deps, hcp, mem, advance(ms: number) { clock = new Date(clock.getTime() + ms); } };
}

describe("createPreview / applyPreview", () => {
  it("stores a preview and applies exactly that list, logging each change", async () => {
    const { deps, hcp, mem } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }] }, DAVE);
    expect(p.previewId).toBe("id-1");
    expect(hcp.updates).toEqual([]);
    const r = await applyPreview(deps, p.previewId!, DAVE);
    expect(hcp.updates).toEqual([["m1", { price: 275 }]]);
    expect(r.applied).toEqual([{ uuid: "m1", name: "PEX tee", change: "price $2.50 → $2.75" }]);
    expect(mem.changes[0]).toMatchObject({ kind: "material_update", status: "applied", before: { priceCents: 250 }, after: { priceCents: 275 }, requestedBy: DAVE, batchId: r.batchId, categoryUuid: "c-pex" });
  });

  it("issues no previewId when anything is blocked", async () => {
    const { deps } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 0.1 }] }, DAVE);
    expect(p.previewId).toBeNull();
    expect(p.blocks[0].code).toBe("below_cost");
  });

  it("refuses a preview made by the other editor, a reused one, and an expired one", async () => {
    const { deps, advance } = setup();
    const a = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }] }, DAVE);
    await expect(applyPreview(deps, a.previewId!, ELLA)).rejects.toMatchObject({ code: "preview_other_editor" });
    await applyPreview(deps, a.previewId!, DAVE);
    await expect(applyPreview(deps, a.previewId!, DAVE)).rejects.toMatchObject({ code: "preview_already_applied" });
    const b = await createPreview(deps, { items: [{ uuid: "m2", price: 3.25 }] }, DAVE);
    advance(16 * 60_000);
    await expect(applyPreview(deps, b.previewId!, DAVE)).rejects.toMatchObject({ code: "preview_expired" });
  });

  it("rejects an unknown preview id with preview_not_found", async () => {
    const { deps } = setup();
    await expect(applyPreview(deps, "nope", DAVE)).rejects.toMatchObject({ code: "preview_not_found" });
  });

  it("skips an item changed in HCP since the preview", async () => {
    const { deps, hcp } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }] }, DAVE);
    hcp.items.get("m1")!.priceCents = 260;
    const r = await applyPreview(deps, p.previewId!, DAVE);
    expect(r.skipped).toEqual([{ uuid: "m1", name: "PEX tee", code: "changed_since", current: expect.objectContaining({ priceCents: 260 }) }]);
    expect(hcp.updates).toEqual([]);
  });

  it("keeps applied items when HCP fails partway, and logs the failure", async () => {
    const { deps, hcp, mem } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }, { uuid: "m2", price: 3.25 }] }, DAVE);
    hcp.failWith(500, "m2");
    const r = await applyPreview(deps, p.previewId!, DAVE);
    expect(r.applied.map((a) => a.uuid)).toEqual(["m1"]);
    expect(r.failed).toEqual([{ uuid: "m2", name: "PEX elbow", code: "http_500" }]);
    expect(mem.changes.map((c) => c.status)).toEqual(["applied", "failed"]);
    expect(r.aborted).toBeNull();
  });

  it("returns the 403 as an aborted result instead of throwing", async () => {
    const { deps, hcp, mem } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }] }, DAVE);
    hcp.failWith(403);
    const r = await applyPreview(deps, p.previewId!, DAVE);
    expect(r.aborted).toBe("key_cannot_write");
    expect(r.failed).toEqual([{ uuid: "m1", name: "PEX tee", code: "key_cannot_write" }]);
    expect(mem.changes[0]).toMatchObject({ status: "failed", errorCode: "key_cannot_write" });
  });

  it("on a 403 mid-batch, keeps the earlier applied item and keeps the preview claimed", async () => {
    const { deps, hcp, mem } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }, { uuid: "m2", price: 3.25 }] }, DAVE);
    hcp.failWith(403, "m2");
    const r = await applyPreview(deps, p.previewId!, DAVE);
    expect(r.applied.map((a) => a.uuid)).toEqual(["m1"]);
    expect(mem.changes.find((c) => c.itemUuid === "m1")).toMatchObject({ status: "applied" });
    expect(r.failed).toEqual([{ uuid: "m2", name: "PEX elbow", code: "key_cannot_write" }]);
    expect(mem.changes.find((c) => c.itemUuid === "m2")).toMatchObject({ status: "failed", errorCode: "key_cannot_write" });
    expect(r.aborted).toBe("key_cannot_write");
    expect(mem.previews.get(p.previewId!)!.appliedAt).not.toBeNull();
  });

  it("on a 403, skips every item after the failing one without writing it", async () => {
    const { deps, hcp } = setup([
      item({ uuid: "m1" }),
      item({ uuid: "m2", name: "PEX elbow", priceCents: 300, costCents: 100 }),
      item({ uuid: "m3", name: "PEX coupling", priceCents: 400, costCents: 100 }),
    ]);
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }, { uuid: "m2", price: 3.25 }, { uuid: "m3", price: 4.25 }] }, DAVE);
    hcp.failWith(403, "m2");
    const r = await applyPreview(deps, p.previewId!, DAVE);
    expect(r.skipped).toEqual([{ uuid: "m3", name: "PEX coupling", code: "key_cannot_write", current: null }]);
    expect(hcp.updates.map((u) => u[0])).toEqual(["m1"]);
  });

  it("records a per-item read error as failed and carries on with the next item", async () => {
    const { deps, hcp, mem } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }, { uuid: "m2", price: 3.25 }] }, DAVE);
    const flaky = { ...hcp.writer, async getMaterial(uuid: string) {
      if (uuid === "m1") throw new HcpWriteError(500, "/api/price_book/materials");
      return hcp.writer.getMaterial(uuid);
    } };
    const r = await applyPreview({ ...deps, writer: flaky }, p.previewId!, DAVE);
    expect(r.failed).toEqual([{ uuid: "m1", name: "PEX tee", code: "http_500" }]);
    expect(r.applied.map((a) => a.uuid)).toEqual(["m2"]);
    expect(mem.changes.map((c) => c.status)).toEqual(["failed", "applied"]);
  });

  it("keeps an applied item in applied and unlogged when its log write fails, and carries on", async () => {
    const { deps, mem } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }, { uuid: "m2", price: 3.25 }] }, DAVE);
    let calls = 0;
    const store = { ...mem.store, async insertChanges(rows: NewChange[]) {
      if (++calls === 1) throw new Error("db down");
      return mem.store.insertChanges(rows);
    } };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await applyPreview({ ...deps, store }, p.previewId!, DAVE);
    expect(r.applied.map((a) => a.uuid)).toEqual(["m1", "m2"]);
    expect(r.unlogged).toEqual([{ uuid: "m1", name: "PEX tee" }]);
    expect(errSpy).toHaveBeenCalledWith("[pricebook] change log write failed: db down");
    errSpy.mockRestore();
  });
});

describe("addMaterial", () => {
  it("creates and logs a new material", async () => {
    const { deps, hcp, mem } = setup();
    const r = await addMaterial(deps, { categoryUuid: "c-pex", name: "PEX cap", price: "1.25", cost: 0.4, description: "1/2 inch PEX brass cap fitting" }, ELLA);
    expect(r.created).toEqual({ uuid: "new-1", name: "PEX cap" });
    expect(hcp.created[0]).toEqual(["c-pex", { name: "PEX cap", price: 125, cost: 40, description: "1/2 inch PEX brass cap fitting" }]);
    expect(mem.changes[0]).toMatchObject({ kind: "material_create", before: null, status: "applied", requestedBy: ELLA });
  });
  it("blocks below cost without creating anything", async () => {
    const { deps, hcp } = setup();
    const r = await addMaterial(deps, { categoryUuid: "c-pex", name: "PEX cap", price: 0.1, cost: 0.4 }, ELLA);
    expect(r.created).toBeNull();
    expect(r.blocks[0].code).toBe("below_cost");
    expect(hcp.created).toEqual([]);
  });
  it("blocks an empty name without creating anything", async () => {
    const { deps, hcp } = setup();
    const r = await addMaterial(deps, { categoryUuid: "c-pex", name: "   ", price: 1.25, cost: 0.4 }, ELLA);
    expect(r.created).toBeNull();
    expect(r.blocks[0].code).toBe("bad_name");
    expect(hcp.created).toEqual([]);
  });
  it("blocks a missing or blank cost with bad_money, without creating anything", async () => {
    const { deps, hcp } = setup();
    const missing = await addMaterial(deps, { categoryUuid: "c-pex", name: "PEX cap", price: 1.25 } as unknown as NewMaterial, ELLA);
    expect(missing.created).toBeNull();
    expect(missing.blocks.map((b) => b.code)).toEqual(["bad_money"]);
    const blank = await addMaterial(deps, { categoryUuid: "c-pex", name: "PEX cap", price: 1.25, cost: "  " }, ELLA);
    expect(blank.created).toBeNull();
    expect(blank.blocks.map((b) => b.code)).toEqual(["bad_money"]);
    expect(hcp.created).toEqual([]);
  });
  it("reports an unlogged create as a warning instead of throwing", async () => {
    const { deps, hcp, mem } = setup();
    const store = { ...mem.store, async insertChanges(): Promise<never> { throw new Error("db down"); } };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await addMaterial({ ...deps, store }, { categoryUuid: "c-pex", name: "PEX cap", price: 1.25, cost: 0.4 }, ELLA);
    expect(r.created).toEqual({ uuid: "new-1", name: "PEX cap" });
    expect(hcp.created).toHaveLength(1);
    expect(r.warnings.map((w) => w.code)).toContain("unlogged");
    errSpy.mockRestore();
  });
});

describe("checkWriteAccess", () => {
  it("saves one material back unchanged", async () => {
    const { deps, hcp } = setup();
    expect(await checkWriteAccess(deps)).toEqual({ ok: true, item: "PEX tee" });
    expect(hcp.updates).toEqual([["m1", { name: "PEX tee" }]]);
  });
  it("reports a read-only key", async () => {
    const { deps, hcp } = setup();
    hcp.failWith(401);
    expect(await checkWriteAccess(deps)).toEqual({ ok: false, status: 401, item: "PEX tee" });
  });
  it("rethrows a server error rather than calling the key read-only", async () => {
    const { deps, hcp } = setup();
    hcp.failWith(500);
    await expect(checkWriteAccess(deps)).rejects.toMatchObject({ status: 500 });
  });
});

describe("applyPreview and fields that were empty at preview time", () => {
  it("skips an item whose empty description was filled in since the preview", async () => {
    const { deps, hcp } = setup([item({ uuid: "m1", description: "" })]);
    const p = await createPreview(deps, { items: [{ uuid: "m1", description: "1/2 inch PEX brass tee fitting, lead free" }] }, DAVE);
    hcp.items.get("m1")!.description = "Someone else's description";
    const r = await applyPreview(deps, p.previewId!, DAVE);
    expect(r.applied).toEqual([]);
    expect(r.skipped[0].code).toBe("changed_since");
    expect(hcp.updates).toEqual([]);
  });

  it("skips an item whose unset cost was set since the preview", async () => {
    const { deps, hcp } = setup([item({ uuid: "m1", costCents: null })]);
    const p = await createPreview(deps, { items: [{ uuid: "m1", cost: 1 }] }, DAVE);
    hcp.items.get("m1")!.costCents = 80;
    const r = await applyPreview(deps, p.previewId!, DAVE);
    expect(r.skipped[0].code).toBe("changed_since");
    expect(hcp.updates).toEqual([]);
  });
});
