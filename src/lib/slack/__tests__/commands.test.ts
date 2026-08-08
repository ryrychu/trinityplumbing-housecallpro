import { describe, it, expect } from "vitest";
import { parseCommand } from "../commands";

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
