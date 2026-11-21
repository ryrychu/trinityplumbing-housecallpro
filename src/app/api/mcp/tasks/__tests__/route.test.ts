// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { POST, GET, DELETE } from "../route";
import { GET as metadataGET } from "@/app/.well-known/oauth-protected-resource/api/mcp/tasks/route";
import { serveMcp } from "@/lib/mcp/handler";
import { TASKS_RESOURCE } from "@/lib/mcp/auth";
import { NOT_OWNER_TEXT, createTasksMcpServer } from "@/lib/mcp/tasks/server";
import { makeDeps } from "@/lib/tasks/__tests__/fakes";

afterEach(() => vi.unstubAllEnvs());

function rpc(body: unknown, auth?: string) {
  return new Request("https://ops.example.com/api/mcp/tasks", {
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

describe("/api/mcp/tasks", () => {
  it.each([undefined, "", "TRUE", "1"])("is off when MCP_TASKS_ENABLED is %j", async (value) => {
    if (value !== undefined) vi.stubEnv("MCP_TASKS_ENABLED", value);
    const res = await POST(rpc(LIST, "Bearer anything"));
    expect(res.status).toBe(503);
  });

  it("challenges with the tasks metadata URL when on", async () => {
    vi.stubEnv("MCP_TASKS_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const res = await POST(rpc(LIST));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/tasks"'
    );
  });

  it("serves its own protected-resource metadata", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    const res = metadataGET(new Request("https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/tasks"));
    expect(await res.json()).toMatchObject({ resource: "https://ops.example.com/api/mcp/tasks", resource_name: TASKS_RESOURCE.name });
  });

  it("passes the verified caller to the server, which refuses anyone but Dave", async () => {
    const verify = async () => ({ sub: "not-dave", role: "authenticated", client_id: "c1" });
    const res = await serveMcp(
      rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_my_tasks", arguments: {} } }, "Bearer ok"),
      {
        verify,
        resource: TASKS_RESOURCE,
        createServer: (caller) =>
          createTasksMcpServer({ checklist: makeDeps().deps, ownerUserId: "dave", configMissing: () => null }, caller.userId),
      }
    );
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(NOT_OWNER_TEXT);
  });

  it("allows only POST", async () => {
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
  });
});
