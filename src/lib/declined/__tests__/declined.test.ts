import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { claimMock, postMessageMock } = vi.hoisted(() => ({
  claimMock: vi.fn(),
  postMessageMock: vi.fn(() => {
    throw new Error("tests must not reach Slack");
  }),
}));
vi.mock("@/lib/notifications/dedupe", () => ({ claim: claimMock }));
// Defaults would build a real client or call Slack; every test passes its own.
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseServerClient: () => {
    throw new Error("tests must not reach Supabase");
  },
}));
vi.mock("@/lib/slack/web", async (importOriginal) => ({
  SlackApiError: (await importOriginal<typeof import("@/lib/slack/web")>()).SlackApiError,
  fetchChannelHistory: () => {
    throw new Error("tests must not reach Slack");
  },
  postMessage: postMessageMock,
}));

import {
  renderDeclined,
  runDeclinedReportPass,
  hashPhone,
  DISABLED_TEXT,
  USAGE_TEXT,
  describeChannelError,
  type ChannelSource,
  type DeclinedStore,
  type StoredRow,
} from "../declined";
import { parseDeclined } from "../parse";
import { channelRows } from "../channel";
import type { DeclinedRow } from "../tally";
import { SlackApiError, type SlackMessage } from "@/lib/slack/web";
import { forwarded, plain } from "./fixtures";

const SALT = "test-salt";

function memoryStore(initial: StoredRow[] = []) {
  const rows: StoredRow[] = [...initial];
  let nextId = rows.length + 1;
  const store: DeclinedStore = {
    insert: vi.fn(async (row) => {
      rows.push({ ...row, id: nextId++ });
    }),
    listSince: vi.fn(async (from, to) =>
      rows
        .filter((r) => r.created_at >= from && r.created_at < to)
        .map(({ created_at, reason, phone_hash, note }) => ({ created_at, reason, phone_hash, note }))
    ),
    deleteLatestBy: vi.fn(async (userId) => {
      const mine = rows
        .filter((r) => r.slack_user_id === userId)
        .sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : b.created_at.localeCompare(a.created_at)));
      const latest = mine[0];
      if (!latest) return null;
      rows.splice(rows.indexOf(latest), 1);
      return latest;
    }),
  };
  return { store, rows };
}

/** A channel built from synthetic Slack messages, run through the real classifier. */
function channelOf(messages: SlackMessage[]): ChannelSource {
  return {
    rowsBetween: vi.fn(async (from: string, to: string): Promise<DeclinedRow[]> =>
      channelRows(messages, SALT).filter((r) => r.created_at >= from && r.created_at < to)
    ),
  };
}

const brokenChannel = (err: unknown = new SlackApiError("conversations.history", "not_in_channel")): ChannelSource => ({
  rowsBetween: vi.fn(async () => {
    throw err;
  }),
});

function setup(messages: SlackMessage[] = [], initial: StoredRow[] = []) {
  const m = memoryStore(initial);
  return { ...m, deps: { store: m.store, channel: channelOf(messages) } };
}

// Thursday 5 Nov 2026, 10:00 EST.
const THURSDAY = new Date("2026-11-05T15:00:00Z");
const log = (text: string, user = "U_ELLAH") => parseDeclined(text, user);

