// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { POST, GET, DELETE } from "../route";
import { GET as metadataGET } from "@/app/.well-known/oauth-protected-resource/api/mcp/jobs/route";
import { serveMcp } from "@/lib/mcp/handler";
import { JOBS_RESOURCE } from "@/lib/mcp/auth";
import { createJobsMcpServer } from "@/lib/mcp/jobs/server";
import { stubDeps } from "@/lib/mcp/jobs/__tests__/fixtures";

afterEach(() => vi.unstubAllEnvs());

function rpc(body: unknown, auth?: string) {
  return new Request("https://ops.example.com/api/mcp/jobs", {
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

describe("/api/mcp/jobs kill switch", () => {
  it.each([undefined, "", "TRUE", "1", "yes"])("is off when MCP_JOBS_ENABLED is %j", async (value) => {
    if (value !== undefined) vi.stubEnv("MCP_JOBS_ENABLED", value);
    const res = await POST(rpc(LIST, "Bearer anything"));
    expect(res.status).toBe(503);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("challenges with the jobs metadata URL when on", async () => {
    vi.stubEnv("MCP_JOBS_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    const res = await POST(rpc(LIST));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/jobs"'
    );
  });
});

describe("/api/mcp/jobs with a valid token", () => {
  const verify = async () => ({ sub: "u1", role: "authenticated", client_id: "c1" });
  const serve = (body: unknown) =>
    serveMcp(rpc(body, "Bearer ok"), {
      verify,
      resource: JOBS_RESOURCE,
      createServer: () => createJobsMcpServer(stubDeps().deps),
    });

  it("initializes as trinity-jobs with instructions and lists the six tools", async () => {
    const init = await serve({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    const initBody = await init.json();
    expect(initBody.result.serverInfo.name).toBe("trinity-jobs");
    expect(initBody.result.instructions).toContain("search_jobs");

    const list = await serve(LIST);
    const names = (await list.json()).result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "find_customer",
      "get_customer_history",
      "get_job",
      "get_money_summary",
      "get_schedule",
      "search_jobs",
    ]);
  });

  it("runs a tool end to end", async () => {
    const res = await serve({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "find_customer", arguments: { query: "pat" } },
    });
    const body = JSON.parse((await res.json()).result.content[0].text);
    expect(body.customers.map((c: { id: string }) => c.id)).toEqual(["cus_1"]);
  });
});

describe("/api/mcp/jobs other methods", () => {
  it("answers GET and DELETE with 405", async () => {
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
  });
});

describe("/.well-known/oauth-protected-resource/api/mcp/jobs", () => {
  it("describes the jobs connector", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    const res = metadataGET(
      new Request("https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/jobs")
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: "https://ops.example.com/api/mcp/jobs",
      authorization_servers: ["https://abc.supabase.co/auth/v1"],
      scopes_supported: ["openid", "email", "profile"],
      bearer_methods_supported: ["header"],
      resource_name: "Trinity Plumbing jobs & customers (read-only)",
    });
  });
});
