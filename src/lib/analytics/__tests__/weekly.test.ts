import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { claimMock, isClaimedMock } = vi.hoisted(() => ({
  claimMock: vi.fn(),
  isClaimedMock: vi.fn(),
}));
vi.mock("@/lib/notifications/dedupe", () => ({ claim: claimMock, isClaimed: isClaimedMock }));
// The live defaults would call Google or Slack; every test passes its own.
vi.mock("@/lib/slack/web", () => ({
  postMessage: () => {
    throw new Error("tests must not reach Slack");
  },
}));
vi.mock("../google", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../google")>()),
  getAccessToken: () => {
    throw new Error("tests must not reach Google");
  },
  runReport: () => {
    throw new Error("tests must not reach Google");
  },
}));

import {
  USAGE_TEXT,
  lookupTraffic,
  parseTraffic,
  renderTraffic,
  runAnalyticsWeeklyPass,
  type TrafficSource,
  type WeeklyDeps,
} from "../weekly";
import { GaApiError } from "../google";
import type { TrafficReport } from "../report";
import type { ReportWeeks } from "../week";
import { MONDAY_9AM, sampleReport } from "./fixtures";

const KEY_JSON = JSON.stringify({
  client_email: "ga-reader@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
});

const supabase = {} as SupabaseClient;

function source(report: () => Promise<TrafficReport> = async () => sampleReport()) {
  const fetch = vi.fn<TrafficSource["fetch"]>(async () => report());
  const s: TrafficSource = { fetch };
  return { s, fetch };
}

function setEnv() {
  vi.stubEnv("ANALYTICS_WEEKLY_ENABLED", "true");
  vi.stubEnv("GA_SERVICE_ACCOUNT_JSON", KEY_JSON);
  vi.stubEnv("GA_PROPERTIES", "Trinity Plumbing=100000001,Albany Rooter=100000002,Troy Water Heaters=100000003");
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-not-real");
  vi.stubEnv("SLACK_ANALYTICS_CHANNEL_ID", "C_TRAFFIC");
}

