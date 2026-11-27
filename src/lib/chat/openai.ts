// One website-chat answer from a Chat Completions API (OpenAI's, or Groq's
// OpenAI-compatible one), as { reply, emergency } through a strict JSON
// schema. No tools; output capped; 20 s timeout.
//
// Never throws: any failure returns null and the route sends the fallback
// message. Logs only an error code, never the visitor's words.
//
// Settings, all optional:
//   CHAT_AI_URL    the full Chat Completions URL. Default OpenAI's.
//                  Groq: https://api.groq.com/openai/v1/chat/completions
//   CHAT_AI_KEY    default OPENAI_API_KEY, but only when the URL is OpenAI's.
//   CHAT_AI_MODEL  default OPENAI_CHAT_MODEL, then gpt-6-luna (the checklist's
//                  model). Groq: openai/gpt-oss-120b. OPENAI_MODEL (the
//                  checklist's own setting) never affects the chat.
//   CHAT_MAX_OUTPUT_TOKENS  default 300, or 800 for gpt-oss models, whose
//                  reasoning counts against the cap. Raise it if logs show
//                  "finish_length".
// store:false goes to OpenAI only (Groq doesn't support it). gpt-oss models
// get reasoning_effort "low". Groq docs checked 2026-11-27.
import { DEFAULT_OPENAI_MODEL } from "@/lib/tasks/openai";

type Env = Record<string, string | undefined>;

export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
export const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
export const DEFAULT_MAX_OUTPUT_TOKENS = 300;
export const GPT_OSS_MAX_OUTPUT_TOKENS = 800;
/** Same as the route's per-message limit, so a reply can go back as history. */
export const MAX_REPLY_CHARS = 1000;
const TIMEOUT_MS = 20_000;

export type ChatMessage = { role: "user" | "assistant"; text: string };
export type ChatAnswer = { reply: string; emergency: boolean };

export const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "emergency"],
  properties: {
    reply: { type: "string" },
    emergency: { type: "boolean" },
  },
} as const;

export function chatAiUrl(env: Env = process.env): string {
  return env.CHAT_AI_URL?.trim() || OPENAI_CHAT_URL;
}

/** OPENAI_API_KEY is a fallback for OpenAI's URL only, so it is never sent to another provider. */
export function chatAiKey(env: Env = process.env): string | null {
  const own = env.CHAT_AI_KEY?.trim();
  if (own) return own;
  return isOpenAI(chatAiUrl(env)) ? env.OPENAI_API_KEY || null : null;
}

export function chatModel(env: Env = process.env): string {
  return env.CHAT_AI_MODEL?.trim() || env.OPENAI_CHAT_MODEL || DEFAULT_OPENAI_MODEL;
}

function isGptOss(model: string): boolean {
  return model.includes("gpt-oss");
}

export function maxOutputTokens(env: Env = process.env): number {
  const raw = env.CHAT_MAX_OUTPUT_TOKENS?.trim() ?? "";
  if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return isGptOss(chatModel(env)) ? GPT_OSS_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS;
}

function isOpenAI(url: string): boolean {
  try {
    return new URL(url).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/** The request body, built apart from the call so tests and the eval script can read it. */
export function buildChatRequest(
  instructions: string,
  messages: ChatMessage[],
  opts: { model?: string; maxOutputTokens?: number; url?: string } = {}
) {
  const model = opts.model ?? chatModel();
  const url = opts.url ?? chatAiUrl();
  return {
    model,
    messages: [
      { role: "system" as const, content: instructions },
      ...messages.map((m) => ({ role: m.role, content: m.text })),
    ],
    max_completion_tokens: opts.maxOutputTokens ?? maxOutputTokens(),
    response_format: {
      type: "json_schema" as const,
      json_schema: { name: "chat_reply", strict: true, schema: REPLY_SCHEMA },
    },
    ...(isOpenAI(url) ? { store: false } : {}),
    ...(isGptOss(model) ? { reasoning_effort: "low" as const } : {}),
  };
}

export type ChatRequest = ReturnType<typeof buildChatRequest>;

/** Shortens a reply to MAX_REPLY_CHARS at a word break. */
export function capReply(text: string): string {
  if (text.length <= MAX_REPLY_CHARS) return text;
  const cut = text.slice(0, MAX_REPLY_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_REPLY_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function skip(code: string): null {
  console.warn(`[chat] answer skipped: ${code}`);
  return null;
}

type Completion = {
  choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }>;
};

/** The answer's text from the first choice, or the reason there isn't one. */
function completionText(data: unknown): { text: string } | { code: string } {
  const choices = (data as Completion | null)?.choices;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  if (!choice) return { code: "no_output" };
  const refusal = choice.message?.refusal;
  if (typeof refusal === "string" && refusal.trim()) return { code: "refusal" };
  if (choice.finish_reason !== "stop") return { code: `finish_${String(choice.finish_reason ?? "unknown")}` };
  const content = choice.message?.content;
  if (typeof content !== "string" || !content.trim()) return { code: "no_output" };
  return { text: content };
}

export async function askChatAI(
  request: ChatRequest,
  opts: { apiKey?: string | null; url?: string } = {}
): Promise<ChatAnswer | null> {
  const apiKey = opts.apiKey === undefined ? chatAiKey() : opts.apiKey;
  if (!apiKey) return skip("key_not_set");
  const url = opts.url ?? chatAiUrl();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return skip(err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network");
  }
  if (!res.ok) return skip(`http_${res.status}`);

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return skip("bad_response");
  }
  const out = completionText(data);
  if ("code" in out) return skip(out.code);

  let parsed: unknown;
  try {
    parsed = JSON.parse(out.text);
  } catch {
    return skip("bad_json");
  }
  const p = (parsed ?? {}) as { reply?: unknown; emergency?: unknown };
  if (typeof p.reply !== "string" || !p.reply.trim() || typeof p.emergency !== "boolean") return skip("schema_mismatch");
  return { reply: capReply(p.reply.trim()), emergency: p.emergency };
}
