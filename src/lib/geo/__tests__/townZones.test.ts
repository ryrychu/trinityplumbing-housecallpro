import { describe, it, expect } from "vitest";
import { zoneForTown } from "../townZones";

describe("zoneForTown", () => {
  it("resolves a known town case-insensitively", () => {
    expect(zoneForTown("Delmar")).toBe("Albany Zone");
    expect(zoneForTown("delmar")).toBe("Albany Zone");
    expect(zoneForTown("  DELMAR ")).toBe("Albany Zone");
  });

  it("returns null for an unknown town", () => {
    expect(zoneForTown("Nowhereville")).toBeNull();
  });

  it("returns null for missing input", () => {
    expect(zoneForTown(null)).toBeNull();
    expect(zoneForTown(undefined)).toBeNull();
    expect(zoneForTown("")).toBeNull();
  });
});
