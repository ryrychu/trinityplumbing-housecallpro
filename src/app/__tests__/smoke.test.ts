import { describe, it, expect } from "vitest";

function appIsAlive() {
  return true;
}

describe("project scaffolding", () => {
  it("test runner is wired up", () => {
    expect(appIsAlive()).toBe(true);
  });
});
