import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { claimMock, postSlackMock } = vi.hoisted(() => ({
  claimMock: vi.fn(),
  postSlackMock: vi.fn(),
}));
vi.mock("@/lib/notifications/dedupe", () => ({ claim: claimMock }));
vi.mock("@/lib/slack/client", () => ({ postSlack: postSlackMock }));
// The default store would build a real client; every test passes its own.
vi.mock("@/lib/supabase/client", () => ({
  getSupabaseServerClient: () => {
    throw new Error("tests must not reach Supabase");
  },
}));

import {
  renderDeclined,
  runDeclinedReportPass,
  hashPhone,
  DISABLED_TEXT,
  USAGE_TEXT,
  type DeclinedStore,
  type StoredRow,
} from "../declined";
import { parseDeclined } from "../parse";

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
        .map(({ created_at, reason, phone_hash }) => ({ created_at, reason, phone_hash }))
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

const SALT = "test-salt";
// Thursday 5 Nov 2026, 10:00 EST.
const THURSDAY = new Date("2026-11-05T15:00:00Z");
const log = (text: string, user = "U_ELLA") => parseDeclined(text, user);

describe("renderDeclined", () => {
  beforeEach(() => {
    process.env.SLACK_DECLINED_ENABLED = "true";
    process.env.DECLINED_PHONE_SALT = SALT;
  });
  afterEach(() => {
    delete process.env.SLACK_DECLINED_ENABLED;
    delete process.env.DECLINED_PHONE_SALT;
  });

  describe("disabled switch", () => {
    it.each([undefined, "", "1", "TRUE", "yes"])("does nothing when SLACK_DECLINED_ENABLED=%j", async (value) => {
      if (value === undefined) delete process.env.SLACK_DECLINED_ENABLED;
      else process.env.SLACK_DECLINED_ENABLED = value;
      const { store } = memoryStore();

      expect(await renderDeclined(log("busy"), THURSDAY, store)).toBe(DISABLED_TEXT);
      expect(store.insert).not.toHaveBeenCalled();
      expect(store.listSince).not.toHaveBeenCalled();
    });
  });

  it("prints usage for a bare `declined`", async () => {
    expect(await renderDeclined(log(""), THURSDAY, memoryStore().store)).toBe(USAGE_TEXT);
  });

  it("logs a call and replies with the week's running total", async () => {
    const { store, rows } = memoryStore();
    await renderDeclined(log("distance"), THURSDAY, store);
    const text = await renderDeclined(log("busy 518-555-0100 wanted Tuesday"), THURSDAY, store);

    expect(text).toContain("Logged: turned down, too busy.");
    expect(text).toContain("Note: wanted Tuesday");
    expect(text).toContain("This week so far: *2* (busy 1, distance 1).");
    expect(rows[1]).toMatchObject({
      reason: "busy",
      slack_user_id: "U_ELLA",
      note: "wanted Tuesday",
      created_at: THURSDAY.toISOString(),
      phone_hash: hashPhone("5185550100", SALT),
    });
  });

  it("never stores the raw phone number anywhere in the row", async () => {
    const { store, rows } = memoryStore();
    await renderDeclined(log("busy 518-555-0100 call back 518 555 0100"), THURSDAY, store);
    expect(JSON.stringify(rows)).not.toMatch(/5185550100|555.0100/);
  });

  it("counts a repeat caller in the same week once, and says so", async () => {
    const { store, rows } = memoryStore();
    await renderDeclined(log("busy 518-555-0100"), new Date("2026-11-03T15:00:00Z"), store);
    const text = await renderDeclined(log("busy (518) 555-0100 called again"), THURSDAY, store);

    expect(text).toContain("already logged this week");
    expect(text).toContain("This week so far: *1* (busy 1, distance 0).");
    expect(rows).toHaveLength(2); // kept, just not counted twice
  });

  it("counts the same number again in a new week", async () => {
    const { store } = memoryStore();
    await renderDeclined(log("busy 5185550100"), new Date("2026-10-29T15:00:00Z"), store);
    const text = await renderDeclined(log("busy 5185550100"), THURSDAY, store);
    expect(text).not.toContain("already logged");
    expect(text).toContain("This week so far: *1*");
  });

  it("refuses a phone number when no salt is configured, rather than storing a weak hash", async () => {
    delete process.env.DECLINED_PHONE_SALT;
    const { store } = memoryStore();
    const text = await renderDeclined(log("busy 518-555-0100"), THURSDAY, store);
    expect(text).toContain("DECLINED_PHONE_SALT");
    expect(store.insert).not.toHaveBeenCalled();
  });

  it("still logs a call with no phone when no salt is configured", async () => {
    delete process.env.DECLINED_PHONE_SALT;
    const { store } = memoryStore();
    expect(await renderDeclined(log("busy"), THURSDAY, store)).toContain("Logged");
  });

  describe("undo", () => {
    it("removes only that user's most recent entry", async () => {
      const { store, rows } = memoryStore();
      await renderDeclined(log("busy first", "U_ELLA"), new Date("2026-11-04T15:00:00Z"), store);
      await renderDeclined(log("distance second", "U_ELLA"), new Date("2026-11-05T14:00:00Z"), store);
      await renderDeclined(log("busy someone else", "U_DAVE"), THURSDAY, store);

      const text = await renderDeclined(parseDeclined("undo", "U_ELLA"), THURSDAY, store);

      expect(text).toContain("Removed your last entry: too far (distance)");
      expect(text).toContain("This week so far: *2* (busy 2, distance 0).");
      expect(rows.map((r) => r.note)).toEqual(["first", "someone else"]);
    });

    it("says so when there is nothing to undo", async () => {
      const { store } = memoryStore();
      expect(await renderDeclined(parseDeclined("undo", "U_ELLA"), THURSDAY, store)).toContain("nothing to undo");
    });
  });

  it("`week` shows this week so far and last week", async () => {
    const { store } = memoryStore();
    await renderDeclined(log("busy"), new Date("2026-10-28T15:00:00Z"), store);
    await renderDeclined(log("distance"), THURSDAY, store);

    const text = await renderDeclined(parseDeclined("week", "U_ELLA"), THURSDAY, store);
    expect(text).toContain("This week so far (Mon Nov 2 – Sun Nov 8): *1* (busy 0, distance 1)");
    expect(text).toContain("Last week (Mon Oct 26 – Sun Nov 1): *1* (busy 1, distance 0). Under 15");
  });
});

