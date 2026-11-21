import { describe, it, expect, vi } from "vitest";
import { PB_NOT_ALLOWED_TEXT, handleServiceTap, parsePbActionId, pbActionId, requestServiceChanges, type ServiceDeps } from "../serviceChecklist";
import type { PricebookItem } from "@/lib/mcp/pricebook";
import { DAVE, ELLA, NOW, fakeSlack, ids, item, memoryStore } from "./fakes";

const DRAIN = item({ uuid: "s1", kind: "service", name: "Drain cleaning", category: "Drains", priceCents: 17500, costCents: 6000, description: "Main line drain cleaning up to 100 ft" });
const HEATER = item({ uuid: "s2", kind: "service", name: "Water heater install", category: "Heaters", priceCents: 180000, costCents: 90000, description: "Standard 50 gal tank install" });

function setup() {
  const mem = memoryStore();
  const slack = fakeSlack();
  let book: PricebookItem[] = [DRAIN, HEATER, item({ uuid: "m1" })];
  const deps: ServiceDeps = { store: mem.store, slack: slack.port, channelId: "C_PB", loadItems: async () => book, now: () => NOW, newId: ids(), nameOf: (u) => (u === DAVE ? "Dave" : u === ELLA ? "Ella" : u) };
  return { deps, mem, slack, setBook(b: PricebookItem[]) { book = b; } };
}

const tap = (blocks: unknown[], actionId: string, selected: string[], user = "U_DAVE") => ({
  type: "block_actions", user: { id: user }, response_url: "https://hooks.slack.com/actions/x",
  message: { blocks }, actions: [{ action_id: actionId, selected_options: selected.map((value) => ({ value })) }],
});
const last = <T,>(a: T[]) => a[a.length - 1];

describe("requestServiceChanges", () => {
  it("logs pending requests and posts one checklist with a thread for descriptions", async () => {
    const { deps, mem, slack } = setup();
    const r = await requestServiceChanges(deps, [{ uuid: "s1", price: 195, description: "Main line drain cleaning up to 150 ft, camera check included" }], DAVE);
    expect(r.requested).toEqual([{ id: 1, name: "Drain cleaning", change: "price $175.00 → $195.00; description changed" }]);
    expect(mem.changes[0]).toMatchObject({ kind: "service_request", status: "pending", itemKind: "service", requestedBy: DAVE, slackMessageTs: "900.1" });
    expect(slack.posts[0].channel).toBe("C_PB");
    expect(JSON.stringify(slack.posts[0].blocks)).toContain("Drain cleaning: $175.00 → $195.00");
    expect(slack.replies[0].text).toContain("camera check included");
  });

  it("blocks materials, unknown ids and below-cost prices", async () => {
    const { deps, slack } = setup();
    const r = await requestServiceChanges(deps, [{ uuid: "m1", price: 3 }, { uuid: "zz", price: 1 }, { uuid: "s1", price: 10 }], DAVE);
    expect(r.blocks.map((b) => b.code).sort()).toEqual(["below_cost", "material_use_preview", "unknown_item"]);
    expect(slack.posts).toEqual([]);
  });

  it("merges into an existing pending request for the same service", async () => {
    const { deps, mem, slack } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    const r = await requestServiceChanges(deps, [{ uuid: "s1", price: 199 }], ELLA);
    expect(r.merged).toEqual([{ id: 1, name: "Drain cleaning" }]);
    expect(mem.changes).toHaveLength(1);
    expect(mem.changes[0].after.priceCents).toBe(19900);
    expect(slack.updates).toHaveLength(1);
  });
});

describe("handleServiceTap", () => {
  it("marks a ticked service done and replies when HCP still differs", async () => {
    const { deps, mem, slack } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    const note = vi.fn(async () => true);
    await handleServiceTap(tap(slack.lastBlocks(), pbActionId(mem.changes[0].batchId, 0), ["1"]), deps, { allowedUsers: ["U_DAVE"], note });
    expect(mem.changes[0]).toMatchObject({ status: "done", resolvedBy: "U_DAVE" });
    expect(last(slack.replies).text).toBe("HCP still shows $175.00 for Drain cleaning.");
  });

  it("doesn't reply when HCP matches", async () => {
    const { deps, mem, slack, setBook } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    setBook([{ ...DRAIN, priceCents: 19500 }, HEATER]);
    const before = slack.replies.length;
    await handleServiceTap(tap(slack.lastBlocks(), pbActionId(mem.changes[0].batchId, 0), ["1"]), deps, { allowedUsers: ["U_DAVE"], note: async () => true });
    expect(slack.replies.length).toBe(before);
  });

  it("snaps back for anyone else", async () => {
    const { deps, mem, slack } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    const note = vi.fn(async () => true);
    await handleServiceTap(tap(slack.lastBlocks(), pbActionId(mem.changes[0].batchId, 0), ["1"], "U_OTHER"), deps, { allowedUsers: ["U_DAVE"], note });
    expect(mem.changes[0].status).toBe("pending");
    expect(note).toHaveBeenCalledWith("https://hooks.slack.com/actions/x", PB_NOT_ALLOWED_TEXT);
  });

  it("parses its own action ids only", () => {
    expect(parsePbActionId(pbActionId("b-1", 2))).toEqual({ batchId: "b-1", chunk: 2 });
    expect(parsePbActionId("fieldy_cb:1:0")).toBeNull();
  });
});
