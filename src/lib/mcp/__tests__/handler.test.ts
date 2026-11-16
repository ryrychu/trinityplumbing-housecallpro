// @vitest-environment node
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { methodNotAllowed, serveMcp } from "../handler";
import { JOBS_RESOURCE } from "../auth";

const goodVerify = async () => ({ sub: "u1", role: "authenticated", client_id: "c1" });

function tinyServer() {
  const s = new McpServer({ name: "tiny", version: "1.0.0" });
  s.registerTool("ping", { description: "Reply with pong.", inputSchema: {} }, async () => ({
    content: [{ type: "text" as const, text: "pong" }],
  }));
  return s;
}

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

const deps = { verify: goodVerify, resource: JOBS_RESOURCE, createServer: tinyServer };

describe("serveMcp", () => {
  it("challenges with the resource's own metadata URL", async () => {
    const res = await serveMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://ops.example.com/.well-known/oauth-protected-resource/api/mcp/jobs"'
    );
  });

  it("marks a rejected token as invalid_token", async () => {
    const res = await serveMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "Bearer x"), {
      ...deps,
      verify: async () => null,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token", resource_metadata=".*\/api\/mcp\/jobs"$/);
  });

  it("serves the server it was given", async () => {
    const res = await serveMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "Bearer ok"), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).result.tools.map((t: { name: string }) => t.name)).toEqual(["ping"]);
  });

  it("builds a 405 for stateless servers", async () => {
    const res = methodNotAllowed();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
