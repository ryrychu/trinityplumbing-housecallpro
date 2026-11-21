import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPricebookEditMcpServer, type PricebookEditToolDeps } from "../server";
import { NOT_EDITOR_TEXT } from "@/lib/pricebook/edit/deps";
import { DAVE, ELLA, NOW, fakeSlack, fakeWriter, ids, item, memoryStore } from "@/lib/pricebook/edit/__tests__/fakes";

const BOOK = [item({ uuid: "m1" }), item({ uuid: "m2", name: "PEX elbow" }), item({ uuid: "s1", kind: "service", name: "Drain cleaning", category: "Drains", categoryUuid: undefined, priceCents: 17500, costCents: 6000 })];

type Store = ReturnType<typeof memoryStore>["store"];

async function connect(caller: string | null, wrap: (s: Store) => Store = (s) => s) {
  const hcp = fakeWriter(BOOK);
  const mem = memoryStore();
  const store = wrap(mem.store);
  const slack = fakeSlack();
  const next = ids();
  const deps: PricebookEditToolDeps = {
    edit: { store, writer: hcp.writer, loadItems: async () => hcp.all(), now: () => NOW, newId: next },
    service: { store, slack: slack.port, channelId: "C_PB", loadItems: async () => hcp.all(), now: () => NOW, newId: next, nameOf: (u) => (u === DAVE ? "Dave" : "Ella") },
    editors: new Map([[DAVE, "Dave"], [ELLA, "Ella"]]),
    listCategories: async () => [{ uuid: "c-pex", name: "PEX", parentUuid: null }],
    serviceConfigMissing: () => null,
  };
  const server = createPricebookEditMcpServer(deps, caller);
  const client = new Client({ name: "t", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, hcp, mem, slack };
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("Trinity Price Book Editor", () => {
  it("lists nine tools with honest hints", async () => {
    const { client } = await connect(DAVE);
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(Object.keys(hints).sort()).toEqual(["add_material", "apply_material_changes", "check_write_access", "find_items", "list_categories", "preview_material_changes", "recent_changes", "request_service_changes", "undo_change"]);
    expect(hints.preview_material_changes).toMatchObject({ readOnlyHint: true });
    expect(hints.apply_material_changes).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("refuses every tool for anyone else, before any work", async () => {
    const { client, hcp } = await connect("someone");
    const calls: Array<[string, Record<string, unknown>]> = [["find_items", { query: "pex" }], ["check_write_access", {}], ["undo_change", { changeId: 1 }]];
    for (const [name, args] of calls) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(NOT_EDITOR_TEXT);
    }
    expect(hcp.updates).toEqual([]);
  });

  it("previews then applies a price change", async () => {
    const { client, hcp } = await connect(ELLA);
    const p = JSON.parse(text(await client.callTool({ name: "preview_material_changes", arguments: { items: [{ uuid: "m1", price: "2.75" }] } })));
    expect(p.previewId).toBeTruthy();
    expect(p.changes[0]).toMatchObject({ uuid: "m1", change: "price $2.50 → $2.75" });
    const a = JSON.parse(text(await client.callTool({ name: "apply_material_changes", arguments: { previewId: p.previewId } })));
    expect(a.applied).toHaveLength(1);
    expect(a.note).toMatch(/^Applied in HCP/);
    expect(hcp.updates).toEqual([["m1", { price: 275 }]]);
  });

  it("does not claim success when HCP stops accepting writes partway", async () => {
    const { client, hcp } = await connect(DAVE);
    const p = JSON.parse(text(await client.callTool({ name: "preview_material_changes", arguments: { items: [{ uuid: "m1", price: 3 }, { uuid: "m2", price: 4 }] } })));
    hcp.failWith(403, "m2");
    const a = JSON.parse(text(await client.callTool({ name: "apply_material_changes", arguments: { previewId: p.previewId } })));
    expect(a.aborted).toBe("key_cannot_write");
    expect(a.note).not.toContain("Applied in HCP");
    expect(a.note).toMatch(/write access/);
  });

  it("explains a missing preview", async () => {
    const { client } = await connect(DAVE);
    const r = await client.callTool({ name: "apply_material_changes", arguments: { previewId: "nope" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/doesn't exist/);
  });

  it("routes service changes to the Slack checklist", async () => {
    const { client, slack } = await connect(DAVE);
    const r = JSON.parse(text(await client.callTool({ name: "request_service_changes", arguments: { items: [{ uuid: "s1", price: 195 }] } })));
    expect(r.requested[0]).toMatchObject({ name: "Drain cleaning" });
    expect(slack.posts).toHaveLength(1);
  });

  it("says it is safe to retry when the Slack post fails", async () => {
    const { client, slack } = await connect(DAVE);
    slack.port.post = async () => { throw new Error("slack down"); };
    const r = await client.callTool({ name: "request_service_changes", arguments: { items: [{ uuid: "s1", price: 195 }] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Couldn't post to the Slack checklist, so nothing was requested. It's safe to try again.");
  });

  it("shows recent changes with who made them", async () => {
    const { client } = await connect(DAVE);
    const p = JSON.parse(text(await client.callTool({ name: "preview_material_changes", arguments: { items: [{ uuid: "m1", price: 3 }] } })));
    await client.callTool({ name: "apply_material_changes", arguments: { previewId: p.previewId } });
    const r = JSON.parse(text(await client.callTool({ name: "recent_changes", arguments: {} })));
    expect(r.changes[0]).toMatchObject({ item: "PEX tee", by: "Dave", status: "applied", change: "price $2.50 → $3.00" });
  });

  async function previewApply(client: Client, items: unknown[]) {
    const p = JSON.parse(text(await client.callTool({ name: "preview_material_changes", arguments: { items } })));
    return p.previewId as string;
  }
  const apply = async (client: Client, previewId: string) => JSON.parse(text(await client.callTool({ name: "apply_material_changes", arguments: { previewId } })));
  const undo = async (client: Client, batchId: string) => JSON.parse(text(await client.callTool({ name: "undo_change", arguments: { batchId } })));

  it("says nothing was applied when every item failed", async () => {
    const { client, hcp } = await connect(DAVE);
    const id = await previewApply(client, [{ uuid: "m1", price: 3 }]);
    hcp.failWith(500, "m1");
    const a = await apply(client, id);
    expect(a.applied).toHaveLength(0);
    expect(a.note).toMatch(/^Nothing was applied/);
    expect(a.note).not.toContain("Applied in HCP");
  });

  it("gives old values for an item changed in HCP but not logged", async () => {
    const { client } = await connect(DAVE, (s) => ({ ...s, insertChanges: async () => { throw new Error("db down"); } }));
    const a = await apply(client, await previewApply(client, [{ uuid: "m1", price: 3 }]));
    expect(a.applied).toHaveLength(1);
    expect(a.unlogged).toEqual([{ uuid: "m1", name: "PEX tee" }]);
    expect(a.note).toContain("were changed in HCP but not recorded");
    expect(a.note).toContain("PEX tee: price was $2.50");
  });

  it("does not claim a failed, unlogged item was changed in HCP", async () => {
    const { client, hcp } = await connect(DAVE, (s) => ({ ...s, insertChanges: async () => { throw new Error("db down"); } }));
    const id = await previewApply(client, [{ uuid: "m1", price: 3 }]);
    hcp.failWith(500, "m1");
    const a = await apply(client, id);
    expect(a.unlogged).toHaveLength(1);
    expect(a.note).toContain("not changed in HCP");
    expect(a.note).not.toContain("were changed in HCP");
    expect(a.note).not.toContain("price was");
  });

  it("explains an undo that stops because the key can't write", async () => {
    const { client, hcp } = await connect(DAVE);
    const a = await apply(client, await previewApply(client, [{ uuid: "m1", price: 3 }, { uuid: "m2", price: 4 }]));
    hcp.failWith(403);
    const u = await undo(client, a.batchId);
    expect(u.aborted).toBe("key_cannot_write");
    expect(u.note).toMatch(/stopped accepting writes/);
    expect(u.note).toMatch(/write access/);
  });

  it("says when an undo reached HCP but the log wasn't updated", async () => {
    let failStatus = false;
    const { client } = await connect(DAVE, (s) => ({ ...s, setStatus: async (...args: Parameters<Store["setStatus"]>) => { if (failStatus) throw new Error("db down"); return s.setStatus(...args); } }));
    const a = await apply(client, await previewApply(client, [{ uuid: "m1", price: 3 }]));
    failStatus = true;
    const u = await undo(client, a.batchId);
    expect(u.undone).toHaveLength(1);
    expect(u.note).toContain("put back in HCP but the change log wasn't updated: PEX tee");
  });
});
