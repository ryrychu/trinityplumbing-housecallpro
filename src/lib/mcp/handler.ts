// Request handling for /api/mcp, kept out of the route file because Next.js
// only allows HTTP-method and config exports from route.ts.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { requestOrigin, verifyMcpToken, wwwAuthenticate, type ClaimsVerifier } from "./auth";
import type { PricebookLoader } from "./pricebook";
import { createPricebookMcpServer } from "./server";

export async function handleMcpRequest(
  req: Request,
  deps: { verify: ClaimsVerifier; load: PricebookLoader }
): Promise<Response> {
  const header = req.headers.get("authorization");
  const caller = await verifyMcpToken(header, deps.verify);
  if (!caller) {
    return Response.json(
      { error: header ? "invalid_token" : "unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": wwwAuthenticate(requestOrigin(req), Boolean(header)) } }
    );
  }

  // Stateless: a fresh server and transport per request, plain JSON replies.
  // Nothing is shared between requests except the loader's short cache.
  const server = createPricebookMcpServer(deps.load);
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
