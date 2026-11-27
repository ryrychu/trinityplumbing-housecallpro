# Chat AI provider (ops) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The website chat's AI call can run on Groq's free tier (or stay on OpenAI) through three optional settings.

**Architecture:** `src/lib/chat/openai.ts` moves from OpenAI's Responses API to the Chat Completions format, which OpenAI and Groq both support with strict JSON-schema replies. The URL, key and model come from `CHAT_AI_URL`, `CHAT_AI_KEY` and `CHAT_AI_MODEL`, falling back to today's OpenAI settings. The route, rate limits, saved chats and answer rules don't change.

**Tech Stack:** Next.js 14, TypeScript, vitest (node, `fetch` mocked), Supabase (unchanged).

**Spec:** in the site repo (trinity-plumbing-service), `docs/superpowers/specs/2026-11-27-chat-lookup-first-design.md`, "Part 2: ops app". The original chat spec is in this repo: `docs/superpowers/specs/2026-11-26-site-chatbot-design.md`.

**Groq facts** (checked 2026-11-27 at console.groq.com/docs: structured-outputs, reasoning, api-reference):
- Strict mode (`response_format.json_schema.strict: true`) works on `openai/gpt-oss-120b` and `openai/gpt-oss-20b`. It requires every field to be `required` and `additionalProperties: false`, which `REPLY_SCHEMA` already does.
- The cap is `max_completion_tokens` (`max_tokens` is deprecated).
- `reasoning_effort`: `"low" | "medium" | "high"` on gpt-oss (default medium). gpt-oss puts its reasoning in a separate `message.reasoning` field, and `message.content` holds the answer.
- `store` is "not currently supported" on Groq, so it is sent to OpenAI only.

## Global Constraints

- **Settings, all optional:**
  - `CHAT_AI_URL`: default `https://api.openai.com/v1/chat/completions`; for Groq, `https://api.groq.com/openai/v1/chat/completions`.
  - `CHAT_AI_KEY`: default `OPENAI_API_KEY`.
  - `CHAT_AI_MODEL`: default `OPENAI_CHAT_MODEL`, then `gpt-6-luna`.
- **`store: false`** is sent only when the URL's host is `api.openai.com`.
- **gpt-oss models** (the model name contains `gpt-oss`) get `reasoning_effort: "low"`, and their default output cap is 800. Other models keep the default of 300. `CHAT_MAX_OUTPUT_TOKENS` overrides both.
- **Unchanged behavior:** the call never throws, has a 20 s timeout, logs only an error code (never visitor text), and caps replies at 1,000 characters.
- **Unchanged:** `REPLY_SCHEMA`, the answer rules (`prompt.ts`), the route order, the rate limits and the store.
- **Known failures, not to fix here:** `npx tsc --noEmit` shows 8 errors in `src/app/api/app/**` route tests. Don't add to them.

## File map

| File | Change |
|---|---|
| `src/lib/chat/openai.ts` | Chat Completions request and parsing; `chatAiUrl`, `chatAiKey`; `askOpenAI` → `askChatAI` |
| `src/lib/chat/deps.ts` | Calls `askChatAI` |
| `src/lib/chat/handler.ts` | Passes `url: chatAiUrl(deps.env)` to `buildChatRequest` |
| `src/lib/chat/__tests__/openai.test.ts` | Rewritten for the new shape |
| `src/lib/chat/__tests__/handler.test.ts`, `answerRules.test.ts` | Read `messages` instead of `instructions`/`input` |
| `scripts/chat-eval.mts` | Uses the new settings |
| `.env.example`, `README.md`, `docs/CHAT-ROLLOUT.md` | The three settings and the Groq steps |

---

### Task 1: Chat Completions call with configurable provider

