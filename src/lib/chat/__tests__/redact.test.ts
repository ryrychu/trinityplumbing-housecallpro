import { describe, it, expect } from "vitest";
import { redact } from "../redact";

describe("redact", () => {
  it.each([
    "(518) 348-3032",
    "518-348-3032",
    "518.348.3032",
    "518 348 3032",
    "5183483032",
    "+1 518 348 3032",
    "1-518-348-3032",
    "+15183483032",
  ])("masks the phone number %s", (phone) => {
    expect(redact(`Call me at ${phone} tonight`)).toBe("Call me at [phone] tonight");
  });

  it("masks email addresses", () => {
    expect(redact("I'm jane.doe+pipes@example.co.uk, thanks")).toBe("I'm [email], thanks");
  });

  it("masks several in one message", () => {
    expect(redact("518-555-0100 or 518-555-0199, or bob@example.com")).toBe("[phone] or [phone], or [email]");
  });

  it.each([
    "It was quoted at $1,250.",
    "from $14,250",
    "$3,300–$5,400",
    "A 40–50 gal tank",
    "Order 123456789012",
    "ZIP 12018",
    "Since 2026-11-26",
    "Model NPE-240A2",
  ])("leaves %s alone", (text) => {
    expect(redact(text)).toBe(text);
  });
});
