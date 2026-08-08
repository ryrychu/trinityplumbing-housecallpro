import { describe, it, expect } from "vitest";
import { parseCommand, resolveWindow } from "../commands";
import { localParts } from "@/lib/dashboard/week";

describe("parseCommand", () => {
  it.each([
    ["today", "today"],
    ["tomorrow", "tomorrow"],
    ["week", "week"],
    ["this week", "week"],
    ["next week", "nextWeek"],
    ["money", "money"],
  ])("parses %j as %s", (text, kind) => {
    expect(parseCommand(text)).toEqual({ kind });
  });

  it("is case and whitespace insensitive", () => {
    expect(parseCommand("  NEXT   Week ")).toEqual({ kind: "nextWeek" });
  });

  it.each([
    ["sunday", 0],
    ["monday", 1],
    ["tue", 2],
    ["wednesday", 3],
    ["thu", 4],
    ["friday", 5],
    ["sat", 6],
  ])("parses %j as weekday %i", (text, dow) => {
    expect(parseCommand(text)).toEqual({ kind: "weekday", dow });
  });

  it("treats empty input as help, since that is what typing the bare command does", () => {
    expect(parseCommand("")).toEqual({ kind: "help" });
    expect(parseCommand("   ")).toEqual({ kind: "help" });
  });

  it("parses an explicit help request", () => {
    expect(parseCommand("help")).toEqual({ kind: "help" });
  });

  // A slash command is discovered by typing at it. A dead end teaches nothing,
  // so anything unrecognized shows the list rather than an error.
  it("falls back to help for anything unrecognized", () => {
    expect(parseCommand("what's on for thursday")).toEqual({ kind: "help" });
    expect(parseCommand("asdf")).toEqual({ kind: "help" });
  });

  it("treats inherited Object.prototype keys as unrecognized, not as weekdays", () => {
    // WEEKDAYS is an object literal and inherits from Object.prototype. Property
    // names like "constructor", "toString", "valueOf", and "__proto__" resolve to
    // non-undefined values (functions or objects). Without a typeof check, parsing
    // these would return { kind: "weekday", dow: [Function] }, which breaks Date
    // arithmetic downstream and crashes instead of showing help text.
    expect(parseCommand("constructor")).toEqual({ kind: "help" });
    expect(parseCommand("toString")).toEqual({ kind: "help" });
    expect(parseCommand("valueOf")).toEqual({ kind: "help" });
    expect(parseCommand("__proto__")).toEqual({ kind: "help" });
  });
});

// Saturday 2026-08-08, 08:00 Eastern (12:00 UTC, EDT).
const SAT = new Date("2026-08-08T12:00:00Z");

describe("resolveWindow", () => {
  it("returns null for commands with no date window", () => {
    expect(resolveWindow({ kind: "help" }, SAT)).toBeNull();
    expect(resolveWindow({ kind: "money" }, SAT)).toBeNull();
  });

  it("resolves today to a one-day window on the current local date", () => {
    const w = resolveWindow({ kind: "today" }, SAT)!;
    expect(w.days).toBe(1);
    expect(localParts(w.anchor).d).toBe(8);
  });

  it("resolves tomorrow to the next local calendar day", () => {
    const w = resolveWindow({ kind: "tomorrow" }, SAT)!;
    expect(w.days).toBe(1);
    expect(localParts(w.anchor).d).toBe(9);
    expect(w.title).toBe("Tomorrow — Sun Aug 9");
  });

  it("resolves week to the Monday of the current local week", () => {
    const w = resolveWindow({ kind: "week" }, SAT)!;
    expect(w.days).toBe(7);
    expect(localParts(w.anchor).dow).toBe(1);
    expect(localParts(w.anchor).d).toBe(3); // Mon 2026-08-03
    expect(w.title).toBe("Week ahead");
  });

  it("resolves next week to the following Monday", () => {
    const w = resolveWindow({ kind: "nextWeek" }, SAT)!;
    expect(w.days).toBe(7);
    expect(localParts(w.anchor).d).toBe(10); // Mon 2026-08-10
    expect(w.title).toBe("Next week");
  });

  it("resolves a weekday to its next occurrence", () => {
    // Saturday asking for Tuesday -> Tue 2026-08-11.
    const w = resolveWindow({ kind: "weekday", dow: 2 }, SAT)!;
    expect(w.days).toBe(1);
    expect(localParts(w.anchor).d).toBe(11);
    expect(w.title).toBe("Tue Aug 11");
  });

  // Explicit per the spec: asking on a Thursday for "thursday" means today,
  // not a week out.
  it("counts today as the next occurrence of its own weekday", () => {
    const w = resolveWindow({ kind: "weekday", dow: 6 }, SAT)!; // Saturday
    expect(localParts(w.anchor).d).toBe(8);
    expect(w.title).toBe("Sat Aug 8");
  });

  // DST-safety. 2026-11-01 is the fall-back Sunday in America/New_York; a week
  // built by adding fixed 24h multiples drifts off local midnight after it.
  it("returns seven distinct local days across a DST transition", () => {
    const beforeFallBack = new Date("2026-10-28T12:00:00Z"); // Wed 2026-10-28
    const w = resolveWindow({ kind: "nextWeek" }, beforeFallBack)!;
    expect(w.days).toBe(7);
    expect(localParts(w.anchor).dow).toBe(1);
    expect(localParts(w.anchor).d).toBe(2); // Mon 2026-11-02
  });
});
