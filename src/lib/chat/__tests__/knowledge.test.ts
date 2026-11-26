// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KNOWLEDGE_RETRY_MS, KNOWLEDGE_TTL_MS, createKnowledgeLoader } from "../knowledge";
import { KNOWLEDGE } from "./fixtures";

const SITE = { key: "trinity", knowledgeUrl: "https://trinity.plumbing/chat-knowledge.json" };
const OTHER = { key: "second", knowledgeUrl: "https://second.example/chat-knowledge.json" };

function ok(body: unknown = KNOWLEDGE): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
function timeout(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

let clock = 0;
const now = () => clock;

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("createKnowledgeLoader", () => {
  it("fetches the site's file, checks it and returns it", async () => {
    const fetchMock = vi.fn(async () => ok());
    const load = createKnowledgeLoader({ fetch: fetchMock, now });
    expect(await load(SITE)).toEqual(KNOWLEDGE);
    expect(fetchMock).toHaveBeenCalledWith(SITE.knowledgeUrl, expect.objectContaining({ cache: "no-store" }));
  });

  it("serves the cached copy for an hour, then fetches again", async () => {
    const fetchMock = vi.fn(async () => ok());
    const load = createKnowledgeLoader({ fetch: fetchMock, now });
    await load(SITE);
    clock += KNOWLEDGE_TTL_MS - 1;
    await load(SITE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += 1;
    await load(SITE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good copy when a refresh fails, and waits 5 minutes before trying again", async () => {
    const fetchMock = vi.fn(async () => ok());
    const load = createKnowledgeLoader({ fetch: fetchMock, now });
    await load(SITE);

    clock += KNOWLEDGE_TTL_MS;
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await load(SITE)).toEqual(KNOWLEDGE);
    expect(console.warn).toHaveBeenCalledWith("[chat] knowledge for trinity not loaded: network");

    clock += KNOWLEDGE_RETRY_MS - 1;
    await load(SITE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clock += 1;
    await load(SITE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["network", () => Promise.reject(new TypeError("fetch failed"))],
    ["timeout", () => Promise.reject(timeout())],
    ["http_404", () => Promise.resolve(new Response("not found", { status: 404 }))],
    ["bad_json", () => Promise.resolve(new Response("<html>", { status: 200 }))],
    ["schema_mismatch", () => Promise.resolve(ok({ version: 2 }))],
    ["too_large", () => Promise.resolve(new Response("x".repeat(256 * 1024 + 1), { status: 200 }))],
  ])("returns null with no good copy on %s, and logs the code", async (code, make) => {
    const load = createKnowledgeLoader({ fetch: vi.fn(make), now });
    expect(await load(SITE)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(`[chat] knowledge for trinity not loaded: ${code}`);
  });

  it("keeps one copy per site", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      ok(url === OTHER.knowledgeUrl ? { ...KNOWLEDGE, business: { ...KNOWLEDGE.business, name: "Second Co" } } : KNOWLEDGE)
    );
    const load = createKnowledgeLoader({ fetch: fetchMock as unknown as typeof fetch, now });
    expect((await load(SITE))?.business.name).toBe("Trinity Plumbing & Drains");
    expect((await load(OTHER))?.business.name).toBe("Second Co");
    expect((await load(SITE))?.business.name).toBe("Trinity Plumbing & Drains");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses redirects, so the request cannot leave the site's origin", async () => {
    const fetchMock = vi.fn(async () => ok());
    const load = createKnowledgeLoader({ fetch: fetchMock, now });
    await load(SITE);
    expect(fetchMock).toHaveBeenCalledWith(SITE.knowledgeUrl, expect.objectContaining({ redirect: "error" }));
  });

  it("rejects an over-limit content-length without reading the body", async () => {
    let pulls = 0;
    const body = new ReadableStream({
      pull() {
        pulls++;
      },
    }, { highWaterMark: 0 });
    const res = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(256 * 1024 + 1) }),
      body,
    } as unknown as Response;
    const load = createKnowledgeLoader({ fetch: vi.fn(async () => res), now });
    expect(await load(SITE)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[chat] knowledge for trinity not loaded: too_large");
    expect(pulls).toBe(0);
  });

  it("stops reading an endless body without content-length once it passes the limit", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const res = { ok: true, status: 200, headers: new Headers(), body } as unknown as Response;
    const load = createKnowledgeLoader({ fetch: vi.fn(async () => res), now });
    expect(await load(SITE)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[chat] knowledge for trinity not loaded: too_large");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(5);
  });

  it("loads a normal body that arrives in chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(KNOWLEDGE));
    const mid = Math.floor(bytes.length / 2);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    const res = { ok: true, status: 200, headers: new Headers(), body } as unknown as Response;
    const load = createKnowledgeLoader({ fetch: vi.fn(async () => res), now });
    expect(await load(SITE)).toEqual(KNOWLEDGE);
  });

  it.each([
    ["bad_json", () => new Response("<html>", { status: 200 })],
    ["schema_mismatch", () => ok({ version: 2 })],
  ])("keeps the good cached copy when a refresh returns %s", async (code, make) => {
    const fetchMock = vi.fn(async () => ok());
    const load = createKnowledgeLoader({ fetch: fetchMock, now });
    await load(SITE);

    clock += KNOWLEDGE_TTL_MS;
    fetchMock.mockImplementationOnce(async () => make());
    expect(await load(SITE)).toEqual(KNOWLEDGE);
    expect(console.warn).toHaveBeenCalledWith(`[chat] knowledge for trinity not loaded: ${code}`);
  });
});
