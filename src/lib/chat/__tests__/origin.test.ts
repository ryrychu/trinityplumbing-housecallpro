// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseChatSites, type ChatSite } from "../config";
import { corsHeaders, isListedOrigin, preflightResponse, siteFor } from "../origin";

function sites(): ChatSite[] {
  const r = parseChatSites("trinity=https://trinity.plumbing|https://www.trinity.plumbing,second=https://second.example");
  if (!r.ok) throw new Error(r.error);
  return r.sites;
}

describe("siteFor", () => {
  it("matches each of the site's origins exactly", () => {
    expect(siteFor(sites(), "trinity", "https://trinity.plumbing")?.key).toBe("trinity");
    expect(siteFor(sites(), "trinity", "https://www.trinity.plumbing")?.key).toBe("trinity");
  });

  it.each([
    "https://trinity.plumbing.evil.example",
    "https://eviltrinity.plumbing",
    "http://trinity.plumbing",
    "https://trinity.plumbing:8443",
    "https://TRINITY.plumbing",
    "https://trinity.plumbing/",
    "null",
  ])("rejects the lookalike %s", (origin) => {
    expect(siteFor(sites(), "trinity", origin)).toBeNull();
  });

  it("rejects a missing Origin header", () => {
    expect(siteFor(sites(), "trinity", null)).toBeNull();
  });

  it("rejects another listed site's origin, and an unknown or missing site key", () => {
    expect(siteFor(sites(), "trinity", "https://second.example")).toBeNull();
    expect(siteFor(sites(), "nope", "https://trinity.plumbing")).toBeNull();
    expect(siteFor(sites(), undefined, "https://trinity.plumbing")).toBeNull();
  });
});

describe("isListedOrigin", () => {
  it("is true for any listed origin and false otherwise", () => {
    expect(isListedOrigin(sites(), "https://second.example")).toBe(true);
    expect(isListedOrigin(sites(), "https://evil.example")).toBe(false);
    expect(isListedOrigin(sites(), null)).toBe(false);
  });
});

describe("corsHeaders", () => {
  it("echoes the one origin and varies on it", () => {
    expect(corsHeaders("https://trinity.plumbing")).toEqual({
      "Access-Control-Allow-Origin": "https://trinity.plumbing",
      Vary: "Origin",
    });
  });
});

describe("preflightResponse", () => {
  it("answers a listed origin with CORS headers", () => {
    const res = preflightResponse(sites(), "https://www.trinity.plumbing");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.trinity.plumbing");
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("refuses anything else without CORS headers", () => {
    for (const origin of ["https://evil.example", null]) {
      const res = preflightResponse(sites(), origin);
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});
