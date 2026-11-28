// The real Supabase, chat AI and site fetch behind /api/chat. Kept apart from
// handler.ts so the handler and its tests never import live wiring. The
// Supabase client is made when each call runs, so building deps never throws:
// missing Supabase settings show up as a logged rate-limit or save failure.
import { randomUUID } from "node:crypto";
import { ipAddress } from "@vercel/functions";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import type { ChatDeps } from "./handler";
import { loadKnowledge } from "./knowledge";
import { askChatAI } from "./openai";
import { checkRateLimit } from "./rateLimit";
import { supabaseChatStore } from "./store";

export function liveChatDeps(): ChatDeps {
  return {
    env: process.env,
    loadKnowledge,
    ask: (request) => askChatAI(request),
    rateLimit: (input) => checkRateLimit(getSupabaseServerClient(), input),
    store: { saveTurn: (turn) => supabaseChatStore(getSupabaseServerClient()).saveTurn(turn) },
    // Vercel sets x-real-ip itself. Off Vercel (local dev) every visitor shares one bucket.
    ip: (req) => ipAddress(req) ?? "unknown",
    now: () => new Date(),
    newId: () => randomUUID(),
  };
}