**Files:**
- Modify: `src/lib/chat/openai.ts` (rewrite)
- Modify: `src/lib/chat/deps.ts:10,18`
- Modify: `src/lib/chat/handler.ts` (imports at lines 11–18; the `buildChatRequest(...)` call at about line 147)
- Test: `src/lib/chat/__tests__/openai.test.ts` (rewrite), `src/lib/chat/__tests__/handler.test.ts`, `src/lib/chat/__tests__/answerRules.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_OPENAI_MODEL` from `@/lib/tasks/openai` (`"gpt-6-luna"`).
- Produces:
  - `OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"`, `GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"`
  - `DEFAULT_MAX_OUTPUT_TOKENS = 300`, `GPT_OSS_MAX_OUTPUT_TOKENS = 800`, `MAX_REPLY_CHARS = 1000`, `REPLY_SCHEMA` (unchanged)
  - `chatAiUrl(env?): string`, `chatAiKey(env?): string | null`, `chatModel(env?): string`, `maxOutputTokens(env?): number`
  - `buildChatRequest(instructions: string, messages: ChatMessage[], opts?: { model?: string; maxOutputTokens?: number; url?: string })`, returning `{ model, messages: [{ role: 'system', content }, ...], max_completion_tokens, response_format, store?, reasoning_effort? }`
  - `type ChatRequest = ReturnType<typeof buildChatRequest>`
  - `askChatAI(request: ChatRequest, opts?: { apiKey?: string | null; url?: string }): Promise<ChatAnswer | null>`
  - `capReply(text)`, `ChatMessage`, `ChatAnswer` (unchanged)

- [ ] **Step 0: Install dependencies (fresh worktree)**

Run: `npm ci`
Expected: completes. Then `npx vitest run src/lib/chat` passes.

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/chat/__tests__/openai.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  GPT_OSS_MAX_OUTPUT_TOKENS,
  GROQ_CHAT_URL,
  MAX_REPLY_CHARS,
  OPENAI_CHAT_URL,
  REPLY_SCHEMA,
  askChatAI,
  buildChatRequest,
  capReply,
  chatAiKey,
  chatAiUrl,
  chatModel,
  maxOutputTokens,
} from "../openai";

const fetchMock = vi.fn();

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function completion(content: string | null, finishReason = "stop", extra: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content, ...extra } }],
  };
}
const answer = (value: unknown) => reply(completion(JSON.stringify(value)));

const HISTORY = [
  { role: "user" as const, text: "Hi" },
  { role: "assistant" as const, text: "Hello!" },
  { role: "user" as const, text: "Do you clean drains?" },
];
const REQUEST = buildChatRequest("RULES", HISTORY, { model: "test-model", maxOutputTokens: 300, url: OPENAI_CHAT_URL });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("buildChatRequest", () => {
  it("sends the rules as the system message, then the history, with capped output and a strict schema", () => {
    expect(REQUEST).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "RULES" },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "Do you clean drains?" },
      ],
      max_completion_tokens: 300,
      response_format: { type: "json_schema", json_schema: { name: "chat_reply", strict: true, schema: REPLY_SCHEMA } },
      store: false,
    });
  });

  it("sends store only to OpenAI", () => {
    const groq = buildChatRequest("RULES", HISTORY, { model: "openai/gpt-oss-120b", maxOutputTokens: 800, url: GROQ_CHAT_URL });
    expect(groq).not.toHaveProperty("store");
  });

  it("asks gpt-oss models for low reasoning effort, and no other model", () => {
    const groq = buildChatRequest("RULES", HISTORY, { model: "openai/gpt-oss-120b", url: GROQ_CHAT_URL });
    expect(groq.reasoning_effort).toBe("low");
    expect(REQUEST).not.toHaveProperty("reasoning_effort");
  });

  it("gives the model no tools and nothing that keeps the chat", () => {
    for (const key of ["tools", "tool_choice", "previous_response_id", "metadata"]) expect(REQUEST).not.toHaveProperty(key);
  });
});