describe("renderDeclined", () => {
  beforeEach(() => {
    process.env.SLACK_DECLINED_ENABLED = "true";
    process.env.DECLINED_PHONE_SALT = SALT;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.SLACK_DECLINED_ENABLED;
    delete process.env.DECLINED_PHONE_SALT;
    vi.restoreAllMocks();
  });

  describe("disabled switch", () => {
    it.each([undefined, "", "1", "TRUE", "yes"])("does nothing when SLACK_DECLINED_ENABLED=%j", async (value) => {
      if (value === undefined) delete process.env.SLACK_DECLINED_ENABLED;
      else process.env.SLACK_DECLINED_ENABLED = value;
      const d = setup();

      expect(await renderDeclined(log("busy"), THURSDAY, d.deps)).toBe(DISABLED_TEXT);
      expect(d.store.insert).not.toHaveBeenCalled();
      expect(d.store.listSince).not.toHaveBeenCalled();
      expect(d.deps.channel.rowsBetween).not.toHaveBeenCalled();
    });
  });

  it("prints usage for a bare `declined`", async () => {
    expect(await renderDeclined(log(""), THURSDAY, setup().deps)).toBe(USAGE_TEXT);
  });

  it("logs a call and replies with the week's combined running total", async () => {
    const d = setup([forwarded("2026-11-03T15:00:00Z", "Caller A 518-555-0101")]);
    const text = await renderDeclined(log("busy 518-555-0100 wanted Tuesday"), THURSDAY, d.deps);

    expect(text).toContain("Logged: declined, too busy.");
    expect(text).toContain("Note: wanted Tuesday");
    expect(text).toContain("This week so far: 2 calls declined.");
    expect(d.rows[0]).toMatchObject({
      reason: "busy",
      slack_user_id: "U_ELLAH",
      note: "wanted Tuesday",
      created_at: THURSDAY.toISOString(),
      phone_hash: hashPhone("5185550100", SALT),
    });
  });

  it("never stores the raw phone number", async () => {
    const d = setup();
    await renderDeclined(log("busy 518-555-0100 call back 518 555 0100"), THURSDAY, d.deps);
    expect(JSON.stringify(d.rows)).not.toMatch(/5185550100|555.0100/);
  });

  it("counts a call both forwarded and logged with /trinity once, and says so", async () => {
    const d = setup([forwarded("2026-11-03T15:00:00Z", "Pat Example 518-555-0142 no heat")]);
    const text = await renderDeclined(log("distance (518) 555-0142"), THURSDAY, d.deps);

    expect(text).toContain("already counted this week");
    expect(text).toContain("This week so far: 1 call declined.");
  });

  it("refuses a phone number when no salt is configured", async () => {
    delete process.env.DECLINED_PHONE_SALT;
    const d = setup();
    expect(await renderDeclined(log("busy 518-555-0100"), THURSDAY, d.deps)).toContain("DECLINED_PHONE_SALT");
    expect(d.store.insert).not.toHaveBeenCalled();
  });

  it("still logs when the channel can't be read, and says the total is /trinity entries only", async () => {
    const m = memoryStore();
    const text = await renderDeclined(log("busy"), THURSDAY, { store: m.store, channel: brokenChannel() });
    expect(text).toContain("Logged");
    expect(text).toContain("Couldn't read #declined-calls, so this counts /trinity entries only.");
    expect(m.rows).toHaveLength(1);
  });

  describe("undo", () => {
    it("removes only that user's most recent /trinity entry; forwards are untouched", async () => {
      const d = setup([forwarded("2026-11-03T15:00:00Z", "Caller A 518-555-0101")]);
      await renderDeclined(log("busy first", "U_ELLAH"), new Date("2026-11-04T15:00:00Z"), d.deps);
      await renderDeclined(log("distance second", "U_ELLAH"), new Date("2026-11-05T14:00:00Z"), d.deps);
      await renderDeclined(log("busy someone else", "U_DAVE"), THURSDAY, d.deps);

      const text = await renderDeclined(parseDeclined("undo", "U_ELLAH"), THURSDAY, d.deps);

      expect(text).toContain("Removed your last entry: too far (distance)");
      expect(text).toContain("This week so far: 3 calls declined."); // 1 forward + 2 entries
      expect(d.rows.map((r) => r.note)).toEqual(["first", "someone else"]);
    });

    it("says so when there is nothing to undo", async () => {
      expect(await renderDeclined(parseDeclined("undo", "U_ELLAH"), THURSDAY, setup().deps)).toContain("nothing to undo");
    });
  });

  it("`week` shows the same combined numbers as the report", async () => {
    const d = setup(
      [
        forwarded("2026-10-28T15:00:00Z", "Caller A 518-555-0101"),
        forwarded("2026-10-29T15:00:00Z", "Caller B 518-555-0102"),
        plain("2026-11-02T13:00:00Z", "Week of October 26: 2 calls declined"),
        forwarded("2026-11-03T15:00:00Z", "Caller C, no number"),
      ],
      [{ id: 1, created_at: "2026-11-04T15:00:00.000Z", reason: "busy", phone_hash: null, slack_user_id: "U_ELLAH", note: null }]
    );

    const text = await renderDeclined(parseDeclined("week", "U_ELLAH"), THURSDAY, d.deps);
    expect(text).toContain("This week so far (Nov 2–8): 2 calls declined.");
    expect(text).toContain("Includes 1 logged with /trinity declined (busy 1, distance 0).");
    expect(text).toContain("Last week (Oct 26–Nov 1): 2 calls declined. Under 15 for the week (13 short).");
    expect(text).not.toContain("Couldn't read");
  });

  it("`week` falls back to /trinity entries, and says so, when the channel can't be read", async () => {
    const m = memoryStore();
    const text = await renderDeclined(parseDeclined("week", "U_ELLAH"), THURSDAY, { store: m.store, channel: brokenChannel() });
    expect(text).toContain("Couldn't read #declined-calls, so this counts /trinity entries only.");
  });
});

