// MCP endpoint for the Trinity Tasks connector (Dave only; reads and writes Fieldy, posts to Slack).
// Spec: docs/superpowers/specs/2026-11-21-fieldy-checklist-design.md
//
// Not covered by src/middleware.ts on purpose: ChatGPT has no cookie session.
// Every request must carry a Supabase-issued OAuth access token instead.
import { TASKS_RESOURCE, supabaseClaimsVerifier, type ClaimsVerifier } from "@/lib/mcp/auth";
import { methodNotAllowed, serveMcp } from "@/lib/mcp/handler";
import { liveTasksDeps, mcpTasksEnabled } from "@/lib/mcp/tasks/deps";
import { createTasksMcpServer } from "@/lib/mcp/tasks/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Built on first use so a missing env var fails the request, not the build.
let verify: ClaimsVerifier | null = null;

export async function POST(req: Request): Promise<Response> {
  // Before the token check, so a switched-off connector reveals nothing and runs nothing.
  if (!mcpTasksEnabled()) {
    return Response.json({ error: "disabled", message: "The Trinity Tasks connector is turned off." }, { status: 503 });
  }
  verify ??= supabaseClaimsVerifier();
  return serveMcp(req, {
    verify,
    resource: TASKS_RESOURCE,
    createServer: (caller) => createTasksMcpServer(liveTasksDeps(), caller.userId),
  });
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
