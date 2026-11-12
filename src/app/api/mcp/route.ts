// MCP endpoint for the ChatGPT price book connector (read-only).
// Spec: docs/superpowers/specs/2026-11-13-chatgpt-pricebook-connector-design.md
//
// Not covered by src/middleware.ts on purpose: ChatGPT has no cookie session.
// Every request must carry a Supabase-issued OAuth access token instead.
import { HousecallPricebookClient } from "@/lib/housecall/pricebook";
import { supabaseClaimsVerifier, type ClaimsVerifier } from "@/lib/mcp/auth";
import { handleMcpRequest } from "@/lib/mcp/handler";
import { createPricebookLoader, type PricebookLoader } from "@/lib/mcp/pricebook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Built on first use so a missing env var fails the request, not the build,
// and so the loader's cache survives between requests on a warm instance.
let deps: { verify: ClaimsVerifier; load: PricebookLoader } | null = null;
function liveDeps() {
  deps ??= {
    verify: supabaseClaimsVerifier(),
    load: createPricebookLoader(new HousecallPricebookClient()),
  };
  return deps;
}

export async function POST(req: Request): Promise<Response> {
  return handleMcpRequest(req, liveDeps());
}

// Stateless servers have no SSE stream to open and no session to delete.
function methodNotAllowed(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
    { status: 405, headers: { Allow: "POST" } }
  );
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
