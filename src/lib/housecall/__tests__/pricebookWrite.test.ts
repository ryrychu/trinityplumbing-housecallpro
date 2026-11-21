import { describe, it, expect, vi } from "vitest";
import { HousecallPricebookWriter, HcpWriteError } from "../pricebookWrite";

function fakeFetch(handler: (url: URL, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = handler(new URL(url), init ?? {});
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("HousecallPricebookWriter", () => {
  it("PUTs only the given fields to the material", async () => {
    const f = fakeFetch(() => ({ body: { uuid: "m1" } }));
    await new HousecallPricebookWriter("key-1", f.fn).updateMaterial("m 1", { price: 14500, description: "New" });
    expect(f.calls[0].url).toBe("https://api.housecallpro.com/api/price_book/materials/m%201");
    expect(f.calls[0].init.method).toBe("PUT");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer key-1");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ price: 14500, description: "New" });
  });

  it("POSTs a new material into its category and returns the uuid", async () => {
    const f = fakeFetch(() => ({ body: { uuid: "new-1", name: "Rheem XE50" } }));
    const res = await new HousecallPricebookWriter("key-1", f.fn).createMaterial("cat-1", { name: "Rheem XE50", price: 120000, cost: 80000 });
    expect(res).toEqual({ uuid: "new-1" });
    expect(f.calls[0].url).toBe("https://api.housecallpro.com/api/price_book/materials?material_category_uuid=cat-1");
    expect(f.calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ material_category_uuid: "cat-1", name: "Rheem XE50", price: 120000, cost: 80000 });
  });

  it("finds one material by listing its category", async () => {
    const f = fakeFetch(() => ({
      body: {
        data: [
          { uuid: "a", name: "Other" },
          { uuid: "m1", name: "PEX tee", price: 250, cost: 90, material_category_name: "PEX" },
        ],
        total_pages_count: 1,
      },
    }));
    const m = await new HousecallPricebookWriter("key-1", f.fn).getMaterial("m1", "cat-1");
    expect(m).toMatchObject({ kind: "material", uuid: "m1", name: "PEX tee", priceCents: 250, costCents: 90, categoryUuid: "cat-1" });
    expect(new URL(f.calls[0].url).searchParams.get("material_category_uuid")).toBe("cat-1");
    expect(f.calls[0].init.method).toBe("GET");
  });

  it("returns null when the material isn't in its category any more", async () => {
    const f = fakeFetch(() => ({ body: { data: [], total_pages_count: 1 } }));
    expect(await new HousecallPricebookWriter("key-1", f.fn).getMaterial("gone", "cat-1")).toBeNull();
  });

  it("throws HcpWriteError with status and path only, never the body", async () => {
    const f = fakeFetch(() => ({ status: 403, body: { error: { message: "secret detail" } } }));
    const err = await new HousecallPricebookWriter("key-1", f.fn).updateMaterial("m1", { price: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(HcpWriteError);
    expect(err).toMatchObject({ status: 403, path: "/api/price_book/materials/{uuid}" });
    expect(String(err.message)).not.toContain("secret");
  });
});