beforeEach(() => {
  vi.clearAllMocks();
  claimMock.mockResolvedValue(true);
  isClaimedMock.mockResolvedValue(false);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runAnalyticsWeeklyPass", () => {
  beforeEach(setEnv);

  function run(now = MONDAY_9AM, s = source()) {
    const post = vi.fn<WeeklyDeps["post"]>(async () => {});
    return { post, s, result: runAnalyticsWeeklyPass(supabase, now, { source: s.s, post }) };
  }

  it("posts last week's report to the channel on Monday morning, claimed by that week", async () => {
    const r = run();
    expect(await r.result).toBe(true);
    expect(r.s.fetch).toHaveBeenCalledTimes(1);
    const [props, weeks] = r.s.fetch.mock.calls[0] as [unknown, ReportWeeks];
    expect(props).toEqual([
      { site: "Trinity Plumbing", propertyId: "100000001" },
      { site: "Albany Rooter", propertyId: "100000002" },
      { site: "Troy Water Heaters", propertyId: "100000003" },
    ]);
    expect(weeks.week.startDate).toBe("2026-11-16");
    expect(isClaimedMock).toHaveBeenCalledWith(supabase, "analytics_weekly", "2026-11-16");
    expect(claimMock).toHaveBeenCalledWith(supabase, "analytics_weekly", "2026-11-16");
    expect(r.post).toHaveBeenCalledTimes(1);
    const message = r.post.mock.calls[0][0];
    expect(message.text).toMatch(/^Website traffic, Nov 16–22/);
    expect(JSON.stringify(message.blocks)).not.toContain("Preview");
  });

  it.each([undefined, "", "TRUE", "1"])(
    "with ANALYTICS_WEEKLY_ENABLED=%j makes no Google call, no claim and no post",
    async (value) => {
      if (value === undefined) vi.stubEnv("ANALYTICS_WEEKLY_ENABLED", undefined as unknown as string);
      else vi.stubEnv("ANALYTICS_WEEKLY_ENABLED", value);
      const r = run();
      expect(await r.result).toBe(false);
      expect(r.s.fetch).not.toHaveBeenCalled();
      expect(isClaimedMock).not.toHaveBeenCalled();
      expect(claimMock).not.toHaveBeenCalled();
      expect(r.post).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["Monday before 9", "2026-11-23T13:45:00Z"],
    ["Monday at noon", "2026-11-23T17:00:00Z"],
    ["Tuesday morning", "2026-11-24T14:00:00Z"],
  ])("does nothing on %s", async (_label, iso) => {
    const r = run(new Date(iso));
    expect(await r.result).toBe(false);
    expect(r.s.fetch).not.toHaveBeenCalled();
    expect(r.post).not.toHaveBeenCalled();
  });

  it("skips the Google calls entirely once the week has been posted", async () => {
    isClaimedMock.mockResolvedValue(true);
    const r = run();
    expect(await r.result).toBe(false);
    expect(r.s.fetch).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
    expect(r.post).not.toHaveBeenCalled();
  });

  it("does not post twice when another run claimed the week first", async () => {
    claimMock.mockResolvedValue(false);
    const r = run();
    expect(await r.result).toBe(false);
    expect(r.post).not.toHaveBeenCalled();
  });

  it.each([
    ["GA_SERVICE_ACCOUNT_JSON", "GA_SERVICE_ACCOUNT_JSON is not set"],
    ["GA_PROPERTIES", "GA_PROPERTIES is not set"],
    ["SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN is not set"],
    ["SLACK_ANALYTICS_CHANNEL_ID", "SLACK_ANALYTICS_CHANNEL_ID is not set"],
  ])("skips with a warning and claims nothing while %s is missing", async (name, warning) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv(name, "");
    const r = run();
    expect(await r.result).toBe(false);
    expect(warn).toHaveBeenCalledWith(`[analytics] weekly post skipped: ${warning}`);
    expect(r.s.fetch).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
    expect(r.post).not.toHaveBeenCalled();
  });

  it("refuses a user token in SLACK_BOT_TOKEN", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxp-user-token");
    expect(await run().result).toBe(false);
  });

  it("when no site loads, throws before claiming so the next run retries", async () => {
    const all = sampleReport();
    const broken: TrafficReport = {
      ...all,
      sites: all.sites.map((s) => ({ site: s.site, propertyId: s.propertyId, status: "unavailable", reason: "http_503" })),
      unavailableCount: 3,
    };
    const r = run(MONDAY_9AM, source(async () => broken));
    await expect(r.result).rejects.toThrow(/no site could be read/);
    expect(claimMock).not.toHaveBeenCalled();
    expect(r.post).not.toHaveBeenCalled();
  });

  it("when Google refuses the token, throws before claiming", async () => {
    const r = run(MONDAY_9AM, source(async () => { throw new GaApiError("token", "invalid_grant"); }));
    await expect(r.result).rejects.toThrow(/invalid_grant/);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("posts with one site unavailable", async () => {
    const r = run();
    expect(await r.result).toBe(true);
    expect(JSON.stringify(r.post.mock.calls[0][0].blocks)).toContain("Troy Water Heaters");
  });
});

