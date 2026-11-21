import { describe, it, expect, vi } from "vitest";
import { PB_NOT_ALLOWED_TEXT, SlackPostFailed, handleServiceTap, parsePbActionId, pbActionId, requestServiceChanges, type ServiceDeps } from "../serviceChecklist";
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

describe("requestServiceChanges review fixes", () => {
  it("shows price and rename together in the label", async () => {
    const { deps, slack } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195, name: "Main drain" }], DAVE);
    expect(JSON.stringify(slack.posts[0].blocks)).toContain('Drain cleaning: $175.00 → $195.00; rename to \\"Main drain\\"');
  });

  it("flags a description change in the label", async () => {
    const { deps, slack } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195, description: "New text" }], DAVE);
    expect(JSON.stringify(slack.posts[0].blocks)).toContain("Drain cleaning: $175.00 → $195.00 · new description");
  });

  it("posts the full description when a merge adds one", async () => {
    const { deps, slack } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    await requestServiceChanges(deps, [{ uuid: "s1", description: "Camera check included" }], ELLA);
    expect(last(slack.replies)).toEqual({ channel: "C_PB", threadTs: "900.1", text: "*Drain cleaning*, new description:\nCamera check included" });
  });

  it("fills before on merge so the label isn't ? -> price", async () => {
    const { deps, mem, slack } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", description: "Camera check included" }], DAVE);
    await requestServiceChanges(deps, [{ uuid: "s1", price: 199 }], ELLA);
    expect(mem.changes[0].before?.priceCents).toBe(17500);
    const text = JSON.stringify(last(slack.updates).blocks);
    expect(text).toContain("$175.00 → $199.00");
    expect(text).not.toContain("? →");
  });

  it("blocks empty descriptions and names", async () => {
    const { deps, slack } = setup();
    const r = await requestServiceChanges(deps, [{ uuid: "s1", description: "   " }, { uuid: "s2", name: " " }], DAVE);
    expect(r.blocks.map((b) => b.code).sort()).toEqual(["bad_description", "bad_name"]);
    expect(slack.posts).toEqual([]);
  });

  it("blocks the same uuid twice in one request", async () => {
    const { deps } = setup();
    const r = await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }, { uuid: "s1", price: 196 }], DAVE);
    expect(r.blocks.map((b) => b.code)).toEqual(["duplicate_item"]);
  });

  it("dismisses the rows when the Slack post fails, so a retry starts a fresh batch", async () => {
    const { deps, mem, slack } = setup();
    let fail = true;
    const realPost = deps.slack.post;
    deps.slack = { ...deps.slack, post: async (c, t, b) => { if (fail) throw new Error("slack down"); return realPost(c, t, b); } };
    await expect(requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE)).rejects.toBeInstanceOf(SlackPostFailed);
    expect(mem.changes[0]).toMatchObject({ status: "dismissed", errorCode: "slack_post_failed" });
    fail = false;
    const r = await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    expect(r.merged).toEqual([]);
    expect(r.batchId).not.toBeNull();
    expect(slack.posts).toHaveLength(1);
  });
});

describe("requestServiceChanges after the post", () => {
  it("keeps the request and warns when a description reply fails", async () => {
    const { deps, mem } = setup();
    deps.slack = { ...deps.slack, reply: async () => { throw new Error("msg_too_long"); } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await requestServiceChanges(deps, [{ uuid: "s1", description: "Main line drain cleaning up to 150 ft, camera check included" }], DAVE);
    expect(r.batchId).not.toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain("slack_reply_failed");
    expect(mem.changes[0].status).toBe("pending");
    err.mockRestore();
  });

  it("keeps the rows pending and warns when the message link can't be saved", async () => {
    const { deps, mem, slack } = setup();
    deps.store = { ...deps.store, async setSlackMessage() { throw new Error("db down"); } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    expect(slack.posts).toHaveLength(1);
    expect(mem.changes[0].status).toBe("pending");
    expect(r.warnings.map((w) => w.code)).toContain("slack_link_not_saved");
    err.mockRestore();
  });

  it("warns instead of throwing when a merge's Slack update fails", async () => {
    const { deps } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    deps.slack = { ...deps.slack, update: async () => { throw new Error("slack down"); }, reply: async () => { throw new Error("slack down"); } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await requestServiceChanges(deps, [{ uuid: "s1", description: "Main line drain cleaning up to 150 ft, camera check included" }], DAVE);
    expect(r.merged).toHaveLength(1);
    expect(r.warnings.map((w) => w.code)).toContain("slack_reply_failed");
    err.mockRestore();
  });

  it("splits long description replies so none is over 3,500 characters", async () => {
    const book = Array.from({ length: 5 }, (_, k) => item({ uuid: `s${k}`, kind: "service", name: `Service ${k}`, priceCents: 10000, costCents: 1000 }));
    const { deps, slack, setBook } = setup();
    setBook(book);
    await requestServiceChanges(deps, book.map((b, k) => ({ uuid: b.uuid, description: String(k).repeat(2000) })), DAVE);
    expect(slack.replies.length).toBeGreaterThan(1);
    expect(slack.replies.every((r) => r.text.length <= 3500)).toBe(true);
    const all = slack.replies.map((r) => r.text).join("");
    for (let k = 0; k < 5; k++) expect(all).toContain(String(k).repeat(2000));
  });

  it("doesn't price-check a request that leaves the price alone", async () => {
    const { deps, setBook } = setup();
    setBook([item({ uuid: "s9", kind: "service", name: "Odd job", priceCents: 1000, costCents: 5000 })]);
    const r = await requestServiceChanges(deps, [{ uuid: "s9", description: "A clearer description of the odd job" }], DAVE);
    expect(r.blocks).toEqual([]);
    expect(r.batchId).not.toBeNull();
  });
});

describe("handleServiceTap", () => {
  it("escapes the service name in a mismatch reply", async () => {
    const { deps, mem, slack, setBook } = setup();
    const tub = item({ uuid: "s3", kind: "service", name: "Tub & shower <valve>", priceCents: 10000, costCents: 1000 });
    setBook([tub]);
    await requestServiceChanges(deps, [{ uuid: "s3", price: 120 }], DAVE);
    await handleServiceTap(tap(slack.lastBlocks(), pbActionId(mem.changes[0].batchId, 0), ["1"]), deps, { allowedUsers: ["U_DAVE"], note: async () => true });
    expect(last(slack.replies).text).toContain("Tub &amp; shower &lt;valve&gt;");
  });

  it("tells the thread when the HCP check fails", async () => {
    const { deps, mem, slack } = setup();
    await requestServiceChanges(deps, [{ uuid: "s1", price: 195 }], DAVE);
    deps.loadItems = async () => { throw new Error("hcp 500"); };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleServiceTap(tap(slack.lastBlocks(), pbActionId(mem.changes[0].batchId, 0), ["1"]), deps, { allowedUsers: ["U_DAVE"], note: async () => true });
    expect(mem.changes[0].status).toBe("done");
    expect(last(slack.replies).text).toBe("Couldn't check HCP just now; please double-check the change there.");
    expect(spy).toHaveBeenCalledWith("pricebook tick check failed:", "hcp 500");
    spy.mockRestore();
  });

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
