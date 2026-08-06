import { describe, it, expect } from "vitest";
import { normalizePhone, formatPhone } from "../phone";

describe("normalizePhone", () => {
  // All three of these are how a person actually types the same customer.
  it.each(["5185550142", "(518) 555-0142", "518-555-0142", "518.555.0142", "518 555 0142"])(
    "reduces %s to bare digits",
    (input) => expect(normalizePhone(input)).toBe("5185550142")
  );

  // A pasted number from a contact card often carries +1.
  it("strips a US country code", () => {
    expect(normalizePhone("+1 (518) 555-0142")).toBe("5185550142");
    expect(normalizePhone("15185550142")).toBe("5185550142");
  });

  // "518" must stay a usable prefix search, not become nothing.
  it("keeps a partial number as-is", () => {
    expect(normalizePhone("518")).toBe("518");
  });

  it("returns empty for text with no digits", () => {
    expect(normalizePhone("Kowalski")).toBe("");
  });
});

describe("formatPhone", () => {
  it("formats ten digits for display", () => {
    expect(formatPhone("5185550142")).toBe("(518) 555-0142");
  });

  // Never mangle something that isn't a 10-digit US number.
  it("passes anything else through untouched", () => {
    expect(formatPhone("5551234")).toBe("5551234");
    expect(formatPhone(null)).toBeNull();
  });
});
