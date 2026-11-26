import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EVAL_QUESTIONS } from "../evalQuestions";
import { askOpenAI, buildChatRequest } from "../openai";
import { ANSWER_RULES, buildInstructions } from "../prompt";
import { KNOWLEDGE } from "./fixtures";

// Each tricky question goes through a mocked model. What's checked is the
// request: the same rules and knowledge every time, the visitor's words only
// in `input`, and nothing that lets the model look things up or keep the chat.
// `npm run chat:eval` is where a person reads the real answers.
const fetchMock = vi.fn();
const INSTRUCTIONS = buildInstructions(KNOWLEDGE);

function modelSays(reply: string, emergency: boolean): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ reply, emergency }) }] }],
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
    const request = buildChatRequest(INSTRUCTIONS, [{ role: "user", text: q.text }], { model: "test-model", maxOutputTokens: 300 });

    const result = await askOpenAI(request, { apiKey: "sk-test" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.instructions).toBe(INSTRUCTIONS);
    expect(body.instructions.startsWith(ANSWER_RULES)).toBe(true);
    expect(body.instructions).not.toContain(q.text);
    expect(body.input).toEqual([{ role: "user", content: q.text }]);
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(300);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "chat_reply", strict: true });
    expect(result).toEqual({ reply: "ok", emergency: q.emergency });
  });
});
