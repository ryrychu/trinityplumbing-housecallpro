import { describe, it, expect } from "vitest";
import { addMaterial, applyPreview, createPreview, type EditDeps } from "../apply";
import { undoChange } from "../undo";
import { DAVE, NOW, fakeWriter, ids, item, memoryStore } from "./fakes";

function setup() {
  const hcp = fakeWriter([item({ uuid: "m1" }), item({ uuid: "m2", name: "PEX elbow", priceCents: 300, costCents: 100 })]);
  let clock = NOW;
  const mem = memoryStore(() => NOW);
  const deps: EditDeps = { store: mem.store, writer: hcp.writer, loadItems: async () => hcp.all(), now: () => clock, newId: ids() };
  return { deps, hcp, mem, setNow(d: Date) { clock = d; } };
}

async function applied(deps: EditDeps) {
  const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }, { uuid: "m2", price: 3.25 }] }, DAVE);
  return applyPreview(deps, p.previewId!, DAVE);
}

describe("undoChange", () => {
  it("puts a whole batch back and logs the undo", async () => {
    const { deps, hcp, mem } = setup();
    const r = await applied(deps);
    const u = await undoChange(deps, { batchId: r.batchId }, DAVE);
    expect(u.undone.map((x) => x.name)).toEqual(["PEX tee", "PEX elbow"]);
    expect(hcp.items.get("m1")!.priceCents).toBe(250);
    expect(mem.changes.filter((c) => c.kind === "undo")).toHaveLength(2);
    expect(mem.changes.filter((c) => c.kind === "material_update").every((c) => c.status === "undone")).toBe(true);
  });

  it("stops for an item changed since, without overwriting it", async () => {
    const { deps, hcp, mem } = setup();
    const r = await applied(deps);
    hcp.items.get("m1")!.priceCents = 299;
    const u = await undoChange(deps, { batchId: r.batchId }, DAVE);
    const teeId = mem.changes.find((c) => c.itemUuid === "m1")!.id;
    expect(u.skipped).toEqual([{ id: teeId, name: "PEX tee", code: "changed_since", current: expect.objectContaining({ priceCents: 299 }) }]);
    expect(hcp.items.get("m1")!.priceCents).toBe(299);
    expect(u.undone.map((x) => x.name)).toEqual(["PEX elbow"]);
  });

  it("can't undo a new material, and says so", async () => {
    const { deps, mem } = setup();
    await addMaterial(deps, { categoryUuid: "c-pex", name: "PEX cap", price: 1.25, cost: 0.4 }, DAVE);
    const u = await undoChange(deps, { changeId: mem.changes[0].id }, DAVE);
    expect(u.skipped[0].code).toBe("create_cannot_be_undone");
  });

  it("refuses changes older than 30 days", async () => {
    const { deps, setNow } = setup();
    const r = await applied(deps);
    setNow(new Date(NOW.getTime() + 31 * 86_400_000));
    const u = await undoChange(deps, { batchId: r.batchId }, DAVE);
    expect(u.skipped.map((s) => s.code)).toEqual(["too_old", "too_old"]);
  });
});
