import { describe, it, expect, vi, afterEach } from "vitest";
import { connect, stubDeps, text } from "./fixtures";
import { sampleReport } from "@/lib/analytics/__tests__/fixtures";
import type { JobsDeps } from "../server";

afterEach(() => vi.restoreAllMocks());

function recording(result: Awaited<ReturnType<JobsDeps["getSiteTraffic"]>> = { status: "ok", report: sampleReport() }) {
  const calls: Parameters<JobsDeps["getSiteTraffic"]>[0][] = [];
  const getSiteTraffic: JobsDeps["getSiteTraffic"] = async (opts) => {
    calls.push(opts);
    return result;
  };
  return { calls, getSiteTraffic };
}

describe("get_site_traffic", () => {
  it("is read-only and describes what it returns", async () => {
    const client = await connect(stubDeps().deps);
    const tool = (await client.listTools()).tools.find((t) => t.name === "get_site_traffic")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.description).toMatch(/Google Analytics/);
    expect(tool.description).toMatch(/phone/i);
    expect(Object.keys((tool.inputSchema as { properties: object }).properties).sort()).toEqual(["site", "weeks_ago"]);
  });

  it("says analytics isn't set up yet, as an answer rather than an error", async () => {
    const client = await connect(stubDeps().deps);
    const res = await client.callTool({ name: "get_site_traffic", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual({
      configured: false,
      message:
        "Website analytics isn't set up yet, so there are no traffic numbers to show. Tell the user it's waiting on Google Analytics access being added to the ops app (GA_PROPERTIES is not set).",
    });
  });

  it("returns last full week's report by default", async () => {
    const { calls, getSiteTraffic } = recording();
    const client = await connect(stubDeps({ getSiteTraffic }).deps);
    const body = JSON.parse(text(await client.callTool({ name: "get_site_traffic", arguments: {} })));
    expect(calls).toEqual([{ weeksAgo: 0, site: undefined }]);
    expect(body).toMatchObject({
      configured: true,
      weeksAgo: 0,
      week: { startDate: "2026-11-16", endDate: "2026-11-22", label: "Nov 16–22" },
      previousWeek: { startDate: "2026-11-09", endDate: "2026-11-15" },
      siteCount: 3,
      unavailableCount: 1,
      totals: { visitors: { thisWeek: 760, lastWeek: 734, changePct: 4 } },
    });
    expect(body.sites[0]).toMatchObject({
      site: "Trinity Plumbing",
      status: "ok",
      visitors: { thisWeek: 620, lastWeek: 574, changePct: 8 },
      topSources: [{ channel: "Organic Search", label: "Google search", visits: 410 }, {}, {}],
      actions: { phoneClicks: { thisWeek: 9 }, bookingClicks: { thisWeek: 3 }, formRequests: { thisWeek: 2 }, emailClicks: { thisWeek: 1 } },
    });
    expect(body.sites[2]).toMatchObject({ site: "Troy Water Heaters", status: "unavailable", reason: "PERMISSION_DENIED" });
    expect(body.note).toMatch(/Mon–Sun, Eastern/);
  });

  it("passes weeks_ago and the site filter through", async () => {
    const { calls, getSiteTraffic } = recording();
    const client = await connect(stubDeps({ getSiteTraffic }).deps);
    await client.callTool({ name: "get_site_traffic", arguments: { weeks_ago: 12, site: "rooter" } });
    expect(calls).toEqual([{ weeksAgo: 12, site: "rooter" }]);
  });

  it.each([13, -1, 1.5])("refuses weeks_ago=%s without asking Google", async (weeks_ago) => {
    const { calls, getSiteTraffic } = recording();
    const client = await connect(stubDeps({ getSiteTraffic }).deps);
    const res = await client
      .callTool({ name: "get_site_traffic", arguments: { weeks_ago } })
      .catch(() => ({ isError: true }));
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("lists the sites when the filter matches none", async () => {
    const { getSiteTraffic } = recording({ status: "no_match", site: "Schenectady", sites: ["Trinity Plumbing", "Albany Rooter"] });
    const client = await connect(stubDeps({ getSiteTraffic }).deps);
    const res = await client.callTool({ name: "get_site_traffic", arguments: { site: "Schenectady" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual({
      configured: true,
      site: "Schenectady",
      sites: ["Trinity Plumbing", "Albany Rooter"],
      note: 'No site name contains "Schenectady". Ask the user which of these sites they mean.',
    });
  });

  it("hides the raw error when Google can't be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(
      stubDeps({
        getSiteTraffic: async () => {
          throw new Error("[ga] token failed: invalid_grant");
        },
      }).deps
    );
    const res = await client.callTool({ name: "get_site_traffic", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("Couldn't get the website numbers from Google Analytics just now. Try again in a few minutes.");
  });
});