describe("settings", () => {
  it("default to OpenAI, OPENAI_API_KEY, gpt-6-luna and 300 tokens", () => {
    const env = { OPENAI_API_KEY: "sk-openai" };
    expect(chatAiUrl(env)).toBe(OPENAI_CHAT_URL);
    expect(chatAiKey(env)).toBe("sk-openai");
    expect(chatModel(env)).toBe("gpt-6-luna");
    expect(maxOutputTokens(env)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("take CHAT_AI_URL, CHAT_AI_KEY and CHAT_AI_MODEL over the OpenAI ones", () => {
    const env = {
      CHAT_AI_URL: ` ${GROQ_CHAT_URL} `,
      CHAT_AI_KEY: " gsk-test ",
      CHAT_AI_MODEL: " openai/gpt-oss-120b ",
      OPENAI_API_KEY: "sk-openai",
      OPENAI_CHAT_MODEL: "chat-model",
    };
    expect(chatAiUrl(env)).toBe(GROQ_CHAT_URL);
    expect(chatAiKey(env)).toBe("gsk-test");
    expect(chatModel(env)).toBe("openai/gpt-oss-120b");
  });

  it("give gpt-oss models room to reason before they answer", () => {
    expect(maxOutputTokens({ CHAT_AI_MODEL: "openai/gpt-oss-120b" })).toBe(GPT_OSS_MAX_OUTPUT_TOKENS);
  });

  it("still take OPENAI_CHAT_MODEL, and CHAT_MAX_OUTPUT_TOKENS over any default", () => {
    expect(chatModel({ OPENAI_CHAT_MODEL: "chat-model" })).toBe("chat-model");
    expect(maxOutputTokens({ CHAT_MAX_OUTPUT_TOKENS: "500", CHAT_AI_MODEL: "openai/gpt-oss-120b" })).toBe(500);
    expect(maxOutputTokens({ CHAT_MAX_OUTPUT_TOKENS: "lots" })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("ignore the checklist's OPENAI_MODEL, and treat blank settings as unset", () => {
    expect(chatModel({ OPENAI_MODEL: "checklist-model" })).toBe("gpt-6-luna");
    expect(chatAiUrl({ CHAT_AI_URL: "  " })).toBe(OPENAI_CHAT_URL);
    expect(chatAiKey({ CHAT_AI_KEY: "", OPENAI_API_KEY: "sk-openai" })).toBe("sk-openai");
    expect(chatAiKey({})).toBeNull();
  });
});

describe("askChatAI", () => {
  it("posts to the URL with the key and returns the trimmed reply and emergency flag", async () => {
    fetchMock.mockResolvedValueOnce(answer({ reply: " Yes, we clean drains. ", emergency: false }));

    expect(await askChatAI(REQUEST, { apiKey: "sk-test", url: OPENAI_CHAT_URL })).toEqual({
      reply: "Yes, we clean drains.",
      emergency: false,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENAI_CHAT_URL);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body)).toEqual(REQUEST);
  });

  it("reads a Groq gpt-oss reply, whose reasoning comes in its own field", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(completion(JSON.stringify({ reply: "Call us now.", emergency: true }), "stop", { reasoning: "The visitor smells gas." }))
    );
    expect(await askChatAI(REQUEST, { apiKey: "gsk-test", url: GROQ_CHAT_URL })).toEqual({ reply: "Call us now.", emergency: true });
    expect(fetchMock.mock.calls[0][0]).toBe(GROQ_CHAT_URL);
  });

  it("uses CHAT_AI_URL and CHAT_AI_KEY from the environment", async () => {
    vi.stubEnv("CHAT_AI_URL", GROQ_CHAT_URL);
    vi.stubEnv("CHAT_AI_KEY", "gsk-env");
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    fetchMock.mockResolvedValueOnce(answer({ reply: "Yes.", emergency: false }));
    await askChatAI(REQUEST);
    expect(fetchMock.mock.calls[0][0]).toBe(GROQ_CHAT_URL);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer gsk-env");
  });

  it("falls back to OpenAI and OPENAI_API_KEY", async () => {
    vi.stubEnv("CHAT_AI_URL", "");
    vi.stubEnv("CHAT_AI_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    fetchMock.mockResolvedValueOnce(answer({ reply: "Yes.", emergency: false }));
    await askChatAI(REQUEST);
    expect(fetchMock.mock.calls[0][0]).toBe(OPENAI_CHAT_URL);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-env");
  });

  it("returns null without a key and makes no request", async () => {
    expect(await askChatAI(REQUEST, { apiKey: null })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[chat] answer skipped: key_not_set");
  });

  it.each([
    ["an HTTP error", () => reply({ error: { message: "nope" } }, 500), "http_500"],
    ["a rate limit (Groq's free tier running out)", () => reply({ error: { message: "slow down" } }, 429), "http_429"],
    ["a body that isn't JSON", () => new Response("<html>", { status: 200 }), "bad_response"],
    ["no choices", () => reply({ choices: [] }), "no_output"],
    ["a refusal", () => reply(completion(null, "stop", { refusal: "I can't help with that." })), "refusal"],
    ["a reply cut short", () => reply(completion('{"reply":"Yes, we', "length")), "finish_length"],
    ["empty content", () => reply(completion("  ")), "no_output"],
    ["text that isn't JSON", () => reply(completion("not json")), "bad_json"],
    ["a reply that isn't a string", () => answer({ reply: 3, emergency: false }), "schema_mismatch"],
    ["an empty reply", () => answer({ reply: "  ", emergency: false }), "schema_mismatch"],
    ["no emergency flag", () => answer({ reply: "Hi" }), "schema_mismatch"],
  ])("returns null on %s and logs only the code", async (_label, make, code) => {
    fetchMock.mockResolvedValueOnce(make());
    expect(await askChatAI(REQUEST, { apiKey: "sk-test", url: OPENAI_CHAT_URL })).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(`[chat] answer skipped: ${code}`);
  });

  it("returns null on a timeout and logs only the code", async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(err);
    expect(await askChatAI(REQUEST, { apiKey: "sk-test", url: OPENAI_CHAT_URL })).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[chat] answer skipped: timeout");
  });

  it("returns null when the network fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await askChatAI(REQUEST, { apiKey: "sk-test", url: OPENAI_CHAT_URL })).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[chat] answer skipped: network");
  });

  it("shortens a long reply so it fits in the next request", async () => {
    fetchMock.mockResolvedValueOnce(answer({ reply: "word ".repeat(400).trim(), emergency: false }));
    const result = await askChatAI(REQUEST, { apiKey: "sk-test", url: OPENAI_CHAT_URL });
    expect(result!.reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
  });
});

describe("capReply", () => {
  it("leaves a short reply alone", () => {
    expect(capReply("A drain cleaning service call is from $75.")).toBe("A drain cleaning service call is from $75.");
  });

  it("cuts a long one at a word break and marks the cut", () => {
    const out = capReply("word ".repeat(300).trim());
    expect(out.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(out.endsWith("word…")).toBe(true);
  });
});
```

In `src/lib/chat/__tests__/handler.test.ts`:

- In `"answers from the model with the handoff, for a listed origin"`, replace the two lines

```ts
    expect(asked[0].instructions.startsWith(ANSWER_RULES)).toBe(true);
    expect(asked[0].input).toEqual([{ role: "user", content: ASK.messages[0].text }]);
```

with

```ts
    expect(asked[0].messages[0].role).toBe("system");
    expect(asked[0].messages[0].content.startsWith(ANSWER_RULES)).toBe(true);
    expect(asked[0].messages.slice(1)).toEqual([{ role: "user", content: ASK.messages[0].text }]);
```

- In `"sends the whole history to the model and saves only the latest visitor message"`, replace `expect(asked[0].input).toHaveLength(3);` with `expect(asked[0].messages.slice(1)).toHaveLength(3);`.
- After the test `"uses OPENAI_CHAT_MODEL from its environment"`, add:

```ts
  it("uses CHAT_AI_MODEL over OPENAI_CHAT_MODEL", async () => {
    const { deps, asked } = makeDeps({ env: { ...ENV, OPENAI_CHAT_MODEL: "chat-model", CHAT_AI_MODEL: "openai/gpt-oss-120b" } });
    await handleChat(post(ASK), deps);
    expect(asked[0].model).toBe("openai/gpt-oss-120b");
    expect(asked[0].reasoning_effort).toBe("low");
  });

  it("sends store:false only when CHAT_AI_URL is OpenAI's", async () => {
    const openai = makeDeps();
    await handleChat(post(ASK), openai.deps);
    expect(openai.asked[0].store).toBe(false);

    const groq = makeDeps({ env: { ...ENV, CHAT_AI_URL: "https://api.groq.com/openai/v1/chat/completions" } });
    await handleChat(post(ASK), groq.deps);
    expect(groq.asked[0]).not.toHaveProperty("store");
  });
```

(`makeDeps`, `ENV`, `post` and `ASK` already exist at the top of `handler.test.ts`. If `makeDeps` takes its overrides under another name, use that name.)

In `src/lib/chat/__tests__/answerRules.test.ts`:

- Change the import `import { askOpenAI, buildChatRequest } from "../openai";` to `import { OPENAI_CHAT_URL, askChatAI, buildChatRequest } from "../openai";`.
- Change the comment line ending `// in \`input\`, and nothing that lets the model look things up or keep the chat.` to `// after the system message, and nothing that lets the model look things up or keep the chat.`
- Replace `modelSays` with:

```ts
function modelSays(reply: string, emergency: boolean): Response {
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ reply, emergency }) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
```

- Replace the body of `it.each(EVAL_QUESTIONS)("builds the request for $id", ...)` with:

```ts
    fetchMock.mockResolvedValueOnce(modelSays("ok", q.emergency));
    const request = buildChatRequest(INSTRUCTIONS, [{ role: "user", text: q.text }], {
      model: "test-model",
      maxOutputTokens: 300,
      url: OPENAI_CHAT_URL,
    });

    const result = await askChatAI(request, { apiKey: "sk-test", url: OPENAI_CHAT_URL });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: "system", content: INSTRUCTIONS });
    expect(INSTRUCTIONS.startsWith(ANSWER_RULES)).toBe(true);
    expect(INSTRUCTIONS).not.toContain(q.text);
    expect(body.messages.slice(1)).toEqual([{ role: "user", content: q.text }]);
    expect(body.store).toBe(false);
    expect(body.max_completion_tokens).toBe(300);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "chat_reply", strict: true } });
    expect(result).toEqual({ reply: "ok", emergency: q.emergency });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run src/lib/chat`
Expected: FAIL. `askChatAI`, `chatAiUrl`, `chatAiKey`, `OPENAI_CHAT_URL` and the rest aren't exported yet, and the handler tests read `messages`.

- [ ] **Step 3: Replace `src/lib/chat/openai.ts` with**

```ts
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
//   CHAT_AI_KEY    default OPENAI_API_KEY.
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

export function chatAiKey(env: Env = process.env): string | null {
  return env.CHAT_AI_KEY?.trim() || env.OPENAI_API_KEY || null;
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
```

- [ ] **Step 4: Point the deps and the handler at it**

In `src/lib/chat/deps.ts`, change the header comment's "The real Supabase, OpenAI and site fetch" to "The real Supabase, chat AI and site fetch". Change the import to `import { askChatAI } from "./openai";` and the line `ask: (request) => askOpenAI(request),` to `ask: (request) => askChatAI(request),`.

In `src/lib/chat/handler.ts`, add `chatAiUrl,` to the import list from `"./openai"` (alphabetically, before `chatModel,`), and change the `buildChatRequest(...)` call to:

```ts
        buildChatRequest(buildInstructions(knowledge), input.messages, {
          model: chatModel(deps.env),
          maxOutputTokens: maxOutputTokens(deps.env),
          url: chatAiUrl(deps.env),
        })
```

In the handler's header comment, change `Order: switch → origin → input → rate limit → knowledge → OpenAI → save → reply.` to `Order: switch → origin → input → rate limit → knowledge → AI (OpenAI or Groq) → save → reply.`

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run src/lib/chat`
Expected: PASS.

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "src/app/api/app/"`
Expected: no output. The 8 known errors are all under `src/app/api/app/`. `scripts/chat-eval.mts` still imports `askOpenAI`, but `scripts/` may be outside the tsconfig `include`. If tsc does report it, Task 2 fixes it; note it and continue.

- [ ] **Step 6: Run the whole suite**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/chat/openai.ts src/lib/chat/deps.ts src/lib/chat/handler.ts src/lib/chat/__tests__/openai.test.ts src/lib/chat/__tests__/handler.test.ts src/lib/chat/__tests__/answerRules.test.ts
git commit -m "feat(chat): Chat Completions call; CHAT_AI_URL/KEY/MODEL pick OpenAI or Groq"
```

---

### Task 2: Eval script and docs

**Files:**
- Modify: `scripts/chat-eval.mts`
- Modify: `.env.example` (chat block, lines 96–101)
- Modify: `README.md` (chat paragraph, about line 251)
- Modify: `docs/CHAT-ROLLOUT.md`

**Interfaces:**
- Consumes: Task 1's `askChatAI`, `buildChatRequest`, `chatAiUrl`, `chatModel`.

- [ ] **Step 1: Change the eval script**

In `scripts/chat-eval.mts`:

1. In the header comment, replace the two lines

```ts
// Opt-in. It needs a real OPENAI_API_KEY and costs a few cents a run. It is not
// a test file, so `npm test` never picks it up, and no CI workflow runs it.
```

with

```ts
// Opt-in. It needs a real key for the configured provider: CHAT_AI_KEY (Groq's
// free tier costs nothing) or OPENAI_API_KEY (a few cents a run). It is not a
// test file, so `npm test` never picks it up, and no CI workflow runs it.
```

and replace the line `// Reads OPENAI_API_KEY (and OPENAI_CHAT_MODEL, CHAT_MAX_OUTPUT_TOKENS if set)` with

```ts
// Reads CHAT_AI_URL, CHAT_AI_KEY, CHAT_AI_MODEL (or OPENAI_API_KEY and
// OPENAI_CHAT_MODEL) and CHAT_MAX_OUTPUT_TOKENS
```

(the next line, `// from .env.local or the environment.`, stays).

2. Replace the key check:

```ts
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "[SENSITIVE]") {
  console.error(
    "OPENAI_API_KEY is not usable. Put the real key in .env.local (a value pulled\n" +
      "from Vercel reads [SENSITIVE] and can't be used)."
  );
  process.exit(1);
}
```

with:

```ts
const configuredKey = process.env.CHAT_AI_KEY?.trim() || process.env.OPENAI_API_KEY;
if (!configuredKey || configuredKey === "[SENSITIVE]") {
  console.error(
    "No usable chat key. Put the real CHAT_AI_KEY (Groq) or OPENAI_API_KEY in .env.local\n" +
      "(a value pulled from Vercel reads [SENSITIVE] and can't be used)."
  );
  process.exit(1);
}
```

3. Change `const { askOpenAI, buildChatRequest, chatModel } = await import("@/lib/chat/openai");` to:

```ts
const { askChatAI, buildChatRequest, chatAiUrl, chatModel } = await import("@/lib/chat/openai");
```

4. Change the line `console.log(\`Model ${chatModel()}, knowledge from ${source}, ${knowledge.prices.length} prices.\`);` to:

```ts
console.log(`Model ${chatModel()} at ${new URL(chatAiUrl()).host}, knowledge from ${source}, ${knowledge.prices.length} prices.`);
```

5. Change `const answer = await askOpenAI(buildChatRequest(instructions, [{ role: "user", text: q.text }]));` to:

```ts
  const answer = await askChatAI(buildChatRequest(instructions, [{ role: "user", text: q.text }]));
```

- [ ] **Step 2: Check the script compiles and refuses without a key**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "src/app/api/app/"`
Expected: no output.

If `.env.local` does not exist, or holds no real `CHAT_AI_KEY`/`OPENAI_API_KEY`, run (bash): `CHAT_AI_KEY= OPENAI_API_KEY= npm run chat:eval`
Expected: it prints "No usable chat key…" and exits 1, with no network call. If `.env.local` does hold a real key, skip this check. Don't run the eval against a real key in this task.

- [ ] **Step 3: Change `.env.example`**

Replace the lines from `# OpenAI API key (platform.openai.com, Dave's org). Also used by the Fieldy checklist.` through `CHAT_MAX_OUTPUT_TOKENS=` with:

```bash
# OpenAI API key (platform.openai.com, Dave's org). Used by the Fieldy checklist,
# and by the chat when CHAT_AI_KEY is unset.
OPENAI_API_KEY=
# Optional: where the chat's AI questions go. Unset = OpenAI with OPENAI_API_KEY.
# Groq's free tier (console.groq.com, no card on file, so it can't bill):
#   CHAT_AI_URL=https://api.groq.com/openai/v1/chat/completions
#   CHAT_AI_KEY=<Groq API key>
#   CHAT_AI_MODEL=openai/gpt-oss-120b
CHAT_AI_URL=
CHAT_AI_KEY=
CHAT_AI_MODEL=
# Optional. Default gpt-6-luna, used when CHAT_AI_MODEL is unset. The checklist's OPENAI_MODEL does not affect the chat.
OPENAI_CHAT_MODEL=
# Optional. Default 300 (800 for gpt-oss models). Raise if logs show "[chat] answer skipped: finish_length".
CHAT_MAX_OUTPUT_TOKENS=
```

- [ ] **Step 4: Change the README chat paragraph**

In `README.md`, in the paragraph that starts `The chat bubble on trinity.plumbing calls \`POST /api/chat\``, replace `through the OpenAI API` with `through a Chat Completions API (OpenAI by default, or Groq's free tier via \`CHAT_AI_URL\`, \`CHAT_AI_KEY\` and \`CHAT_AI_MODEL\`)`. Re-wrap the paragraph so no line is longer than about 80 characters.

After the line `Spec: \`docs/superpowers/specs/2026-11-26-site-chatbot-design.md\`.`, add:

```markdown
The bubble answers prices, towns, hours and booking itself; only other
questions reach this route (site repo spec
`docs/superpowers/specs/2026-11-27-chat-lookup-first-design.md`).
```

- [ ] **Step 5: Change `docs/CHAT-ROLLOUT.md`**

1. In the Go-live list, after the line ``   - confirm `OPENAI_API_KEY` is set (the Fieldy checklist already uses it)``, add:

```markdown
   - **or, to use Groq's free tier instead** (no card on file, so it can't
     bill; when the free limit runs out the bubble says "call us" until it
     resets): make an account at console.groq.com, create an API key, and set
     `CHAT_AI_URL=https://api.groq.com/openai/v1/chat/completions`,
     `CHAT_AI_KEY=<the key>` (Sensitive) and `CHAT_AI_MODEL=openai/gpt-oss-120b`.
     Read Groq's current terms first to confirm the free tier may be used on a
     business website.
```

2. In step 4 (the eval), replace `with the real key in \`.env.local\`:` with ``with the real key in `.env.local` (`CHAT_AI_URL`, `CHAT_AI_KEY` and `CHAT_AI_MODEL` for Groq, or `OPENAI_API_KEY`):``. Then replace the two lines

```markdown
   flag. "(none …)" with `incomplete_max_output_tokens` above it: set
   `CHAT_MAX_OUTPUT_TOKENS=500` and run it again.
```

with

```markdown
   flag. "(none …)" with `finish_length` above it: raise
   `CHAT_MAX_OUTPUT_TOKENS` (500, or 1200 for gpt-oss) and run it again.
```

3. In the "If something's off" table, replace the row starting ``| `[chat] answer skipped: incomplete_max_output_tokens` |`` with:

```markdown
| `[chat] answer skipped: finish_length` | Replies hit the output cap; raise `CHAT_MAX_OUTPUT_TOKENS` (500, or 1200 for gpt-oss) |
| `[chat] answer skipped: http_429` | The AI provider's rate limit; on Groq's free tier, the minute or day limit ran out. The bubble shows "call us" until it resets |
| `[chat] answer skipped: http_401` | `CHAT_AI_KEY` (or `OPENAI_API_KEY`) is wrong for `CHAT_AI_URL` |
```

- [ ] **Step 6: Run the suite and commit**

Run: `npx vitest run`
Expected: all pass. If a docs test checks `.env.example` or the README and fails on the changed wording, update that test to the new wording.

```bash
git add scripts/chat-eval.mts .env.example README.md docs/CHAT-ROLLOUT.md
git commit -m "docs(chat): Groq free tier settings, eval with any provider"
```
