import { describe, it, expect } from "vitest";
import { applyPercent, buildPreview, describeChange, fieldsDiffer, parseMoney, toHcpFields, MAX_ITEMS } from "../changes";
import { item } from "./fakes";

const TEE = item({ uuid: "m1" });                                       // $2.50 / cost $0.90
const ELBOW = item({ uuid: "m2", name: "PEX elbow", priceCents: 300, costCents: 100 });
const NAVIEN = item({ uuid: "m3", name: "Navien NPE-240A", category: "Navien", categoryUuid: "c-nav", priceCents: 250000, costCents: 180000 });
const DRAIN = item({ uuid: "s1", kind: "service", name: "Drain cleaning", category: "Drains", categoryUuid: undefined, priceCents: 17500, costCents: null });
const BOOK = [TEE, ELBOW, NAVIEN, DRAIN];

describe("parseMoney / applyPercent", () => {
  it("parses dollars into cents", () => {
    expect(parseMoney(145)).toBe(14500);
    expect(parseMoney("145")).toBe(14500);
    expect(parseMoney("$1,145.50")).toBe(114550);
    expect(parseMoney("abc")).toBeNull();
  });
  it("rounds percentage results", () => {
    expect(applyPercent(250000, 8)).toBe(270000);
    expect(applyPercent(1999, 10, "dollar")).toBe(2200);
    expect(applyPercent(1999, 10, "99")).toBe(2199);
  });
});

describe("buildPreview", () => {
  it("plans per-item changes with only the changed fields", () => {
    const p = buildPreview({ items: [{ uuid: "m1", price: "2.75", description: "1/2 inch PEX brass tee, lead-free" }] }, BOOK);
    expect(p.blocks).toEqual([]);
    expect(p.changes).toEqual([{
      uuid: "m1", name: "PEX tee", category: "PEX", categoryUuid: "c-pex",
      before: { priceCents: 250, description: "1/2 inch PEX brass tee fitting" },
      after: { priceCents: 275, description: "1/2 inch PEX brass tee, lead-free" },
    }]);
  });

  it("applies a percentage rule to matching materials only", () => {
    const p = buildPreview({ rule: { match: { category: "navien" }, pricePercent: 8 } }, BOOK);
    expect(p.changes.map((c) => [c.uuid, c.after.priceCents])).toEqual([["m3", 270000]]);
  });

  it("blocks a price below cost unless allowed", () => {
    expect(buildPreview({ items: [{ uuid: "m1", price: 0.5 }] }, BOOK).blocks.map((b) => b.code)).toEqual(["below_cost"]);
    expect(buildPreview({ items: [{ uuid: "m1", price: 0.5 }], allowBelowCost: true }, BOOK).blocks).toEqual([]);
  });

  it("blocks zero prices, unknown ids, services and duplicates", () => {
    const p = buildPreview({ items: [{ uuid: "m1", price: 0 }, { uuid: "nope", price: 1 }, { uuid: "s1", price: 200 }, { uuid: "m2", price: 4 }, { uuid: "m2", price: 5 }] }, BOOK);
    expect(p.blocks.map((b) => b.code).sort()).toEqual(["duplicate_item", "price_not_positive", "service_not_editable", "unknown_item"]);
  });

  it(`blocks more than ${MAX_ITEMS} items`, () => {
    const many = Array.from({ length: 51 }, (_, i) => item({ uuid: `x${i}`, name: `Part ${i}` }));
    const p = buildPreview({ rule: { match: { category: "PEX" }, pricePercent: 1 } }, many);
    expect(p.blocks.map((b) => b.code)).toEqual(["too_many"]);
  });

  it("warns on big changes, short descriptions, duplicate names and no-ops", () => {
    const p = buildPreview({ items: [{ uuid: "m1", price: 5 }, { uuid: "m2", description: "short", name: "PEX tee" }, { uuid: "m3", price: 2500 }] }, BOOK);
    expect(p.warnings.map((w) => w.code).sort()).toEqual(["big_change", "duplicate_name", "no_change", "short_description"]);
    expect(p.changes.map((c) => c.uuid)).toEqual(["m1", "m2"]);
  });
});

describe("helpers", () => {
  it("fieldsDiffer compares only the given keys", () => {
    expect(fieldsDiffer(TEE, { priceCents: 250 })).toBe(false);
    expect(fieldsDiffer(TEE, { priceCents: 275 })).toBe(true);
  });
  it("toHcpFields maps to HCP names", () => {
    expect(toHcpFields({ priceCents: 275, costCents: 90, unit: "each", partNumber: "X", name: "n", description: "d", taxable: false }))
      .toEqual({ price: 275, cost: 90, unit_of_measure: "each", part_number: "X", name: "n", description: "d", taxable: false });
  });
  it("describes a change in plain words", () => {
    expect(describeChange({ priceCents: 250 }, { priceCents: 275, description: "x" })).toBe("price $2.50 → $2.75; description changed");
  });
});
