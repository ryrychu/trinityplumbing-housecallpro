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

  it("writes the undo row with before and after swapped", async () => {
    const { deps, mem } = setup();
    const r = await applied(deps);
    await undoChange(deps, { batchId: r.batchId }, DAVE);
    const row = mem.changes.find((c) => c.kind === "undo" && c.itemUuid === "m1");
    expect(row).toMatchObject({ before: { priceCents: 275 }, after: { priceCents: 250 }, status: "applied", itemUuid: "m1" });
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

  it("dismisses a pending service request and reports its batch", async () => {
    const { deps, mem } = setup();
    const [row] = await mem.store.insertChanges([{ batchId: "svc-1", kind: "service_request", itemUuid: "s1", itemName: "Drain cleaning", itemKind: "service", categoryUuid: null, before: null, after: { name: "Drain cleaning" }, status: "pending", requestedBy: DAVE, errorCode: null }]);
    const u = await undoChange(deps, { changeId: row.id }, DAVE);
    expect(u.dismissed).toEqual([{ id: row.id, name: "Drain cleaning" }]);
    expect(u.serviceBatches).toEqual(["svc-1"]);
    expect(mem.changes.find((c) => c.id === row.id)!.status).toBe("dismissed");
  });

  it("gives not_undoable for a failed material row", async () => {
    const { deps, hcp, mem } = setup();
    const p = await createPreview(deps, { items: [{ uuid: "m1", price: 2.75 }] }, DAVE);
    hcp.failWith(500, "m1");
    await applyPreview(deps, p.previewId!, DAVE);
    const u = await undoChange(deps, { changeId: mem.changes[0].id }, DAVE);
    expect(u.skipped[0].code).toBe("not_undoable");
  });

  it("stops the whole undo on a 403 and reports key_cannot_write for the rest", async () => {
    const { deps, hcp } = setup();
    const r = await applied(deps);
    hcp.failWith(403);
    const u = await undoChange(deps, { batchId: r.batchId }, DAVE);
    expect(u.aborted).toBe("key_cannot_write");
    expect(u.skipped.map((s) => s.code)).toEqual(["key_cannot_write", "key_cannot_write"]);
    expect(u.undone).toEqual([]);
  });
});

describe("undoChange with fields that were empty before", () => {
  it("clears a part number that was set where there was none", async () => {
    const hcp = fakeWriter([item({ uuid: "m1", partNumber: null })]);
    const mem = memoryStore(() => NOW);
    const deps: EditDeps = { store: mem.store, writer: hcp.writer, loadItems: async () => hcp.all(), now: () => NOW, newId: ids() };
    const p = await createPreview(deps, { items: [{ uuid: "m1", partNumber: "ABC-1" }] }, DAVE);
    expect(p.changes[0].before).toEqual({ partNumber: "" });
    const r = await applyPreview(deps, p.previewId!, DAVE);
    const u = await undoChange(deps, { batchId: r.batchId }, DAVE);
    expect(u.undone).toHaveLength(1);
    expect(hcp.updates[hcp.updates.length - 1]).toEqual(["m1", { part_number: "" }]);
    expect(hcp.items.get("m1")!.partNumber).toBe("");
  });

  it("won't report a number it can't clear as undone", async () => {
    const hcp = fakeWriter([item({ uuid: "m1", costCents: null })]);
    const mem = memoryStore(() => NOW);
    const deps: EditDeps = { store: mem.store, writer: hcp.writer, loadItems: async () => hcp.all(), now: () => NOW, newId: ids() };
    const p = await createPreview(deps, { items: [{ uuid: "m1", cost: 1 }] }, DAVE);
    const r = await applyPreview(deps, p.previewId!, DAVE);
    const writes = hcp.updates.length;
    const u = await undoChange(deps, { batchId: r.batchId }, DAVE);
    expect(u.undone).toEqual([]);
    expect(u.skipped[0]).toMatchObject({ code: "cannot_restore_unset", fields: ["costCents"] });
    expect(hcp.updates).toHaveLength(writes);
    expect(mem.changes.find((c) => c.kind === "material_update")!.status).toBe("applied");
  });
});
