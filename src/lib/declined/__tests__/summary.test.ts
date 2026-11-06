// SYNTHETIC call texts only: made-up names, streets and 518-555-01xx numbers.
import { describe, it, expect } from "vitest";
import { summarizeCall, slackToPlain } from "../summary";
import { channelRows } from "../channel";
import { forwarded, forwardedBlocksOnly, sharedOldStyle } from "./fixtures";

const AT = "2026-11-04T15:00:00Z";

describe("summarizeCall", () => {
  it("reads the usual four-line shape: phone, name, address, note", () => {
    const text = [
      "(518) 555-0123",
      "Jane Doe",
      "12 Example St, Rensselaer, NY 12144",
      "Cx called because sump pump stopped, pit nearly overflowing. Wants someone today.",
    ].join("\n");
    expect(summarizeCall(text)).toBe("Jane Doe, Rensselaer: sump pump stopped, pit nearly overflowing");
  });

  it("strips a leading @mention and the lead-in phrase", () => {
    const text = ["(518) 555-0124", "Pat Sample", "7 Test Rd, Hillsdale, NY 12529", "<@U0TESTUSER> customer is calling about barn plumbing before winter"].join("\n");
    expect(summarizeCall(text)).toBe("Pat Sample, Hillsdale: barn plumbing before winter");
  });

  it("leaves the town out when there is no address, and never invents one", () => {
    expect(summarizeCall(["518-555-0125", "Sam Placeholder", "Water heater leaking in basement"].join("\n"))).toBe(
      "Sam Placeholder: Water heater leaking in basement"
    );
  });

  it("does not take a street line with no town as a town", () => {
    expect(summarizeCall(["518-555-0126", "Lee Example", "45 Nowhere Lane", "No heat upstairs"].join("\n"))).toBe(
      "Lee Example: No heat upstairs"
    );
  });

  it("copes with extra lines and a Phone: label", () => {
    const text = [
      "New call",
      "Phone: 518.555.0127",
      "Chris Testcase",
      "99 Sample Ave, East Greenbush, NY 12061",
      "Gate code 1234",
      "toilet running constantly",
    ].join("\n");
    // "New call" isn't Title Case, so it is note text, not a name.
    expect(summarizeCall(text)).toBe("Chris Testcase, East Greenbush: New call Gate code 1234 toilet running constantly");
  });

  it("falls back to the phone number when no name is found", () => {
    expect(summarizeCall("(518) 555-0128")).toBe("(518) 555-0128: no details");
  });

  it("finds a number inside the note when there is no phone line", () => {
    expect(summarizeCall("Call back at 518-555-0129 about a frozen pipe")).toBe("(518) 555-0129: Call back at about a frozen pipe");
  });

  it("says (no details) when there is nothing to go on", () => {
    expect(summarizeCall("")).toBe("(no details)");
    expect(summarizeCall("<@U0TESTUSER>")).toBe("(no details)");
  });

  it("caps the need at about 80 characters with an ellipsis", () => {
    const long = "the whole downstairs bathroom needs repiping and the customer wants it done before the holidays arrive";
    const out = summarizeCall(["518-555-0130", "Max Sample", long].join("\n"));
    const need = out.split(": ")[1];
    expect(need.length).toBeLessThanOrEqual(80);
    expect(need.endsWith("…")).toBe(true);
  });

  it("escapes characters Slack would treat as markup", () => {
    // Slack sends a typed & < > as entities; they must go back out as entities.
    expect(summarizeCall(["518-555-0131", "Robin Example", "pipe burst &amp; ceiling wet &lt;again&gt;"].join("\n"))).toBe(
      "Robin Example: pipe burst &amp; ceiling wet &lt;again&gt;"
    );
  });

  it("turns Slack links and tel: links into their labels", () => {
    expect(slackToPlain("<tel:5185550132|(518) 555-0132> <#C0CALLS|calls> <https://example.com|site> <!here>")).toBe(
      "(518) 555-0132 #calls site  "
    );
  });
});

describe("the three message shapes produce the same line", () => {
  const original = ["(518) 555-0140", "Jane Doe", "12 Example St, Rensselaer, NY 12144", "Cx called because sump pump stopped."].join("\n");

  it.each([
    ["a forward", forwarded(AT, original)],
    ["a forward with a comment", forwarded(AT, original, "too far, sorry")],
    ["an old-style share", sharedOldStyle(AT, original)],
    ["a forward of a bot post (blocks only)", forwardedBlocksOnly(AT, original)],
  ])("%s", (_label, msg) => {
    expect(channelRows([msg], "salt")[0].label).toBe("Jane Doe, Rensselaer: sump pump stopped");
  });
});
