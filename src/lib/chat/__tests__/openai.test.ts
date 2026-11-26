import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OPENAI_RESPONSES_URL } from "@/lib/tasks/openai";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_REPLY_CHARS,
  REPLY_SCHEMA,
  askOpenAI,
  buildChatRequest,
  capReply,
  chatModel,
  maxOutputTokens,
} from "../openai";

const fetchMock = vi.fn();

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function message(text: string) {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}
const answer = (value: unknown) => reply(message(JSON.stringify(value)));

const REQUEST = buildChatRequest(
  "RULES",
  [
    { role: "user", text: "Hi" },
    { role: "assistant", text: "Hello!" },
    { role: "user", text: "Do you clean drains?" },
  ],
  { model: "test-model", maxOutputTokens: 300 }
);

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
  it("sends the history as input, with store off, capped output, a strict schema and no tools", () => {
    expect(REQUEST).toEqual({
      model: "test-model",
      instructions: "RULES",
      input: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "Do you clean drains?" },
      ],
      store: false,
      max_output_tokens: 300,
      text: { format: { type: "json_schema", name: "chat_reply", strict: true, schema: REPLY_SCHEMA } },
    });
  });
});

describe("chatModel and maxOutputTokens", () => {
  it("default to gpt-6-luna and 300", () => {
    expect(chatModel({})).toBe("gpt-6-luna");
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(300);
    expect(maxOutputTokens({})).toBe(300);
  });

  it("take OPENAI_CHAT_MODEL and CHAT_MAX_OUTPUT_TOKENS", () => {
    expect(chatModel({ OPENAI_CHAT_MODEL: "other-model" })).toBe("other-model");
    expect(maxOutputTokens({ CHAT_MAX_OUTPUT_TOKENS: "500" })).toBe(500);
  });

  it("ignore the checklist's OPENAI_MODEL", () => {
    expect(chatModel({ OPENAI_MODEL: "checklist-model" })).toBe("gpt-6-luna");
  });

  it.each(["0", "-5", "abc", "1.5"])("ignore CHAT_MAX_OUTPUT_TOKENS=%j", (value) => {
    expect(maxOutputTokens({ CHAT_MAX_OUTPUT_TOKENS: value })).toBe(300);
  });
});

describe("askOpenAI", () => {
  it("posts the request and returns the trimmed reply and emergency flag", async () => {
    fetchMock.mockResolvedValueOnce(answer({ reply: " Yes, we clean drains. ", emergency: false }));

    expect(await askOpenAI(REQUEST, { apiKey: "sk-test" })).toEqual({ reply: "Yes, we clean drains.", emergency: false });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENAI_RESPONSES_URL);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body)).toEqual(REQUEST);
  });

  it("uses OPENAI_API_KEY from the environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    fetchMock.mockResolvedValueOnce(answer({ reply: "Yes.", emergency: false }));
    await askOpenAI(REQUEST);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-env");
  });

  it("returns null without a key and makes no request", async () => {
    expect(await askOpenAI(REQUEST, { apiKey: null })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[chat] answer skipped: key_not_set");
  });

  it.each([
    ["an HTTP error", () => reply({ error: { message: "nope" } }, 500)],
    ["a refusal", () => reply({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })],
    ["text that isn't JSON", () => reply(message("not json"))],
    ["a reply that isn't a string", () => answer({ reply: 3, emergency: false })],
    ["an empty reply", () => answer({ reply: "  ", emergency: false })],
    ["no emergency flag", () => answer({ reply: "Hi" })],
  ])("returns null on %s", async (_label, make) => {
    fetchMock.mockResolvedValueOnce(make());
    expect(await askOpenAI(REQUEST, { apiKey: "sk-test" })).toBeNull();
  });

  it("returns null on a reply cut short and logs why", async () => {
    fetchMock.mockResolvedValueOnce(reply({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }));
    expect(await askOpenAI(REQUEST, { apiKey: "sk-test" })).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[chat] answer skipped: incomplete_max_output_tokens");
  });

  it("returns null on a timeout and logs only the code", async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(err);
    expect(await askOpenAI(REQUEST, { apiKey: "sk-test" })).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[chat] answer skipped: timeout");
  });

  it("shortens a long reply so it fits in the next request", async () => {
    fetchMock.mockResolvedValueOnce(answer({ reply: "word ".repeat(400).trim(), emergency: false }));
    const result = await askOpenAI(REQUEST, { apiKey: "sk-test" });
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