describe("renderTraffic (the /trinity traffic preview)", () => {
  beforeEach(setEnv);

  it("shows the post Monday would send, marked as a preview, without claiming or posting", async () => {
    const s = source();
    const reply = await renderTraffic({ kind: "trafficPreview" }, MONDAY_9AM, s.s);
    expect(typeof reply).toBe("object");
    const { text, blocks } = reply as { text: string; blocks: { type: string; elements?: { text: string }[] }[] };
    expect(text).toMatch(/^Website traffic, Nov 16–22/);
    expect(blocks[0].elements![0].text).toMatch(/^Preview, only you can see this/);
    expect(claimMock).not.toHaveBeenCalled();
    expect(isClaimedMock).not.toHaveBeenCalled();
  });

  it("works before the weekly post is switched on, so it can be checked first", async () => {
    vi.stubEnv("ANALYTICS_WEEKLY_ENABLED", "");
    vi.stubEnv("SLACK_ANALYTICS_CHANNEL_ID", "");
    const reply = await renderTraffic({ kind: "trafficPreview" }, MONDAY_9AM, source().s);
    expect(typeof reply).toBe("object");
  });

  it("mid-week previews the same last full week", async () => {
    const s = source();
    await renderTraffic({ kind: "trafficPreview" }, new Date("2026-11-26T17:00:00Z"), s.s);
    expect((s.fetch.mock.calls[0][1] as ReportWeeks).week.startDate).toBe("2026-11-16");
  });

  it("says analytics isn't set up yet, by variable name, without calling Google", async () => {
    vi.stubEnv("GA_PROPERTIES", "");
    const s = source();
    expect(await renderTraffic({ kind: "trafficPreview" }, MONDAY_9AM, s.s)).toBe(
      "Website traffic isn't set up yet: GA_PROPERTIES is not set. See docs/SLACK-ROLLOUT.md (Website traffic)."
    );
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it("explains a Google token failure in one line", async () => {
    const s = source(async () => { throw new GaApiError("token", "invalid_grant"); });
    expect(await renderTraffic({ kind: "trafficPreview" }, MONDAY_9AM, s.s)).toMatch(
      /^Couldn't sign in to Google Analytics: invalid_grant\. /
    );
  });

  it("shows usage for anything else", async () => {
    expect(await renderTraffic({ kind: "trafficUsage" }, MONDAY_9AM, source().s)).toBe(USAGE_TEXT);
  });
});

describe("parseTraffic", () => {
  it.each([
    ["preview", { kind: "trafficPreview" }],
    [" PREVIEW ", { kind: "trafficPreview" }],
    ["", { kind: "trafficUsage" }],
    ["week", { kind: "trafficUsage" }],
  ])("parses %j", (rest, cmd) => {
    expect(parseTraffic(rest)).toEqual(cmd);
  });
});

describe("lookupTraffic (for ChatGPT)", () => {
  beforeEach(setEnv);

  it("says analytics isn't set up when the GA variables are missing", async () => {
    vi.stubEnv("GA_SERVICE_ACCOUNT_JSON", "");
    const s = source();
    expect(await lookupTraffic(MONDAY_9AM, { weeksAgo: 0 }, s.s)).toEqual({
      status: "not_configured",
      missing: "GA_SERVICE_ACCOUNT_JSON is not set",
    });
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it("doesn't need the weekly post's switch or channel", async () => {
    vi.stubEnv("ANALYTICS_WEEKLY_ENABLED", "");
    vi.stubEnv("SLACK_ANALYTICS_CHANNEL_ID", "");
    expect((await lookupTraffic(MONDAY_9AM, { weeksAgo: 0 }, source().s)).status).toBe("ok");
  });

  it("goes back weeksAgo weeks", async () => {
    const s = source();
    await lookupTraffic(MONDAY_9AM, { weeksAgo: 2 }, s.s);
    expect((s.fetch.mock.calls[0][1] as ReportWeeks).week.startDate).toBe("2026-11-02");
  });

  it("fetches only the sites whose name contains the filter, ignoring case", async () => {
    const s = source();
    await lookupTraffic(MONDAY_9AM, { weeksAgo: 0, site: "  rooter " }, s.s);
    expect(s.fetch.mock.calls[0][0]).toEqual([{ site: "Albany Rooter", propertyId: "100000002" }]);
  });

  it("lists the site names when the filter matches none, without calling Google", async () => {
    const s = source();
    expect(await lookupTraffic(MONDAY_9AM, { weeksAgo: 0, site: "Schenectady" }, s.s)).toEqual({
      status: "no_match",
      site: "Schenectady",
      sites: ["Trinity Plumbing", "Albany Rooter", "Troy Water Heaters"],
    });
    expect(s.fetch).not.toHaveBeenCalled();
  });
});
