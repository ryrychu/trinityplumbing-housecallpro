// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { POST, GET, DELETE } from "../route";
import { GET as metadataGET } from "@/app/.well-known/oauth-protected-resource/api/mcp/pricebook-edit/route";
import { serveMcp } from "@/lib/mcp/handler";
import { PRICEBOOK_EDIT_RESOURCE } from "@/lib/mcp/auth";
import { createPricebookEditMcpServer } from "@/lib/mcp/pricebookEdit/server";
import { NOT_EDITOR_TEXT } from "@/lib/pricebook/edit/deps";
import { DAVE, NOW, fakeSlack, fakeWriter, ids, memoryStore } from "@/lib/pricebook/edit/__tests__/fakes";

afterEach(() => vi.unstubAllEnvs());

function rpc(body: unknown, auth?: string) {
  return new Request("https://ops.example.com/api/mcp/pricebook-edit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

describe("/api/mcp/pricebook-edit", () => {
  it.each([undefined, "", "TRUE", "1"])("is off when MCP_PRICEBOOK_EDIT_ENABLED is %j", async (value) => {
    if (value !== undefined) vi.stubEnv("MCP_PRICEBOOK_EDIT_ENABLED", value);
    const res = await POST(rpc(LIST, "Bearer anything"));
    expect(res.status).toBe(503);
  });

  it("challenges with the pricebook-edit metadata URL when on", async () => {
    vi.stubEnv("MCP_PRICEBOOK_EDIT_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const res = await POST(rpc(LIST));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/pricebook-edit"'
    );
  });

  it("serves its own protected-resource metadata", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    const res = metadataGET(new Request("https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/pricebook-edit"));
    expect(await res.json()).toMatchObject({ resource: "https://ops.example.com/api/mcp/pricebook-edit", resource_name: PRICEBOOK_EDIT_RESOURCE.name });
  });

  it("passes the verified caller to the server, which refuses anyone not on the editors list", async () => {
    const verify = async () => ({ sub: "not-dave", role: "authenticated", client_id: "c1" });
    const res = await serveMcp(
      rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_items", arguments: { query: "pex" } } }, "Bearer ok"),
      {
        verify,
        resource: PRICEBOOK_EDIT_RESOURCE,
        createServer: (caller) =>
          createPricebookEditMcpServer(editorDeps(), caller.userId),
      }
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(NOT_EDITOR_TEXT);
  });

  it("allows only POST", async () => {
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
  });
});

function editorDeps() {
  const hcp = fakeWriter([]);
  const mem = memoryStore();
  const next = ids();
  return {
    edit: { store: mem.store, writer: hcp.writer, loadItems: async () => hcp.all(), now: () => NOW, newId: next },
    service: { store: mem.store, slack: fakeSlack().port, channelId: "C_PB", loadItems: async () => hcp.all(), now: () => NOW, newId: next, nameOf: () => "Dave" },
    editors: new Map([[DAVE, "Dave"]]),
    listCategories: async () => [],
    serviceConfigMissing: () => null,
  };
}
