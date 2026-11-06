import { describe, it, expect } from "vitest";
import { isDeclinedShare, sharedText, channelRows } from "../channel";
import { hashPhone } from "../phone";
import { tally } from "../tally";
import { forwarded, sharedOldStyle, forwardedBlocksOnly, plain, tsOf, SAMPLE_CALL } from "./fixtures";

const SALT = "test-salt";
const AT = "2026-11-04T15:00:00Z";

describe("isDeclinedShare", () => {
  it("counts a forwarded message", () => {
    expect(isDeclinedShare(forwarded(AT, SAMPLE_CALL))).toBe(true);
  });

  it("counts a forward with a comment", () => {
    expect(isDeclinedShare(forwarded(AT, SAMPLE_CALL, "too far out"))).toBe(true);
  });

  it("counts an old-style shared message", () => {
    expect(isDeclinedShare(sharedOldStyle(AT, SAMPLE_CALL))).toBe(true);
  });

  it("counts a forward of a bot post that only has blocks", () => {
    expect(isDeclinedShare(forwardedBlocksOnly(AT, SAMPLE_CALL))).toBe(true);
  });

  it.each([
    ["Ellah's weekly total line", plain(AT, "Week of November 2: 8 calls declined")],
    ["Dave's reply", plain(AT, "ok, let's talk Friday", "U_DAVE")],
    ["a typed message that mentions a number", plain(AT, "call back 518-555-0142")],
  ])("ignores %s", (_label, msg) => {
    expect(isDeclinedShare(msg)).toBe(false);
  });

  it("ignores join and leave messages", () => {
    expect(isDeclinedShare({ ...plain(AT, "has joined the channel"), subtype: "channel_join" })).toBe(false);
    expect(isDeclinedShare({ ...plain(AT, "has left the channel"), subtype: "channel_leave" })).toBe(false);
  });

  it("ignores bot posts, including this app's own summary, even with a share-like attachment", () => {
    expect(isDeclinedShare({ ...forwarded(AT, SAMPLE_CALL), bot_id: "B_TRINITY" })).toBe(false);
    expect(isDeclinedShare({ ...plain(AT, "*Last week (Nov 2–8): 8 calls declined.*"), subtype: "bot_message", bot_id: "B_TRINITY" })).toBe(false);
  });

  it("ignores thread replies, including one forwarded into a thread or sent to the channel too", () => {
    const parentTs = tsOf("2026-11-04T14:00:00Z");
    expect(isDeclinedShare({ ...forwarded(AT, SAMPLE_CALL), thread_ts: parentTs })).toBe(false);
    expect(isDeclinedShare({ ...forwarded(AT, SAMPLE_CALL), subtype: "thread_broadcast", thread_ts: parentTs })).toBe(false);
  });

  it("still counts a forward that has become a thread parent (Dave replied to it)", () => {
    const msg = forwarded(AT, SAMPLE_CALL);
    expect(isDeclinedShare({ ...msg, thread_ts: msg.ts })).toBe(true);
  });

  it("ignores an ordinary link preview that is not a shared message", () => {
    expect(isDeclinedShare({ ...plain(AT, "https://example.com"), attachments: [{ text: "Example Domain" }] })).toBe(false);
  });
});

describe("sharedText", () => {
  it("reads the original, not the comment", () => {
    const text = sharedText(forwarded(AT, "Original 518-555-0142", "comment 518-555-0199"));
    expect(text).toContain("518-555-0142");
    expect(text).not.toContain("0199");
  });

  it("reads section block text when there is no attachment text", () => {
    expect(sharedText(forwardedBlocksOnly(AT, SAMPLE_CALL))).toContain("518-555-0142");
  });
});

describe("channelRows", () => {
  it("keeps the time, a salted hash and a one-line label for the Monday list", () => {
    const rows = channelRows([forwarded(AT, SAMPLE_CALL)], SALT);
    expect(rows).toEqual([
      {
        created_at: "2026-11-04T15:00:00.000Z",
        reason: null,
        phone_hash: hashPhone("5185550142", SALT),
        label: "(518) 555-0142: Pat Example, 12 Sample St, Testville",
      },
    ]);
  });

  it("counts one forward per message and skips everything else", () => {
    const rows = channelRows(
      [
        forwarded(AT, "Caller A 518-555-0101"),
        plain(AT, "Week of November 2: 8 calls declined"),
        sharedOldStyle(AT, "Caller B 518-555-0102"),
        forwardedBlocksOnly(AT, "Caller C, no number given"),
      ],
      SALT
    );
    expect(rows).toHaveLength(3);
    expect(rows[2].phone_hash).toBeNull();
  });

  it("matches the same number however it was written", () => {
    const rows = channelRows(
      [forwarded(AT, "call (518) 555-0142"), sharedOldStyle("2026-11-05T15:00:00Z", "5185550142 again")],
      SALT
    );
    expect(rows[0].phone_hash).toBe(rows[1].phone_hash);
    expect(tally(rows).total).toBe(1);
  });

  it("without a salt, still counts every forward but cannot match repeats", () => {
    const rows = channelRows([forwarded(AT, SAMPLE_CALL), forwarded(AT, SAMPLE_CALL)], undefined);
    expect(rows.every((r) => r.phone_hash === null)).toBe(true);
    expect(tally(rows).total).toBe(2);
  });

  it("times a forward by when it was shared into the channel (Sunday 11pm vs Monday 12:30am Eastern)", () => {
    const rows = channelRows(
      [forwarded("2026-11-02T04:00:00Z", SAMPLE_CALL), forwarded("2026-11-02T05:30:00Z", SAMPLE_CALL)],
      SALT
    );
    // Sun 1 Nov 11pm EST and Mon 2 Nov 12:30am EST: different weeks, so the
    // same caller counts in each.
    expect(tally(rows).total).toBe(2);
  });
});
