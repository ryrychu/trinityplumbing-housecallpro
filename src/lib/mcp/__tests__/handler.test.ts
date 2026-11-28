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

  describe("logging", () => {
    function capture() {
      const lines: Array<Record<string, unknown>> = [];
      return { lines, log: (l: Record<string, unknown>) => void lines.push(l) };
    }

    it("logs a turned-away request with its reason, and never the token", async () => {
      const { lines, log } = capture();
      await serveMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "Bearer secret-token"), {
        ...deps,
        log,
        verify: async () => {
          throw new Error("JWT expired");
        },
      });
      expect(lines).toEqual([
        expect.objectContaining({ resource: "/api/mcp/jobs", methods: ["tools/list"], status: 401, auth: "verify_error", detail: "JWT expired" }),
      ]);
      expect(JSON.stringify(lines)).not.toContain("secret-token");
    });

    it("logs a request with no token as no_header", async () => {
      const { lines, log } = capture();
      await serveMcp(rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }), { ...deps, log });
      expect(lines[0]).toMatchObject({ status: 401, auth: "no_header", methods: ["initialize"] });
    });

    it("logs the caller, the tools listed and the describe() fields", async () => {
      const { lines, log } = capture();
      await serveMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "Bearer ok"), {
        ...deps,
        log,
        describe: () => ({ editor: false }),
      });
      expect(lines[0]).toMatchObject({ status: 200, auth: "ok", user: "u1", client: "c1", editor: false, listed: ["ping"] });
    });

    it("logs the tool called and whether it failed, but not its arguments", async () => {
      const { lines, log } = capture();
      await serveMcp(
        rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: { note: "private words" } } }, "Bearer ok"),
        { ...deps, log }
      );
      expect(lines[0]).toMatchObject({ status: 200, methods: ["tools/call"], tool: ["ping"], toolError: false });
      expect(JSON.stringify(lines)).not.toContain("private words");
    });

    it("still serves the request after reading its body for the log", async () => {
      const { log } = capture();
      const res = await serveMcp(rpc({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, "Bearer ok"), { ...deps, log });
      expect((await res.json()).result.tools).toHaveLength(1);
    });
  });

  it("builds a 405 for stateless servers", async () => {
    const res = methodNotAllowed();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});
