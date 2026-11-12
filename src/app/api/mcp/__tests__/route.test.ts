// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { GET, DELETE } from "../route";
import { handleMcpRequest } from "@/lib/mcp/handler";
import { GET as metadataGET } from "@/app/.well-known/oauth-protected-resource/route";
import type { Pricebook } from "@/lib/mcp/pricebook";

const BOOK: Pricebook = { items: [], truncated: false, loadedAt: "2026-11-13T00:00:00.000Z" };
const goodVerify = async () => ({ sub: "u1", role: "authenticated", client_id: "c1" });
const deps = { verify: goodVerify, load: async () => BOOK };

function rpc(body: unknown, auth?: string) {
  return new Request("https://ops.example.com/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

afterEach(() => vi.unstubAllEnvs());

describe("/api/mcp", () => {
  it("challenges a request with no token", async () => {
    const res = await handleMcpRequest(rpc(INIT), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://ops.example.com/.well-known/oauth-protected-resource"'
    );
  });

  it("rejects an invalid token with invalid_token", async () => {
    const res = await handleMcpRequest(rpc(INIT, "Bearer nope"), { ...deps, verify: async () => null });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
  });

  it("initializes and lists the four tools for a valid token", async () => {
    const init = await handleMcpRequest(rpc(INIT, "Bearer ok"), deps);
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe("trinity-pricebook");

    const list = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "Bearer ok"), deps);
    expect(list.status).toBe(200);
    const names = (await list.json()).result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["list_materials", "list_services", "pricebook_audit_report", "search_pricebook"]);
  });

  it("runs a tool end to end", async () => {
    const res = await handleMcpRequest(
      rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_services", arguments: {} } }, "Bearer ok"),
      deps
    );
    const body = await res.json();
    expect(JSON.parse(body.result.content[0].text).count).toBe(0);
  });

  it("answers GET and DELETE with 405", async () => {
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
  });
});

describe("/.well-known/oauth-protected-resource", () => {
  it("serves metadata pointing at Supabase", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    const res = metadataGET(new Request("https://ops.example.com/.well-known/oauth-protected-resource"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://ops.example.com/api/mcp");
    expect(body.authorization_servers).toEqual(["https://abc.supabase.co/auth/v1"]);
  });

  it("fails closed when Supabase isn't configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(metadataGET(new Request("https://ops.example.com/x")).status).toBe(500);
  });
});