describe("runDeclinedReportPass", () => {
  const supabase = {} as SupabaseClient;
  const MONDAY_7AM = new Date("2026-11-09T12:00:00Z");

  function reportSetup(messages: SlackMessage[] = [], channel?: ChannelSource) {
    const m = memoryStore();
    const post = vi.fn<(text: string) => Promise<void>>(async () => {});
    return { m, post, deps: { store: m.store, channel: channel ?? channelOf(messages), post } };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_DECLINED_ENABLED = "true";
    process.env.DECLINED_PHONE_SALT = SALT;
    process.env.SLACK_BOT_TOKEN = "xoxb-test-not-real";
    process.env.SLACK_DECLINED_CHANNEL_ID = "C_DECLINED";
    claimMock.mockResolvedValue(true);
  });
  afterEach(() => {
    delete process.env.SLACK_DECLINED_ENABLED;
    delete process.env.DECLINED_PHONE_SALT;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_DECLINED_CHANNEL_ID;
    vi.restoreAllMocks();
  });

  it("posts last week's combined report on Monday morning, claimed by that week", async () => {
    const r = reportSetup([
      forwarded("2026-11-03T15:00:00Z", "Caller A 518-555-0101"),
      forwarded("2026-11-04T15:00:00Z", "Caller A again 518-555-0101"),
      forwarded("2026-11-05T15:00:00Z", "Caller B, no number"),
      plain("2026-11-09T11:30:00Z", "Week of November 2: 2 calls declined"),
    ]);

    expect(await runDeclinedReportPass(supabase, MONDAY_7AM, r.deps)).toBe(true);
    expect(claimMock).toHaveBeenCalledWith(supabase, "declined_weekly", "2026-11-02");
    expect(r.post).toHaveBeenCalledTimes(1);
    expect(r.post.mock.calls[0][0]).toBe(
      [
        "*2 calls declined last week (Nov 2–8)*",
        "• (518) 555-0101: Caller A (called twice)",
        "• Caller B, no number",
        "Under 15 for the week (13 short). 4-week average: 0.5 a week. November so far: 2.",
      ].join("\n")
    );
  });

  it("does not post twice once the week is claimed", async () => {
    claimMock.mockResolvedValue(false);
    const r = reportSetup();
    expect(await runDeclinedReportPass(supabase, MONDAY_7AM, r.deps)).toBe(false);
    expect(r.post).not.toHaveBeenCalled();
  });

  it("on a Slack API error, neither claims nor posts, so the next run retries", async () => {
    const r = reportSetup([], brokenChannel());
    await expect(runDeclinedReportPass(supabase, MONDAY_7AM, r.deps)).rejects.toThrow(/not_in_channel/);
    expect(claimMock).not.toHaveBeenCalled();
    expect(r.post).not.toHaveBeenCalled();
  });

  it("on a database error, neither claims nor posts", async () => {
    const r = reportSetup();
    vi.mocked(r.m.store.listSince).mockRejectedValueOnce(new Error("db down"));
    await expect(runDeclinedReportPass(supabase, MONDAY_7AM, r.deps)).rejects.toThrow("db down");
    expect(claimMock).not.toHaveBeenCalled();
    expect(r.post).not.toHaveBeenCalled();
  });

  it("skips without claiming when the bot token or channel id is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.SLACK_BOT_TOKEN;
    const r = reportSetup();
    expect(await runDeclinedReportPass(supabase, MONDAY_7AM, r.deps)).toBe(false);
    expect(claimMock).not.toHaveBeenCalled();
    expect(r.post).not.toHaveBeenCalled();
  });

  it("does nothing outside Monday morning", async () => {
    const r = reportSetup();
    expect(await runDeclinedReportPass(supabase, new Date("2026-11-10T12:00:00Z"), r.deps)).toBe(false);
    expect(await runDeclinedReportPass(supabase, new Date("2026-11-09T18:00:00Z"), r.deps)).toBe(false);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("does nothing when the switch is off", async () => {
    delete process.env.SLACK_DECLINED_ENABLED;
    const r = reportSetup();
    expect(await runDeclinedReportPass(supabase, MONDAY_7AM, r.deps)).toBe(false);
    expect(r.deps.channel.rowsBetween).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
    expect(r.post).not.toHaveBeenCalled();
  });
});

