import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EVAL_QUESTIONS } from "../evalQuestions";
import { OPENAI_CHAT_URL, askChatAI, buildChatRequest } from "../openai";
import { ANSWER_RULES, buildInstructions } from "../prompt";
import { KNOWLEDGE } from "./fixtures";

// Each tricky question goes through a mocked model. What's checked is the
// request: the same rules and knowledge every time, the visitor's words only
// after the system message, and nothing that lets the model look things up or keep the chat.
// `npm run chat:eval` is where a person reads the real answers.
const fetchMock = vi.fn();
const INSTRUCTIONS = buildInstructions(KNOWLEDGE);

function modelSays(reply: string, emergency: boolean): Response {
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ reply, emergency }) } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("answer rules", () => {
  it("covers the spec's tricky questions", () => {
    expect(EVAL_QUESTIONS.map((q) => q.id)).toEqual(
      expect.arrayContaining(["unlisted-price", "haggle", "ignore-instructions", "gas-smell", "off-topic", "competitor"])
    );
    expect(EVAL_QUESTIONS.find((q) => q.id === "gas-smell")?.emergency).toBe(true);
  });

  it.each(EVAL_QUESTIONS)("builds the request for $id", async (q) => {
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
  });
});
