import { describe, it, expect } from "vitest";
import { parseDeclined, normalizePhone, NOTE_MAX } from "../parse";
import { parseCommand } from "@/lib/slack/commands";

describe("parseDeclined", () => {
  it("logs a busy call with no phone or note", () => {
    expect(parseDeclined("busy", "U1")).toEqual({
      kind: "declinedLog",
      reason: "busy",
      phone: null,
      note: null,
      userId: "U1",
    });
  });

  it("logs a distance call", () => {
    expect(parseDeclined("distance", "U1")).toMatchObject({ kind: "declinedLog", reason: "distance" });
  });

  it("pulls the phone out and keeps the rest as the note, in its original case", () => {
    expect(parseDeclined("busy 518-555-0100 wanted Tuesday", "U1")).toEqual({
      kind: "declinedLog",
      reason: "busy",
      phone: "5185550100",
      note: "wanted Tuesday",
      userId: "U1",
    });
  });

  it("finds the phone anywhere in the text", () => {
    expect(parseDeclined("distance Saratoga contract (518) 555-0100", "U1")).toMatchObject({
      phone: "5185550100",
      note: "Saratoga contract",
    });
  });

  it.each([
    ["5185550100"],
    ["518.555.0100"],
    ["518 555 0100"],
    ["+1 518-555-0100"],
    ["1-518-555-0100"],
    ["(518)555-0100"],
  ])("normalizes %j to the same 10 digits", (raw) => {
    expect(parseDeclined(`busy ${raw}`, "U1")).toMatchObject({ phone: "5185550100", note: null });
  });

  it("never keeps a phone number in the note, even a second or 7-digit one", () => {
    const cmd = parseDeclined("busy 518-555-0100 or call 518-555-0199 or 555-0123 after 5", "U1");
    expect(cmd).toMatchObject({ phone: "5185550100" });
    if (cmd.kind !== "declinedLog") throw new Error("expected a log");
    expect(cmd.note).toBe("or call or after 5");
    expect(cmd.note).not.toMatch(/\d{4}/);
  });

  it("caps the note length", () => {
    const cmd = parseDeclined(`busy ${"x".repeat(500)}`, "U1");
    if (cmd.kind !== "declinedLog") throw new Error("expected a log");
    expect(cmd.note).toHaveLength(NOTE_MAX);
  });

  it("is case insensitive on the reason", () => {
    expect(parseDeclined("BUSY", "U1")).toMatchObject({ kind: "declinedLog", reason: "busy" });
  });

  it("parses undo and week", () => {
    expect(parseDeclined("undo", "U1")).toEqual({ kind: "declinedUndo", userId: "U1" });
    expect(parseDeclined(" Week ", "U1")).toEqual({ kind: "declinedWeek" });
  });

  it.each([[""], ["   "], ["help"], ["slow"], ["undo please"], ["week 2"]])(
    "shows usage for %j",
    (text) => {
      expect(parseDeclined(text, "U1")).toEqual({ kind: "declinedUsage" });
    }
  );
});

describe("normalizePhone", () => {
  it("rejects numbers that are not 10 digits after dropping a leading 1", () => {
    expect(normalizePhone("555-0100")).toBeNull();
    expect(normalizePhone("25185550100")).toBeNull();
  });
});

describe("parseCommand routes `declined` to the declined parser", () => {
  it("passes the Slack user id through", () => {
    expect(parseCommand("declined busy 518-555-0100 Wanted Tuesday", "U9")).toEqual({
      kind: "declinedLog",
      reason: "busy",
      phone: "5185550100",
      note: "Wanted Tuesday",
      userId: "U9",
    });
  });

  it("treats a bare `declined` as usage, in any case", () => {
    expect(parseCommand("declined", "U9")).toEqual({ kind: "declinedUsage" });
    expect(parseCommand("  DECLINED  ", "U9")).toEqual({ kind: "declinedUsage" });
  });

  it("does not hijack words that merely start with declined", () => {
    expect(parseCommand("declinedbusy", "U9")).toEqual({ kind: "help" });
  });

  it("leaves the existing commands alone", () => {
    expect(parseCommand("week")).toEqual({ kind: "week" });
  });
});