describe("diagnostics in the /trinity declined week reply", () => {
  const THU = new Date("2026-11-05T15:00:00Z");
  beforeEach(() => {
    process.env.SLACK_DECLINED_ENABLED = "true";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.SLACK_DECLINED_ENABLED;
    vi.restoreAllMocks();
  });

  it("shows Slack's error code and a fix, never the token", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-secret-should-not-appear";
    const m = memoryStore();
    const text = await renderDeclined(parseDeclined("week", "U_ELLAH"), THU, {
      store: m.store,
      channel: brokenChannel(new SlackApiError("conversations.history", "not_in_channel")),
    });
    expect(text).toContain("This week so far (Nov 2–8): 0 calls declined.");
    expect(text).toContain("not_in_channel: The bot isn't in #declined-calls.");
    expect(text).not.toContain("xoxb-");
    delete process.env.SLACK_BOT_TOKEN;
  });

  it.each([
    [new SlackApiError("config", "token_not_set"), "token_not_set: SLACK_BOT_TOKEN is not set."],
    [new SlackApiError("config", "token_not_bot"), "token_not_bot: SLACK_BOT_TOKEN is not a bot token."],
    [new SlackApiError("config", "channel_not_set"), "channel_not_set: SLACK_DECLINED_CHANNEL_ID is not set."],
    [new SlackApiError("conversations.history", "not_in_channel"), "not_in_channel: The bot isn't in #declined-calls."],
    [new SlackApiError("conversations.history", "missing_scope", "groups:history"), "missing_scope (needs groups:history): The app is missing a permission."],
    [new SlackApiError("conversations.history", "invalid_auth"), "invalid_auth: Slack doesn't accept SLACK_BOT_TOKEN."],
    [new SlackApiError("conversations.history", "token_revoked"), "token_revoked: SLACK_BOT_TOKEN was revoked."],
    [new SlackApiError("conversations.history", "channel_not_found"), "channel_not_found: Slack can't find that channel."],
    [new SlackApiError("conversations.history", "ratelimited"), "ratelimited: Slack is rate-limiting the read."],
    [new SlackApiError("conversations.history", "http_503"), "http_503: Slack had a server error."],
    [new SlackApiError("conversations.history", "something_new"), "something_new: See the Slack API docs"],
    [new Error("fetch failed"), "Couldn't reach Slack (network or timeout)."],
  ])("explains %s", (err, expected) => {
    expect(describeChannelError(err)).toContain(expected);
  });

  it("drops anything in a code or scope that isn't code-shaped", () => {
    const text = describeChannelError(new SlackApiError("x", "bad <@U1> code", "scope <evil>"));
    expect(text).toMatch(/^unknown_error: /);
    expect(text).not.toContain("<");
  });

  it("reads the env: a missing token, a user token and a missing channel id each name themselves", async () => {
    const { slackChannelSource } = await import("../declined");
    const read = () => slackChannelSource().rowsBetween("2026-11-02T05:00:00Z", "2026-11-09T05:00:00Z");

    delete process.env.SLACK_BOT_TOKEN;
    await expect(read()).rejects.toMatchObject({ code: "token_not_set" });
    process.env.SLACK_BOT_TOKEN = "xoxp-user-token";
    await expect(read()).rejects.toMatchObject({ code: "token_not_bot" });
    process.env.SLACK_BOT_TOKEN = "xoxb-test-not-real";
    delete process.env.SLACK_DECLINED_CHANNEL_ID;
    await expect(read()).rejects.toMatchObject({ code: "channel_not_set" });
    delete process.env.SLACK_BOT_TOKEN;
  });
});

