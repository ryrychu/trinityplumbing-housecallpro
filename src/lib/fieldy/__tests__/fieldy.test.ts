import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { listTasksMock } = vi.hoisted(() => ({ listTasksMock: vi.fn() }));
vi.mock("../client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client")>()),
  listTasks: listTasksMock,
}));

import { renderFieldy, parseFieldy, fieldyTaskSource, describeFieldyError, DISABLED_TEXT, USAGE_TEXT } from "../fieldy";
import { FieldyApiError } from "../client";
import type { ChecklistPlan } from "@/lib/tasks/morning";

describe("fieldyTaskSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads new, approved and completed, and nothing else", async () => {
    listTasksMock.mockImplementation(async (status: string) => [
      { id: status, title: status, status, date: null, completionDate: null },
    ]);
    const tasks = await fieldyTaskSource().tasks();
    expect(listTasksMock.mock.calls.map((c) => c[0]).sort()).toEqual(["approved", "completed", "new"]);
    expect(tasks.map((t) => t.id).sort()).toEqual(["approved", "completed", "new"]);
  });

  it("fails as a whole if any status fails, never returning a partial list", async () => {
    listTasksMock.mockImplementation(async (status: string) => {
      if (status === "completed") throw new FieldyApiError("http_500");
      return [];
    });
    await expect(fieldyTaskSource().tasks()).rejects.toThrow("http_500");
  });
});

describe("parseFieldy", () => {
  it.each([
    ["preview", { kind: "fieldyPreview" }],
    ["  PREVIEW ", { kind: "fieldyPreview" }],
    ["", { kind: "fieldyUsage" }],
    ["preview now", { kind: "fieldyUsage" }],
    ["tasks", { kind: "fieldyUsage" }],
  ])("parses %j", (text, cmd) => {
    expect(parseFieldy(text)).toEqual(cmd);
  });
});

describe("describeFieldyError", () => {
  it.each([
    ["http_401", "refused"],
    ["http_403", "refused"],
    ["http_429", "rate"],
    ["http_502", "server error"],
    ["timeout", "Couldn't reach Fieldy"],
    ["network", "Couldn't reach Fieldy"],
    ["bad_response", "unexpected"],
    ["http_418", "https://api.fieldy.ai/docs"],
  ])("explains %s", (code, phrase) => {
    expect(describeFieldyError(new FieldyApiError(code))).toContain(phrase);
  });

  it("says 'update' for a failed write and explains update_failed", () => {
    const text = describeFieldyError(new FieldyApiError("update_failed", "PATCH /tasks/{id}"));
    expect(text).toMatch(/^Couldn't update Fieldy: update_failed\./);
    expect(text).toMatch(/deleted/);
  });
});

describe("renderFieldy", () => {
  const NOW = new Date("2026-11-23T13:00:00.000Z");
  const PLAN: ChecklistPlan = {
    grouping: { groups: [{ name: "Troy job", items: [{ taskId: "t1", text: "Order the Navien" }] }], overflow: 0, movedToOther: [], dropped: [] },
    builtBy: "morning_ai",
    finishedYesterday: 1,
  };

  beforeEach(() => {
    process.env.SLACK_FIELDY_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.SLACK_FIELDY_ENABLED;
  });

  it("is off unless SLACK_FIELDY_ENABLED is exactly 'true'", async () => {
    process.env.SLACK_FIELDY_ENABLED = "TRUE";
    expect(await renderFieldy({ kind: "fieldyPreview" }, NOW, async () => PLAN)).toBe(DISABLED_TEXT);
  });

  it("shows the checklist the morning pass would build", async () => {
    const text = await renderFieldy({ kind: "fieldyPreview" }, NOW, async () => PLAN);
    expect(text).toContain("*Preview: Dave's checklist,");
    expect(text).toContain("• Order the Navien");
    expect(text).toContain("Finished yesterday: 1");
  });

  it("explains a Fieldy failure instead of throwing", async () => {
    const text = await renderFieldy({ kind: "fieldyPreview" }, NOW, async () => {
      throw new FieldyApiError("http_401");
    });
    expect(text).toMatch(/^Couldn't read Fieldy: http_401\./);
  });

  it("shows usage for anything else", async () => {
    expect(await renderFieldy({ kind: "fieldyUsage" }, NOW, async () => PLAN)).toBe(USAGE_TEXT);
  });
});
