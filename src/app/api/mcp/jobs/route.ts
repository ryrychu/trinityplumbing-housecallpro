// MCP endpoint for the ChatGPT jobs & customers connector (read-only).
// Spec: docs/superpowers/specs/2026-11-17-chatgpt-jobs-connector-design.md
//
// Not covered by src/middleware.ts on purpose: ChatGPT has no cookie session.
// Every request must carry a Supabase-issued OAuth access token instead.
import { JOBS_RESOURCE, supabaseClaimsVerifier, type ClaimsVerifier } from "@/lib/mcp/auth";
import { methodNotAllowed, serveMcp } from "@/lib/mcp/handler";
import { liveJobsDeps, mcpJobsEnabled } from "@/lib/mcp/jobs/deps";
import { createJobsMcpServer } from "@/lib/mcp/jobs/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Built on first use so a missing env var fails the request, not the build.
let verify: ClaimsVerifier | null = null;

export async function POST(req: Request): Promise<Response> {
  // Before the token check, so a switched-off connector reveals nothing and
  // runs nothing.
  if (!mcpJobsEnabled()) {
    return Response.json(
      { error: "disabled", message: "The Trinity jobs connector is turned off." },
      { status: 503 }
    );
  }
  verify ??= supabaseClaimsVerifier();
  const deps = liveJobsDeps();
  return serveMcp(req, { verify, resource: JOBS_RESOURCE, createServer: () => createJobsMcpServer(deps) });
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
