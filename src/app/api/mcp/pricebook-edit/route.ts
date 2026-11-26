// MCP endpoint for the Trinity Price Book Editor (Dave and Ella only; writes HCP materials).
// Spec: docs/superpowers/specs/2026-11-21-pricebook-edit-design.md
//
// Not covered by src/middleware.ts on purpose: ChatGPT has no cookie session.
// Every request must carry a Supabase-issued OAuth access token instead.
import { PRICEBOOK_EDIT_RESOURCE, supabaseClaimsVerifier, type ClaimsVerifier } from "@/lib/mcp/auth";
import { methodNotAllowed, serveMcp } from "@/lib/mcp/handler";
import { createPricebookEditMcpServer, type PricebookEditToolDeps } from "@/lib/mcp/pricebookEdit/server";
import { listAllCategories, liveEditDeps, liveServiceDeps, parseEditors, pricebookEditEnabled, serviceConfigMissing } from "@/lib/pricebook/edit/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A 50-item batch or a full-book tick check can pass 60s; cron/sync already uses 300.
export const maxDuration = 300;

let verify: ClaimsVerifier | null = null;

function liveToolDeps(): PricebookEditToolDeps {
  const editors = parseEditors(process.env.MCP_PRICEBOOK_EDITORS);
  return { edit: liveEditDeps(), service: liveServiceDeps(editors), editors, listCategories: listAllCategories, serviceConfigMissing };
}

export async function POST(req: Request): Promise<Response> {
  if (!pricebookEditEnabled()) {
    return Response.json({ error: "disabled", message: "The Trinity Price Book Editor is turned off." }, { status: 503 });
  }
  verify ??= supabaseClaimsVerifier();
  return serveMcp(req, {
    verify,
    resource: PRICEBOOK_EDIT_RESOURCE,
    createServer: (caller) => createPricebookEditMcpServer(liveToolDeps(), caller.userId),
  });
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