describe("labelCommandRows", () => {
  it("shows /trinity entries as 'Logged with /trinity: <reason>', with the note if any", async () => {
    const { labelCommandRows } = await import("../declined");
    const rows = labelCommandRows([
      { created_at: "2026-11-04T15:00:00.000Z", reason: "busy", phone_hash: null, note: null },
      { created_at: "2026-11-04T16:00:00.000Z", reason: "distance", phone_hash: null, note: "Saratoga contract <ask Dave>" },
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      "Logged with /trinity: busy",
      "Logged with /trinity: distance — Saratoga contract &lt;ask Dave&gt;",
    ]);
    expect(rows[0]).not.toHaveProperty("note");
  });
});

describe("/trinity declined preview", () => {
  // Wednesday 11 Nov 2026, 10:00 EST: this week is Mon 9 – Sun 15 Nov.
  const WED = new Date("2026-11-11T15:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_DECLINED_ENABLED = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-not-real";
    process.env.SLACK_DECLINED_CHANNEL_ID = "C_DECLINED";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.SLACK_DECLINED_ENABLED;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_DECLINED_CHANNEL_ID;
    vi.restoreAllMocks();
  });

  it("parses", () => {
    expect(parseDeclined("preview", "U_ELLAH")).toEqual({ kind: "declinedPreview" });
  });

  it("renders the Monday post for this week so far, Monday to now", async () => {
    const d = setup(
      [
        forwarded("2026-11-06T15:00:00Z", "(518) 555-0110\nLast Week Caller\nold call"), // last week: not listed
        forwarded("2026-11-09T15:00:00Z", "(518) 555-0123\nJane Doe\n12 Example St, Rensselaer, NY 12144\nCx called because sump pump stopped."),
        forwarded("2026-11-10T15:00:00Z", "(518) 555-0123\nJane Doe\ncalled back"),
        forwarded("2026-11-11T14:00:00Z", "(518) 555-0167"),
      ],
      [{ id: 1, created_at: "2026-11-10T16:00:00.000Z", reason: "busy", phone_hash: null, slack_user_id: "U_ELLAH", note: "wanted Tuesday" }]
    );

    const text = await renderDeclined(parseDeclined("preview", "U_ELLAH"), WED, d.deps);

    expect(text).toBe(
      [
        "*Preview: 3 calls declined this week so far (Nov 9–15)*",
        "• Jane Doe, Rensselaer: sump pump stopped (called twice)",
        "• Logged with /trinity: busy — wanted Tuesday",
        "• (518) 555-0167: no details",
        "Under 15 for the week (12 short). 4-week average: 0.3 a week. November so far: 4.",
      ].join("\n")
    );
  });

  it("never claims, posts to the channel, or writes anything", async () => {
    const d = setup([forwarded("2026-11-09T15:00:00Z", "(518) 555-0123")]);
    await renderDeclined(parseDeclined("preview", "U_ELLAH"), WED, d.deps);

    expect(claimMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(d.store.insert).not.toHaveBeenCalled();
    expect(d.store.deleteLatestBy).not.toHaveBeenCalled();
  });

  it("is off with the switch", async () => {
    delete process.env.SLACK_DECLINED_ENABLED;
    const d = setup();
    expect(await renderDeclined(parseDeclined("preview", "U_ELLAH"), WED, d.deps)).toBe(DISABLED_TEXT);
    expect(d.deps.channel.rowsBetween).not.toHaveBeenCalled();
  });

  it("adds the diagnostic line when the channel can't be read", async () => {
    const m = memoryStore();
    const text = await renderDeclined(parseDeclined("preview", "U_ELLAH"), WED, {
      store: m.store,
      channel: brokenChannel(new SlackApiError("conversations.history", "missing_scope", "channels:history")),
    });
    expect(text).toContain("*Preview: 0 calls declined this week so far (Nov 9–15)*");
    expect(text).toContain("Couldn't read #declined-calls, so this counts /trinity entries only.");
    expect(text).toContain("missing_scope (needs channels:history): The app is missing a permission.");
  });
});
