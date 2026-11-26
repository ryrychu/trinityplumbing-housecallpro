import { describe, it, expect } from "vitest";
import { chatKnowledgeSchema, parseKnowledge } from "../schema";
import { KNOWLEDGE } from "./fixtures";

describe("parseKnowledge", () => {
  it("accepts a version 1 file and returns it", () => {
    expect(parseKnowledge(KNOWLEDGE)).toEqual(KNOWLEDGE);
  });

  it("accepts a file without the optional financing link and price notes", () => {
    const links = { pricing: KNOWLEDGE.links.pricing, contact: KNOWLEDGE.links.contact };
    const prices = KNOWLEDGE.prices.map((p) => ({ category: p.category, item: p.item, price: p.price }));
    expect(parseKnowledge({ ...KNOWLEDGE, links, prices })).not.toBeNull();
  });

  it("trims text and drops fields it doesn't know", () => {
    const parsed = parseKnowledge({
      ...KNOWLEDGE,
      extra: "ignored",
      business: { ...KNOWLEDGE.business, name: "  Trinity Plumbing & Drains " },
    });
    expect(parsed?.business.name).toBe("Trinity Plumbing & Drains");
    expect(parsed).not.toHaveProperty("extra");
  });

  it.each([
    ["another version", { ...KNOWLEDGE, version: 2 }],
    ["a blank phone", { ...KNOWLEDGE, business: { ...KNOWLEDGE.business, phone: "  " } }],
    ["no service area", { ...KNOWLEDGE, business: { ...KNOWLEDGE.business, serviceArea: [] } }],
    ["no prices", { ...KNOWLEDGE, prices: [] }],
    ["a price as a number", { ...KNOWLEDGE, prices: [{ category: "Drains", item: "Snake", price: 75 }] }],
    ["a bad date", { ...KNOWLEDGE, pricesUpdated: "Nov 4" }],
    ["a contact link that isn't a full URL", { ...KNOWLEDGE, links: { ...KNOWLEDGE.links, contact: "/contact" } }],
    ["a string", "hello"],
    ["null", null],
  ])("refuses %s", (_label, value) => {
    expect(parseKnowledge(value)).toBeNull();
  });

  it("is the schema the parser uses", () => {
    expect(chatKnowledgeSchema.safeParse(KNOWLEDGE).success).toBe(true);
  });
});
