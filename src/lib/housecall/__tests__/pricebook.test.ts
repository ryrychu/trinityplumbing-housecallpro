import { describe, it, expect, vi, afterEach } from "vitest";
import { HousecallPricebookClient, HcpPricebookError, MAX_PAGES } from "../pricebook";

type Call = { url: string; init?: RequestInit };

// Every call any test makes, so afterEach can assert none of them wrote to HCP.
const allCalls: Call[] = [];

function fakeFetch(pages: (url: URL) => unknown, status = 200) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    allCalls.push({ url, init });
    return new Response(JSON.stringify(pages(new URL(url))), { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

afterEach(() => {
  for (const c of allCalls) {
    expect((c.init?.method ?? "GET").toUpperCase()).toBe("GET");
  }
  allCalls.length = 0;
  vi.unstubAllEnvs();
});

describe("HousecallPricebookClient", () => {
  it("pages through services with the API key and reads `data`", async () => {
    const f = fakeFetch((u) => {
      const page = Number(u.searchParams.get("page"));
      return { data: [{ uuid: `s${page}`, name: `Service ${page}` }], page, total_pages_count: 2 };
    });
    const res = await new HousecallPricebookClient("key-123", f.fn).listServices();

    expect(res.items.map((s) => s.uuid)).toEqual(["s1", "s2"]);
    expect(res.truncated).toBe(false);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].url).toBe("https://api.housecallpro.com/api/price_book/services?page=1&page_size=100");
    const headers = f.calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer key-123");
  });

  it("falls back to the resource key when `data` is absent", async () => {
    const f = fakeFetch(() => ({ services: [{ uuid: "a" }], page: 1, total_pages_count: 1 }));
    const res = await new HousecallPricebookClient("k", f.fn).listServices();
    expect(res.items).toEqual([{ uuid: "a" }]);
  });

  it("sends material_category_uuid for materials and parent_uuid only when given", async () => {
    const f = fakeFetch(() => ({ data: [], page: 1, total_pages_count: 1 }));
    const client = new HousecallPricebookClient("k", f.fn);
    await client.listMaterials("cat-1");
    await client.listMaterialCategories();
    await client.listMaterialCategories("parent-9");

    const [m, root, child] = f.calls.map((c) => new URL(c.url));
    expect(m.pathname).toBe("/api/price_book/materials");
    expect(m.searchParams.get("material_category_uuid")).toBe("cat-1");
    expect(root.pathname).toBe("/api/price_book/material_categories");
    expect(root.searchParams.has("parent_uuid")).toBe(false);
    expect(child.searchParams.get("parent_uuid")).toBe("parent-9");
  });

  it("stops at MAX_PAGES and reports truncation", async () => {
    const f = fakeFetch((u) => ({
      data: [{ uuid: u.searchParams.get("page") }],
      page: Number(u.searchParams.get("page")),
      total_pages_count: 999,
    }));
    const res = await new HousecallPricebookClient("k", f.fn).listServices();
    expect(f.calls).toHaveLength(MAX_PAGES);
    expect(res.truncated).toBe(true);
  });

  it("stops on an empty page when the page count is missing", async () => {
    const f = fakeFetch((u) => (u.searchParams.get("page") === "1" ? { data: [{ uuid: "x" }] } : { data: [] }));
    const res = await new HousecallPricebookClient("k", f.fn).listServices();
    expect(res.items).toHaveLength(1);
    expect(res.truncated).toBe(false);
  });

  it("throws HcpPricebookError with the status and without the response body", async () => {
    const f = fakeFetch(() => ({ secret: "do-not-leak" }), 429);
    const err = await new HousecallPricebookClient("k", f.fn).listServices().catch((e) => e);
    expect(err).toBeInstanceOf(HcpPricebookError);
    expect(err.status).toBe(429);
    expect(err.message).not.toContain("do-not-leak");
  });

  it("throws when no API key is configured", () => {
    vi.stubEnv("HOUSECALL_API_KEY", "");
    expect(() => new HousecallPricebookClient(undefined, vi.fn() as unknown as typeof fetch)).toThrow(/HOUSECALL_API_KEY/);
  });

  it("exposes no write methods", () => {
    const names = Object.getOwnPropertyNames(HousecallPricebookClient.prototype);
    expect(names.filter((n) => /create|update|delete|put|post|patch/i.test(n))).toEqual([]);
  });
});
