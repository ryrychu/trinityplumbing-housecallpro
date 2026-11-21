import { describe, it, expect } from "vitest";
import { addMaterial, applyPreview, checkWriteAccess, createPreview, type EditDeps } from "../apply";
import { DAVE, ELLA, NOW, fakeWriter, ids, item, memoryStore } from "./fakes";

function setup() {
  const hcp = fakeWriter([item({ uuid: "m1" }), item({ uuid: "m2", name: "PEX elbow", priceCents: 300, costCents: 100 })]);
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
  });

  it("turns a 401/403 into key_cannot_write", async () => {
    const { deps, hcp } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }] }, DAVE);
    hcp.failWith(403);
    await expect(applyPreview(deps, p.previewId!, DAVE)).rejects.toMatchObject({ code: "key_cannot_write" });
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
});
