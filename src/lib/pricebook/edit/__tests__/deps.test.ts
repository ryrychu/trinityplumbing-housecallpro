import { describe, it, expect, vi, afterEach } from "vitest";
import { parseEditors, pricebookEditEnabled, pricebookSlackUsers, serviceConfigMissing } from "../deps";

afterEach(() => vi.unstubAllEnvs());

describe("deps config", () => {
  it("parses editors with optional names", () => {
    expect(Array.from(parseEditors(" u1:Dave , u2:Ella ,u3 ").entries())).toEqual([["u1", "Dave"], ["u2", "Ella"], ["u3", "u3"]]);
    expect(parseEditors(undefined).size).toBe(0);
  });
  it("is off unless exactly 'true'", () => {
    vi.stubEnv("MCP_PRICEBOOK_EDIT_ENABLED", "TRUE");
    expect(pricebookEditEnabled()).toBe(false);
    vi.stubEnv("MCP_PRICEBOOK_EDIT_ENABLED", "true");
    expect(pricebookEditEnabled()).toBe(true);
  });
  it("names the first missing Slack setting and parses allowed users", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-1");
    vi.stubEnv("SLACK_PRICEBOOK_CHANNEL_ID", "");
    expect(serviceConfigMissing()).toBe("SLACK_PRICEBOOK_CHANNEL_ID is not set");
    vi.stubEnv("SLACK_PRICEBOOK_ALLOWED_USERS", "U1, U2");
    expect(pricebookSlackUsers()).toEqual(["U1", "U2"]);
  });
});
