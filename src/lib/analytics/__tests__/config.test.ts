import { describe, it, expect } from "vitest";
import { analyticsConfig, analyticsWeeklyEnabled, parseProperties, parseServiceAccount } from "../config";

// Shaped like a Google key file. Not a real key: the PEM body is filler.
const KEY_JSON = JSON.stringify({
  type: "service_account",
  project_id: "trinity-analytics",
  client_email: "ga-reader@trinity-analytics.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
});

describe("parseProperties", () => {
  it("reads comma-separated Site Name=propertyId pairs in order", () => {
    expect(parseProperties("Trinity Plumbing=123456789,Albany Rooter=987654321")).toEqual({
      ok: true,
      properties: [
        { site: "Trinity Plumbing", propertyId: "123456789" },
        { site: "Albany Rooter", propertyId: "987654321" },
      ],
    });
  });

  it("trims spaces and accepts a properties/ prefix and a trailing comma", () => {
    expect(parseProperties("  Trinity Plumbing = properties/123 ,\n Albany Rooter=456, ")).toEqual({
      ok: true,
      properties: [
        { site: "Trinity Plumbing", propertyId: "123" },
        { site: "Albany Rooter", propertyId: "456" },
      ],
    });
  });

  it.each([
    ["Trinity Plumbing", "Trinity Plumbing"],
    ["=123", "=123"],
    ["Trinity=G-ABC123", "Trinity=G-ABC123"],
    ["Trinity=12a", "Trinity=12a"],
  ])("refuses %j and names the bad entry", (raw, entry) => {
    const r = parseProperties(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`"${entry}"`);
  });

  it("explains that a G- measurement ID is not a property ID", () => {
    const r = parseProperties("Trinity=G-ABC123");
    expect(!r.ok && r.error).toMatch(/Measurement ID/);
  });

  it("refuses the same site name twice", () => {
    const r = parseProperties("Trinity=1,trinity=2");
    expect(!r.ok && r.error).toMatch(/twice/);
  });

  it("refuses an empty value", () => {
    expect(parseProperties(" , ").ok).toBe(false);
    expect(parseProperties(undefined).ok).toBe(false);
  });
});

describe("parseServiceAccount", () => {
  it("reads the raw key JSON", () => {
    expect(parseServiceAccount(KEY_JSON)).toEqual({
      ok: true,
      account: {
        clientEmail: "ga-reader@trinity-analytics.iam.gserviceaccount.com",
        privateKey: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
      },
    });
  });

  it("reads the same JSON base64-encoded", () => {
    const b64 = Buffer.from(KEY_JSON, "utf8").toString("base64");
    expect(parseServiceAccount(b64)).toEqual(parseServiceAccount(KEY_JSON));
  });

  it("reads it with surrounding whitespace", () => {
    expect(parseServiceAccount(`\n  ${KEY_JSON}  \n`).ok).toBe(true);
  });

  // Pasting the key into some env editors turns its newlines into "\n" text.
  it("restores newlines that arrive as literal \\n in the private key", () => {
    const flattened = KEY_JSON.replace(/\\n/g, "\\\\n");
    const r = parseServiceAccount(flattened);
    expect(r.ok && r.account.privateKey).toBe("-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n");
  });

  it.each([
    ["not json and not base64 json", "hello"],
    ["missing client_email", JSON.stringify({ private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----" })],
    ["missing private_key", JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com" })],
    ["an empty value", ""],
  ])("refuses %s without echoing the value", (_label, raw) => {
    const r = parseServiceAccount(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/GA_SERVICE_ACCOUNT_JSON/);
      expect(r.error).not.toContain("PRIVATE KEY");
    }
  });
});

describe("analyticsConfig", () => {
  const env = { GA_SERVICE_ACCOUNT_JSON: KEY_JSON, GA_PROPERTIES: "Trinity Plumbing=123" };

  it("is ready when both variables parse", () => {
    const c = analyticsConfig(env);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.properties).toEqual([{ site: "Trinity Plumbing", propertyId: "123" }]);
      expect(c.account.clientEmail).toMatch(/^ga-reader@/);
    }
  });

  it("names the missing variable first, by name only", () => {
    expect(analyticsConfig({ GA_PROPERTIES: "A=1" })).toEqual({ ok: false, missing: "GA_SERVICE_ACCOUNT_JSON is not set" });
    expect(analyticsConfig({ GA_SERVICE_ACCOUNT_JSON: KEY_JSON })).toEqual({ ok: false, missing: "GA_PROPERTIES is not set" });
  });

  it("passes through a parse problem", () => {
    const c = analyticsConfig({ ...env, GA_PROPERTIES: "Trinity" });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.missing).toMatch(/GA_PROPERTIES/);
  });
});

describe("analyticsWeeklyEnabled", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["TRUE", false],
    ["1", false],
    ["yes", false],
    ["true", true],
  ])("ANALYTICS_WEEKLY_ENABLED=%j is %s", (value, expected) => {
    expect(analyticsWeeklyEnabled({ ANALYTICS_WEEKLY_ENABLED: value })).toBe(expected);
  });
});
