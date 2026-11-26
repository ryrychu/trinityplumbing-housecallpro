// One website-chat answer from the OpenAI Responses API, as { reply, emergency }
// through Structured Outputs, the same way the Fieldy grouping asks
// (src/lib/tasks/openai.ts). store:false so OpenAI keeps no stored response;
// no tools; output capped; 20 s timeout.
//
// Never throws: any failure returns null and the route sends the fallback
// message. Logs only an error code, never the visitor's words.
//
// Model: gpt-6-luna by default, the checklist's model. OPENAI_CHAT_MODEL
// overrides it for the chat alone; OPENAI_MODEL (the checklist's) does not.
// CHAT_MAX_OUTPUT_TOKENS raises the cap if replies come back
// "incomplete_max_output_tokens" (reasoning tokens count against it).
import { DEFAULT_OPENAI_MODEL, OPENAI_RESPONSES_URL, outputText } from "@/lib/tasks/openai";

type Env = Record<string, string | undefined>;

export const DEFAULT_MAX_OUTPUT_TOKENS = 300;
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

export function chatModel(env: Env = process.env): string {
  return env.OPENAI_CHAT_MODEL || DEFAULT_OPENAI_MODEL;
}

export function maxOutputTokens(env: Env = process.env): number {
  const raw = env.CHAT_MAX_OUTPUT_TOKENS?.trim() ?? "";
  return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : DEFAULT_MAX_OUTPUT_TOKENS;
}

/** The request body, built apart from the call so tests and the eval script can read it. */
export function buildChatRequest(
  instructions: string,
  messages: ChatMessage[],
  opts: { model?: string; maxOutputTokens?: number } = {}
) {
  return {
    model: opts.model ?? chatModel(),
    instructions,
    input: messages.map((m) => ({ role: m.role, content: m.text })),
    store: false,
    max_output_tokens: opts.maxOutputTokens ?? maxOutputTokens(),
    text: { format: { type: "json_schema", name: "chat_reply", strict: true, schema: REPLY_SCHEMA } },
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

export async function askOpenAI(request: ChatRequest, opts: { apiKey?: string | null } = {}): Promise<ChatAnswer | null> {
  const apiKey = opts.apiKey === undefined ? process.env.OPENAI_API_KEY || null : opts.apiKey;
  if (!apiKey) return skip("key_not_set");

  let res: Response;
  try {
    res = await fetch(OPENAI_RESPONSES_URL, {
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
  const d = (data ?? {}) as { status?: unknown; incomplete_details?: { reason?: unknown } };
  if (d.status === "incomplete") return skip(`incomplete_${String(d.incomplete_details?.reason ?? "unknown")}`);
  const text = outputText(data);
  if (text === null) return skip("no_output");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return skip("bad_json");
  }
  const p = (parsed ?? {}) as { reply?: unknown; emergency?: unknown };
  if (typeof p.reply !== "string" || !p.reply.trim() || typeof p.emergency !== "boolean") return skip("schema_mismatch");
  return { reply: capReply(p.reply.trim()), emergency: p.emergency };
}
