// Request handling for the ChatGPT MCP endpoints, kept out of the route files
// because Next.js only allows HTTP-method and config exports from route.ts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  PRICEBOOK_RESOURCE,
  checkMcpToken,
  requestOrigin,
  wwwAuthenticate,
  type ClaimsVerifier,
  type McpCaller,
  type McpResource,
} from "./auth";
import type { PricebookLoader } from "./pricebook";
import { createPricebookMcpServer } from "./server";

/** One line per MCP request. Never the token, tool arguments or tool output: only what's needed to see who called what and how it went. */
export type McpLogLine = Record<string, unknown>;
export type McpLogger = (line: McpLogLine) => void;

export const consoleMcpLogger: McpLogger = (line) => console.info(`[mcp] ${JSON.stringify(line)}`);

export interface ServeMcpDeps {
  verify: ClaimsVerifier;
  resource: McpResource;
  createServer: (caller: McpCaller) => McpServer;
  /** Defaults to console.info, which Vercel's logs show. */
  log?: McpLogger;
  /** Extra fields about a signed-in caller, e.g. whether they're an editor. */
  describe?: (caller: McpCaller) => McpLogLine;
}

interface RpcSummary {
  methods: string[];
  tools: string[];
}

/** The JSON-RPC methods in a request body, and the tool names of any tools/call. */
async function summarizeRequest(req: Request): Promise<RpcSummary> {
  try {
    const body: unknown = JSON.parse(await req.clone().text());
    const messages = (Array.isArray(body) ? body : [body]) as Array<{ method?: unknown; params?: { name?: unknown } }>;
    const methods = messages.map((m) => (typeof m?.method === "string" ? m.method : "?"));
    const tools = messages
      .filter((m) => m?.method === "tools/call" && typeof m.params?.name === "string")
      .map((m) => m.params!.name as string);
    return { methods, tools };
  } catch {
    return { methods: ["unreadable"], tools: [] };
  }
}

/** For tools/list: the tool names sent back. For tools/call: whether the tool reported an error. */
async function summarizeResponse(res: Response, rpc: RpcSummary): Promise<McpLogLine> {
  if (!rpc.methods.includes("tools/list") && !rpc.methods.includes("tools/call")) return {};
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return {};
  try {
    const body: unknown = await res.clone().json();
    const replies = (Array.isArray(body) ? body : [body]) as Array<{
      result?: { tools?: Array<{ name?: unknown }>; isError?: unknown };
      error?: { code?: unknown };
    }>;
    const out: McpLogLine = {};
    if (rpc.methods.includes("tools/list")) out.listed = replies.flatMap((r) => r?.result?.tools ?? []).map((t) => String(t?.name));
    if (rpc.methods.includes("tools/call")) out.toolError = replies.some((r) => r?.result?.isError === true || r?.error !== undefined);
    const rpcErrors = replies.map((r) => r?.error?.code).filter((c) => c !== undefined);
    if (rpcErrors.length) out.rpcErrors = rpcErrors;
    return out;
  } catch {
    return {};
  }
}

export async function serveMcp(req: Request, deps: ServeMcpDeps): Promise<Response> {
  const started = Date.now();
  const log = deps.log ?? consoleMcpLogger;
  const rpc = await summarizeRequest(req);
  const base: McpLogLine = {
    resource: deps.resource.path,
    methods: rpc.methods,
    ...(rpc.tools.length ? { tool: rpc.tools } : {}),
    ua: (req.headers.get("user-agent") ?? "").slice(0, 80),
  };
  const header = req.headers.get("authorization");
  const check = await checkMcpToken(header, deps.verify);
  if (!check.ok) {
    log({ ...base, status: 401, auth: check.reason, ...(check.detail ? { detail: check.detail } : {}), ms: Date.now() - started });
    return Response.json(
      { error: header ? "invalid_token" : "unauthorized" },
      {
        status: 401,
        headers: { "WWW-Authenticate": wwwAuthenticate(requestOrigin(req), Boolean(header), deps.resource) },
      }
    );
  }
  const { caller } = check;
  const who: McpLogLine = { auth: "ok", user: caller.userId, client: caller.clientId, ...(deps.describe?.(caller) ?? {}) };

  // Stateless: a fresh server and transport per request, plain JSON replies.
  const server = deps.createServer(caller);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req, {
      authInfo: { token: caller.token, clientId: caller.clientId, scopes: [], extra: { userId: caller.userId } },
    });
    log({ ...base, ...who, status: res.status, ...(await summarizeResponse(res, rpc)), ms: Date.now() - started });
    return res;
  } catch (err) {
    log({ ...base, ...who, status: 500, error: err instanceof Error ? err.message.slice(0, 200) : "unknown", ms: Date.now() - started });
    throw err;
  } finally {
    await server.close();
  }
}

// The price book connector's entry point, unchanged for its route and tests.
export async function handleMcpRequest(
  req: Request,
  deps: { verify: ClaimsVerifier; load: PricebookLoader }
): Promise<Response> {
  return serveMcp(req, {
    verify: deps.verify,
    resource: PRICEBOOK_RESOURCE,
    createServer: () => createPricebookMcpServer(deps.load),
  });
}

// Stateless servers have no SSE stream to open and no session to delete.
export function methodNotAllowed(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
    { status: 405, headers: { Allow: "POST" } }
  );
}
