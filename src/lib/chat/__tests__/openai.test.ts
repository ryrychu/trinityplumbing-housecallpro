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

  it("never fall back to OPENAI_API_KEY when CHAT_AI_URL isn't OpenAI's", () => {
    expect(chatAiKey({ CHAT_AI_URL: GROQ_CHAT_URL, OPENAI_API_KEY: "sk-openai" })).toBeNull();
    expect(chatAiKey({ CHAT_AI_URL: GROQ_CHAT_URL, CHAT_AI_KEY: "  ", OPENAI_API_KEY: "sk-openai" })).toBeNull();
    expect(chatAiKey({ CHAT_AI_URL: GROQ_CHAT_URL, CHAT_AI_KEY: "gsk-own", OPENAI_API_KEY: "sk-openai" })).toBe("gsk-own");
    expect(chatAiKey({ CHAT_AI_URL: OPENAI_CHAT_URL, OPENAI_API_KEY: "sk-openai" })).toBe("sk-openai");
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
    const groqRequest = buildChatRequest("RULES", HISTORY, { model: "openai/gpt-oss-120b", url: GROQ_CHAT_URL });
    fetchMock.mockResolvedValueOnce(
      reply(completion(JSON.stringify({ reply: "Call us now.", emergency: true }), "stop", { reasoning: "The visitor smells gas." }))
    );
    expect(await askChatAI(groqRequest, { apiKey: "gsk-test", url: GROQ_CHAT_URL })).toEqual({ reply: "Call us now.", emergency: true });
    expect(fetchMock.mock.calls[0][0]).toBe(GROQ_CHAT_URL);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("store");
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

  it("sends nothing, and logs key_not_set, for a Groq URL with no CHAT_AI_KEY even if OPENAI_API_KEY is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("CHAT_AI_URL", GROQ_CHAT_URL);
    vi.stubEnv("CHAT_AI_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    expect(await askChatAI(REQUEST)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[chat] answer skipped: key_not_set");
    warn.mockRestore();
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
