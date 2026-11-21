import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_OPENAI_MODEL, OPENAI_RESPONSES_URL, groupWithOpenAI, outputText } from "../openai";
import { task } from "./fakes";

const fetchMock = vi.fn();
const OPEN = [task("t1", "Order the Navien", { date: "2026-11-20" }), task("t2", "Call Mrs. Smith")];
const RECORDINGS = [{ id: "c1", title: "Troy walkthrough", summary: "Boiler swap.", startTime: "2026-11-22T15:00:00.000Z" }];

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function message(text: string) {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}

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

describe("groupWithOpenAI", () => {
  it("asks for structured output with the default model and returns the groups", async () => {
    const groups = [{ name: "Troy job", items: [{ taskId: "t1", text: "Order the Navien" }] }];
    fetchMock.mockResolvedValueOnce(reply(message(JSON.stringify({ groups }))));

    expect(await groupWithOpenAI(OPEN, RECORDINGS, { apiKey: "sk-test" })).toEqual(groups);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENAI_RESPONSES_URL);
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: DEFAULT_OPENAI_MODEL, store: false });
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "checklist", strict: true });
    expect(JSON.parse(body.input)).toEqual({
      tasks: [
        { id: "t1", title: "Order the Navien", due: "2026-11-20" },
        { id: "t2", title: "Call Mrs. Smith", due: null },
      ],
      recordings: [{ startTime: "2026-11-22T15:00:00.000Z", title: "Troy walkthrough", summary: "Boiler swap." }],
    });
  });

  it("uses OPENAI_MODEL and OPENAI_API_KEY from the environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env");
    vi.stubEnv("OPENAI_MODEL", "some-other-model");
    fetchMock.mockResolvedValueOnce(reply(message(JSON.stringify({ groups: [] }))));
    await groupWithOpenAI(OPEN, []);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-env");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("some-other-model");
  });

  it("returns null without a key and makes no request", async () => {
    expect(await groupWithOpenAI(OPEN, [], { apiKey: null })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] for no open tasks without asking", async () => {
    expect(await groupWithOpenAI([], [], { apiKey: "sk-test" })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTTP error", () => reply({ error: { message: "nope" } }, 500)],
    ["a refusal", () => reply({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })],
    ["an incomplete response", () => reply({ status: "incomplete", output: [] })],
    ["text that isn't JSON", () => reply(message("not json"))],
    ["JSON in the wrong shape", () => reply(message(JSON.stringify({ groups: [{ name: 3 }] })))],
  ])("returns null on %s", async (_label, make) => {
    fetchMock.mockResolvedValueOnce(make());
    expect(await groupWithOpenAI(OPEN, [], { apiKey: "sk-test" })).toBeNull();
  });

  it("returns null on a timeout and logs only the code", async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(err);
    expect(await groupWithOpenAI(OPEN, [], { apiKey: "sk-test" })).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[tasks] AI grouping skipped: timeout");
  });
});

describe("outputText", () => {
  it("finds the first output_text in a completed message", () => {
    expect(outputText({ status: "completed", output: [{ type: "reasoning" }, ...message("hi").output] })).toBe("hi");
  });
});
