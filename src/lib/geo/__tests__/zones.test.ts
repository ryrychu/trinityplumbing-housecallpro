import { describe, it, expect } from "vitest";
import { classifyZone } from "../zones";

describe("classifyZone", () => {
  it("classifies a nearby western location as the Albany Zone", () => {
    // Albany, NY
    const result = classifyZone(42.6526, -73.7562);
    expect(result.zone).toBe("Albany Zone");
  });

  it("classifies a far northern location as the North Route", () => {
    // Glens Falls, NY area
    const result = classifyZone(43.3, -73.65);
    expect(result.zone).toBe("North Route");
  });

  it("classifies a far eastern location as the Southern Berkshire Route", () => {
    // Pittsfield, MA
    const result = classifyZone(42.4501, -73.2454);
    expect(result.zone).toBe("Southern Berkshire Route");
  });

  it("classifies a far northeastern location as the Vermont Route", () => {
    // Bennington, VT
    const result = classifyZone(42.8781, -73.1968);
    expect(result.zone).toBe("Vermont Route");
  });

  it("falls back to a generic label for anything unmatched", () => {
    const result = classifyZone(40.0, -74.0);
    expect(result.zone).toBe("Outside Service Area");
  });
});
