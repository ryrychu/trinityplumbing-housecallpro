// The website chat bubble's backend (trinity.plumbing first).
// Spec: docs/superpowers/specs/2026-11-26-site-chatbot-design.md
//
// Not covered by src/middleware.ts on purpose: visitors' browsers on the
// site have no ops session. The origin check, input limits and rate limits
// in src/lib/chat/handler.ts are its guards; CHAT_ENABLED is its off switch.
import { liveChatDeps } from "@/lib/chat/deps";
import { handleChat, handlePreflight } from "@/lib/chat/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// OpenAI's 20 s timeout plus the knowledge fetch and two database calls.
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  return handleChat(req, liveChatDeps());
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, liveChatDeps());
}
