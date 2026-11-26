// POST /api/chat and its CORS preflight, for the website chat bubble.
// Public on purpose: no Supabase session, no MCP auth, outside the
// src/middleware.ts matcher. Its guards are the switch, the exact origin
// check, the input limits and the rate limits below.
// Spec: docs/superpowers/specs/2026-11-26-site-chatbot-design.md
//
// Order: switch → origin → input → rate limit → knowledge → OpenAI → save → reply.
import { chatConfig, chatEnabled } from "./config";
import { RATE_LIMITED_IP_REPLY, RATE_LIMITED_SITE_REPLY, fallbackReply } from "./copy";
import type { KnowledgeSource } from "./knowledge";
import {
  buildChatRequest,
  chatModel,
  maxOutputTokens,
  type ChatAnswer,
  type ChatMessage,
  type ChatRequest,
} from "./openai";
import { corsHeaders, isListedOrigin, preflightResponse, siteFor } from "./origin";
import { buildInstructions } from "./prompt";
import { hashIp, type RateInput, type RateResult } from "./rateLimit";
import type { ChatKnowledge } from "./schema";
import type { ChatStore } from "./store";

type Env = Record<string, string | undefined>;

export type ChatDeps = {
  env: Env;
  /** Never throws; null when there's no good copy. */
  loadKnowledge(site: KnowledgeSource): Promise<ChatKnowledge | null>;
  /** Never throws; null on any failure. */
  ask(request: ChatRequest): Promise<ChatAnswer | null>;
  /** Throws on a database error. */
  rateLimit(input: RateInput): Promise<RateResult>;
  store: ChatStore;
  ip(req: Request): string;
  now(): Date;
  newId(): string;
};

export type Handoff = { phone: string | null; contactUrl: string | null };
export type ChatReplyBody = {
  conversationId: string | null;
  reply: string;
  handoff: Handoff;
  emergency: boolean;
  limited?: true;
};

export const MAX_MESSAGES = 10;
export const MAX_MESSAGE_CHARS = 1000;
const MAX_BODY_CHARS = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChatInput = { site: string; conversationId: string | null; messages: ChatMessage[] };

/** The request body, or null when it breaks a rule (a 400). */
export function parseChatInput(raw: string): ChatInput | null {
  if (raw.length > MAX_BODY_CHARS) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const b = body as { site?: unknown; conversationId?: unknown; messages?: unknown };
  if (typeof b.site !== "string") return null;

  let conversationId: string | null = null;
  if (b.conversationId !== undefined && b.conversationId !== null) {
    if (typeof b.conversationId !== "string" || !UUID.test(b.conversationId)) return null;
    conversationId = b.conversationId.toLowerCase();
  }

  if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > MAX_MESSAGES) return null;
  const messages: ChatMessage[] = [];
  for (const m of b.messages as Array<{ role?: unknown; text?: unknown } | null>) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") return null;
    const text = m.text.trim();
    if (!text || text.length > MAX_MESSAGE_CHARS) return null;
    messages.push({ role: m.role as ChatMessage["role"], text });
  }
  if (messages[messages.length - 1].role !== "user") return null;
  return { site: b.site, conversationId, messages };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: origin ? corsHeaders(origin) : {} });
}

function replyBody(conversationId: string | null, reply: string, knowledge: ChatKnowledge | null, emergency: boolean): ChatReplyBody {
  return {
    conversationId,
    reply,
    handoff: { phone: knowledge?.business.phone ?? null, contactUrl: knowledge?.links.contact ?? null },
    emergency,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleChat(req: Request, deps: ChatDeps): Promise<Response> {
  const origin = req.headers.get("origin");
  const config = chatConfig(deps.env);
  // CORS headers only ever go to an origin listed in CHAT_SITES.
  const allowed = config.ok && isListedOrigin(config.sites, origin) ? origin : null;

  // 1. The switch. The bubble shows its "off" message and hides for the session.
  if (!chatEnabled(deps.env)) return json({ off: true }, 503, allowed);
  if (!config.ok) {
    console.warn(`[chat] off: ${config.missing}`);
    return json({ off: true }, 503, null);
  }

  // 2. Origin: listed for some site, or nothing more happens.
  if (!allowed) return json({ error: "forbidden" }, 403, null);

  // 3. Input, then the origin must belong to the site the body names.
  const input = parseChatInput(await req.text().catch(() => ""));
  if (!input) return json({ error: "bad_request" }, 400, allowed);
  const site = siteFor(config.sites, input.site, allowed);
  if (!site) return json({ error: "forbidden" }, 403, allowed);

  // 4. Rate limits. Without the counters there's no cost cap, so no model call.
  const now = deps.now();
  let rate: RateResult;
  try {
    rate = await deps.rateLimit({ site: site.key, ipHash: hashIp(deps.ip(req), config.ipSalt), limits: config.limits, now });
  } catch (err) {
    console.error("[chat] rate limit check failed:", message(err));
    return json(replyBody(input.conversationId, fallbackReply(null), null, false), 200, allowed);
  }
  if (!rate.ok) {
    const text = rate.scope === "ip" ? RATE_LIMITED_IP_REPLY : RATE_LIMITED_SITE_REPLY;
    return json({ ...replyBody(input.conversationId, text, null, false), limited: true }, 429, allowed);
  }

  // 5. Knowledge and the model. Either failing means the fallback message.
  const conversationId = input.conversationId ?? deps.newId();
  const knowledge = await deps.loadKnowledge(site);
  const answer = knowledge
    ? await deps.ask(
        buildChatRequest(buildInstructions(knowledge), input.messages, {
          model: chatModel(deps.env),
          maxOutputTokens: maxOutputTokens(deps.env),
        })
      )
    : null;
  const reply = answer?.reply ?? fallbackReply(knowledge?.business.phone ?? null);
  const emergency = answer?.emergency ?? false;

  // 6. Save the latest visitor message and the reply (masked in the store).
  // A failed save is logged and never blocks the reply.
  try {
    await deps.store.saveTurn({
      conversationId,
      site: site.key,
      userText: input.messages[input.messages.length - 1].text,
      reply,
      emergency,
    });
  } catch (err) {
    console.error("[chat] turn not saved:", message(err));
  }

  // 7. Reply.
  return json(replyBody(conversationId, reply, knowledge, emergency), 200, allowed);
}

/** OPTIONS: answered for listed origins even while CHAT_ENABLED is off, so the bubble can read the 503. */
export function handlePreflight(req: Request, deps: Pick<ChatDeps, "env">): Response {
  const config = chatConfig(deps.env);
  return preflightResponse(config.ok ? config.sites : [], req.headers.get("origin"));
}
