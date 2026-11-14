import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { claimMock, postMessageMock, listTasksMock } = vi.hoisted(() => ({
  claimMock: vi.fn(),
  postMessageMock: vi.fn(async () => {}),
  listTasksMock: vi.fn(),
}));
vi.mock("@/lib/notifications/dedupe", () => ({ claim: claimMock }));
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseServerClient: () => {
    throw new Error("tests must not reach Supabase");
  },
}));
vi.mock("@/lib/slack/web", () => ({ postMessage: postMessageMock }));
vi.mock("../client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client")>()),
  listTasks: listTasksMock,
}));

import {
  runFieldyDailyPass,
  renderFieldy,
  parseFieldy,
  fieldyTaskSource,
  describeFieldyError,
  DISABLED_TEXT,
  USAGE_TEXT,
  type TaskSource,
} from "../fieldy";
import { FieldyApiError, type FieldyTask } from "../client";
import { FOOTNOTE } from "../report";

const supabase = {} as SupabaseClient;
// Saturday 14 Nov 2026, 08:00 EST.
const SAT_8AM = new Date("2026-11-14T13:00:00Z");

const TASKS: FieldyTask[] = [
  { id: "a", title: "Call back about the boiler", status: "new", date: "2026-11-11T15:00:00Z", completionDate: null },
  { id: "b", title: "Return Ferguson parts", status: "completed", date: null, completionDate: "2026-11-13T19:00:00Z" },
];

function source(tasks: FieldyTask[] = TASKS): TaskSource {
  return { tasks: vi.fn(async () => tasks) };
}

function setEnv() {
  process.env.SLACK_FIELDY_ENABLED = "true";
  process.env.FIELDY_API_KEY = "sk-fieldy-test-not-real";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-not-real";
  process.env.SLACK_FIELDY_CHANNEL_ID = "C_FIELDY";
}
function clearEnv() {
  for (const k of ["SLACK_FIELDY_ENABLED", "FIELDY_API_KEY", "SLACK_BOT_TOKEN", "SLACK_FIELDY_CHANNEL_ID"]) delete process.env[k];
}