describe("runDeclinedReportPass", () => {
  const supabase = {} as SupabaseClient;
  const MONDAY_7AM = new Date("2026-11-09T12:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SLACK_DECLINED_ENABLED = "true";
    process.env.SLACK_WEBHOOK_SCHEDULE = "https://hooks.slack.test/schedule";
    claimMock.mockResolvedValue(true);
    postSlackMock.mockResolvedValue(true);
  });
  afterEach(() => {
    delete process.env.SLACK_DECLINED_ENABLED;
    delete process.env.SLACK_WEBHOOK_SCHEDULE;
  });

  it("posts last week's report to the schedule webhook on Monday morning, claimed by that week", async () => {
    const { store } = memoryStore();
    expect(await runDeclinedReportPass(supabase, MONDAY_7AM, store)).toBe(true);
    expect(claimMock).toHaveBeenCalledWith(supabase, "declined_weekly", "2026-11-02");
    expect(postSlackMock).toHaveBeenCalledWith("https://hooks.slack.test/schedule", expect.stringContaining("Turned-down calls"));
  });

  it("does not post twice once the week is claimed", async () => {
    claimMock.mockResolvedValue(false);
    expect(await runDeclinedReportPass(supabase, MONDAY_7AM, memoryStore().store)).toBe(false);
    expect(postSlackMock).not.toHaveBeenCalled();
  });

  it("does nothing outside Monday morning", async () => {
    const { store } = memoryStore();
    expect(await runDeclinedReportPass(supabase, new Date("2026-11-10T12:00:00Z"), store)).toBe(false);
    expect(await runDeclinedReportPass(supabase, new Date("2026-11-09T18:00:00Z"), store)).toBe(false); // 1pm
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("does nothing when the switch is off", async () => {
    delete process.env.SLACK_DECLINED_ENABLED;
    const { store } = memoryStore();
    expect(await runDeclinedReportPass(supabase, MONDAY_7AM, store)).toBe(false);
    expect(store.listSince).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
    expect(postSlackMock).not.toHaveBeenCalled();
  });

  it("does not use up the week's claim when the read fails", async () => {
    const { store } = memoryStore();
    vi.mocked(store.listSince).mockRejectedValueOnce(new Error("db down"));
    await expect(runDeclinedReportPass(supabase, MONDAY_7AM, store)).rejects.toThrow("db down");
    expect(claimMock).not.toHaveBeenCalled();
  });
});
