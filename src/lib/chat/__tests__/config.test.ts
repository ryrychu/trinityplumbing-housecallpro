import { describe, it, expect } from "vitest";
import { DEFAULT_LIMITS, chatConfig, chatEnabled, chatLimits, parseChatSites } from "../config";

const SITES = "trinity=https://trinity.plumbing|https://www.trinity.plumbing";

describe("chatEnabled", () => {
  it("is on only for exactly true", () => {
    expect(chatEnabled({ CHAT_ENABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "TRUE", "1", "yes"]) {
      expect(chatEnabled({ CHAT_ENABLED: value })).toBe(false);
    }
  });
});

describe("parseChatSites", () => {
  it("reads key=origin pairs; the first origin serves the knowledge file", () => {
    expect(parseChatSites(`${SITES},second=https://second.example`)).toEqual({
      ok: true,
      sites: [
        {
          key: "trinity",
          origins: ["https://trinity.plumbing", "https://www.trinity.plumbing"],
          knowledgeUrl: "https://trinity.plumbing/chat-knowledge.json",
        },
        { key: "second", origins: ["https://second.example"], knowledgeUrl: "https://second.example/chat-knowledge.json" },
      ],
    });
  });

  it("trims spaces and skips empty entries and repeated origins", () => {
    expect(parseChatSites(" trinity = https://trinity.plumbing | https://trinity.plumbing , ")).toEqual({
      ok: true,
      sites: [{ key: "trinity", origins: ["https://trinity.plumbing"], knowledgeUrl: "https://trinity.plumbing/chat-knowledge.json" }],
    });
  });

  it("allows http only for localhost", () => {
    expect(parseChatSites("dev=http://localhost:3000").ok).toBe(true);
    expect(parseChatSites("dev=http://127.0.0.1:3000").ok).toBe(true);
    expect(parseChatSites("dev=http://trinity.plumbing").ok).toBe(false);
  });

  it.each([
    "trinity",
    "=https://trinity.plumbing",
    "Trinity=https://trinity.plumbing",
    "trinity=",
    "trinity=https://trinity.plumbing/",
    "trinity=https://trinity.plumbing/chat",
    "trinity=https://*.trinity.plumbing",
    "trinity=trinity.plumbing",
  ])("refuses %j and names the bad entry", (raw) => {
    const r = parseChatSites(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`"${raw}"`);
  });

  it("refuses the same key twice", () => {
    const r = parseChatSites("trinity=https://a.example,trinity=https://b.example");
    expect(!r.ok && r.error).toMatch(/twice/);
  });

  it("refuses an empty value", () => {
    expect(parseChatSites(" , ").ok).toBe(false);
    expect(parseChatSites(undefined).ok).toBe(false);
  });
});

describe("chatLimits", () => {
  it("defaults to 20 per IP per 10 minutes and 500 per site per day", () => {
    expect(DEFAULT_LIMITS).toEqual({ ipMax: 20, ipWindowMs: 600_000, siteDailyMax: 500 });
    expect(chatLimits({})).toEqual({ ok: true, limits: DEFAULT_LIMITS });
  });

  it("reads each limit from its variable", () => {
    expect(chatLimits({ CHAT_IP_LIMIT: "5", CHAT_IP_WINDOW_MINUTES: "1", CHAT_SITE_DAILY_LIMIT: "50" })).toEqual({
      ok: true,
      limits: { ipMax: 5, ipWindowMs: 60_000, siteDailyMax: 50 },
    });
  });

  it.each(["0", "-1", "1.5", "abc"])("refuses %j and names the variable", (value) => {
    const r = chatLimits({ CHAT_SITE_DAILY_LIMIT: value });
    expect(r).toEqual({ ok: false, error: "CHAT_SITE_DAILY_LIMIT should be a whole number above 0" });
  });
});

describe("chatConfig", () => {
  const env = { CHAT_SITES: SITES, CHAT_IP_SALT: "salt" };

  it("is ready with sites, limits and the salt", () => {
    const c = chatConfig(env);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.sites.map((s) => s.key)).toEqual(["trinity"]);
      expect(c.limits).toEqual(DEFAULT_LIMITS);
      expect(c.ipSalt).toBe("salt");
    }
  });

  it("names the missing variable, by name only", () => {
    expect(chatConfig({ CHAT_IP_SALT: "salt" })).toEqual({ ok: false, missing: "CHAT_SITES is not set" });
    expect(chatConfig({ CHAT_SITES: SITES })).toEqual({ ok: false, missing: "CHAT_IP_SALT is not set" });
  });

  it("passes through a parse problem", () => {
    const c = chatConfig({ ...env, CHAT_SITES: "trinity" });
    expect(!c.ok && c.missing).toContain('"trinity"');
    expect(chatConfig({ ...env, CHAT_IP_LIMIT: "x" })).toEqual({
      ok: false,
      missing: "CHAT_IP_LIMIT should be a whole number above 0",
    });
  });
});
