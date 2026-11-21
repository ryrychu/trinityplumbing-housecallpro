// Request handling for the ChatGPT MCP endpoints, kept out of the route files
// because Next.js only allows HTTP-method and config exports from route.ts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  PRICEBOOK_RESOURCE,
  requestOrigin,
  verifyMcpToken,
  wwwAuthenticate,
  type ClaimsVerifier,
  type McpCaller,
  type McpResource,
} from "./auth";
import type { PricebookLoader } from "./pricebook";
import { createPricebookMcpServer } from "./server";

export interface ServeMcpDeps {
  verify: ClaimsVerifier;
  resource: McpResource;
  createServer: (caller: McpCaller) => McpServer;
}

export async function serveMcp(req: Request, deps: ServeMcpDeps): Promise<Response> {
  const header = req.headers.get("authorization");
  const caller = await verifyMcpToken(header, deps.verify);
  if (!caller) {
    return Response.json(
      { error: header ? "invalid_token" : "unauthorized" },
      {
        status: 401,
        headers: { "WWW-Authenticate": wwwAuthenticate(requestOrigin(req), Boolean(header), deps.resource) },
      }
    );
  }

  // Stateless: a fresh server and transport per request, plain JSON replies.
  const server = deps.createServer(caller);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, {
      authInfo: { token: caller.token, clientId: caller.clientId, scopes: [], extra: { userId: caller.userId } },
    });
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