describe("runFieldyDailyPass", () => {
  function deps(tasks?: FieldyTask[]) {
    const post = vi.fn<(text: string) => Promise<void>>(async () => {});
    return { source: source(tasks), post };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    claimMock.mockResolvedValue(true);
  });
  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  it("posts the morning list once, claimed by the Eastern date", async () => {
    const d = deps();
    expect(await runFieldyDailyPass(supabase, SAT_8AM, d)).toBe(true);

    expect(claimMock).toHaveBeenCalledWith(supabase, "fieldy_daily", "2026-11-14");
    expect(d.post).toHaveBeenCalledTimes(1);
    expect(d.post.mock.calls[0][0]).toBe(
      [
        "*Dave's Fieldy tasks, Sat Nov 14*",
        "*Pending: 1*, oldest first",
        "• Call back about the boiler (3 days)",
        "*Completed yesterday (Fri Nov 13): 1*",
        "• Return Ferguson parts",
        FOOTNOTE,
      ].join("\n")
    );
  });

  it("posts the one-line version on an empty day", async () => {
    const d = deps([]);
    expect(await runFieldyDailyPass(supabase, SAT_8AM, d)).toBe(true);
    expect(d.post.mock.calls[0][0]).toContain("No open tasks, and nothing marked done yesterday (Fri Nov 13).");
  });

  it("does not post twice once the day is claimed", async () => {
    claimMock.mockResolvedValue(false);
    const d = deps();
    expect(await runFieldyDailyPass(supabase, SAT_8AM, d)).toBe(false);
    expect(d.post).not.toHaveBeenCalled();
  });

  it("on a Fieldy error, neither claims nor posts, so the next run retries", async () => {
    const d = deps();
    vi.mocked(d.source.tasks).mockRejectedValueOnce(new FieldyApiError("http_503"));
    await expect(runFieldyDailyPass(supabase, SAT_8AM, d)).rejects.toThrow("[fieldy] GET /tasks failed: http_503");
    expect(claimMock).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
  });

  it.each(["FIELDY_API_KEY", "SLACK_FIELDY_CHANNEL_ID", "SLACK_BOT_TOKEN"])(
    "skips with a warning, without calling Fieldy or claiming, when %s is unset",
    async (name) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      delete process.env[name];
      const d = deps();

      expect(await runFieldyDailyPass(supabase, SAT_8AM, d)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${name} is not set`));
      expect(d.source.tasks).not.toHaveBeenCalled();
      expect(claimMock).not.toHaveBeenCalled();
      expect(d.post).not.toHaveBeenCalled();
    }
  );

  it("skips when SLACK_BOT_TOKEN is not a bot token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SLACK_BOT_TOKEN = "xoxp-user-token";
    const d = deps();
    expect(await runFieldyDailyPass(supabase, SAT_8AM, d)).toBe(false);
    expect(warn.mock.calls[0][0]).not.toContain("xoxp-user-token");
    expect(d.source.tasks).not.toHaveBeenCalled();
  });

  it("does nothing outside 7 to 11am Eastern", async () => {
    const d = deps();
    expect(await runFieldyDailyPass(supabase, new Date("2026-11-14T11:30:00Z"), d)).toBe(false); // 06:30
    expect(await runFieldyDailyPass(supabase, new Date("2026-11-14T16:00:00Z"), d)).toBe(false); // 11:00
    expect(d.source.tasks).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "1", "TRUE", "yes"])("does nothing, silently, when SLACK_FIELDY_ENABLED=%j", async (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (value === undefined) delete process.env.SLACK_FIELDY_ENABLED;
    else process.env.SLACK_FIELDY_ENABLED = value;
    const d = deps();

    expect(await runFieldyDailyPass(supabase, SAT_8AM, d)).toBe(false);
    expect(d.source.tasks).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("posts with the bot token to SLACK_FIELDY_CHANNEL_ID by default", async () => {
    listTasksMock.mockResolvedValue([]);
    expect(await runFieldyDailyPass(supabase, SAT_8AM)).toBe(true);
    expect(postMessageMock).toHaveBeenCalledWith("xoxb-test-not-real", "C_FIELDY", expect.stringContaining("Dave's Fieldy tasks"));
  });
});

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

describe("renderFieldy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
  });
  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  it("previews today's post, marked as a preview, without claiming or posting", async () => {
    const s = source();
    const text = await renderFieldy({ kind: "fieldyPreview" }, SAT_8AM, s);
    expect(text.split("\n")[0]).toBe("*Preview: Dave's Fieldy tasks, Sat Nov 14*");
    expect(text).toContain("• Call back about the boiler (3 days)");
    expect(claimMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("works before the channel is set up, since it posts nothing", async () => {
    delete process.env.SLACK_FIELDY_CHANNEL_ID;
    delete process.env.SLACK_BOT_TOKEN;
    expect(await renderFieldy({ kind: "fieldyPreview" }, SAT_8AM, source())).toContain("Preview:");
  });

  it("prints usage", async () => {
    expect(await renderFieldy({ kind: "fieldyUsage" }, SAT_8AM, source())).toBe(USAGE_TEXT);
  });

  it("says it's off when the switch is off, and reads nothing", async () => {
    delete process.env.SLACK_FIELDY_ENABLED;
    const s = source();
    expect(await renderFieldy({ kind: "fieldyPreview" }, SAT_8AM, s)).toBe(DISABLED_TEXT);
    expect(s.tasks).not.toHaveBeenCalled();
  });

  it("explains a Fieldy failure by status, never the key", async () => {
    const s = source();
    vi.mocked(s.tasks).mockRejectedValueOnce(new FieldyApiError("http_401"));
    const text = await renderFieldy({ kind: "fieldyPreview" }, SAT_8AM, s);
    expect(text).toContain("http_401");
    expect(text).toContain("FIELDY_API_KEY");
    expect(text).not.toContain("sk-fieldy-test-not-real");
  });

  it("names the missing key without calling Fieldy (the real client checks first)", async () => {
    delete process.env.FIELDY_API_KEY;
    listTasksMock.mockRejectedValue(new FieldyApiError("key_not_set"));
    const text = await renderFieldy({ kind: "fieldyPreview" }, SAT_8AM, fieldyTaskSource());
    expect(text).toContain("FIELDY_API_KEY isn't set");
  });

  it("lets other errors through to the command's generic failure reply", async () => {
    const s = source();
    vi.mocked(s.tasks).mockRejectedValueOnce(new Error("boom"));
    await expect(renderFieldy({ kind: "fieldyPreview" }, SAT_8AM, s)).rejects.toThrow("boom");
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
});
