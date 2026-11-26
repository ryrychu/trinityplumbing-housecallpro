import { describe, it, expect } from "vitest";
import { buildTrafficReport, siteTraffic } from "../report";
import { HEADER_MAX, MAX_BLOCKS, SECTION_TEXT_MAX, renderTrafficMessage, unavailableLine } from "../slack";
import { WEEKS, okSite, sampleReport, siteData, sourcesReport, totalsReport } from "./fixtures";

type Block = { type: string; text?: { type: string; text: string }; elements?: { type: string; text: string }[] };

type Rendered = { text: string; blocks: Block[] };

function render(...args: Parameters<typeof renderTrafficMessage>): Rendered {
  return renderTrafficMessage(...args) as unknown as Rendered;
}

function texts(blocks: Block[]): string[] {
  return blocks.flatMap((b) => [b.text?.text ?? "", ...(b.elements ?? []).map((e) => e.text)]).filter(Boolean);
}

describe("renderTrafficMessage", () => {
  it("has a header, the all-sites totals, one section per site and a footer", () => {
    const { text, blocks } = render(sampleReport());
    expect(blocks.map((b) => b.type)).toEqual(["header", "section", "divider", "section", "section", "section", "context"]);
    expect(blocks[0].text).toEqual({ type: "plain_text", text: "Website traffic: Nov 16–22", emoji: true });
    expect(text).toBe("Website traffic, Nov 16–22: 760 visitors across 2 sites, 13 calls from the site.");
  });

  it("writes the totals in plain words", () => {
    const { blocks } = render(sampleReport());
    expect(blocks[1].text!.text).toBe(
      [
        "*All sites: 760 visitors* (up 4%) · 961 visits",
        "📞 Calls from the site: *13* (same as the week before)",
        "📅 Booking clicks: *4* (up 33%)",
        "📝 Form requests: *2* (none the week before)",
        "✉️ Email clicks: *1* (none the week before)",
      ].join("\n")
    );
  });

  it("lists sites by visitors, busiest first, with top sources and actions", () => {
    const { blocks } = render(sampleReport());
    expect(blocks[3].text!.text).toBe(
      [
        "*Trinity Plumbing*",
        "620 visitors (up 8%) · 790 visits",
        "From: Google search 410 · Typed in or bookmarked 220 · Maps 80",
        "Calls from the site 9 · Booking clicks 3 · Form requests 2 · Email clicks 1",
      ].join("\n")
    );
    expect(blocks[4].text!.text).toBe(
      [
        "*Albany Rooter*",
        "140 visitors (down 13%) · 171 visits",
        "From: Google Ads 90 · Google search 60 · Typed in or bookmarked 21",
        "Calls from the site 4 · Booking clicks 1 · Form requests 0 · Email clicks 0",
      ].join("\n")
    );
  });

  it("shows an unavailable site last, with what to do about it", () => {
    const { blocks } = render(sampleReport());
    expect(blocks[5].text!.text).toBe(
      "*Troy Water Heaters*\n_Couldn't get this site's numbers from Google: no access. In GA4 Admin, add the service account as a Viewer on this property._"
    );
  });

  it("says when a site had no visitors", () => {
    const report = buildTrafficReport(WEEKS, [
      siteTraffic({ site: "Quiet", propertyId: "1" }, { totals: { rows: [] }, sources: { rows: [] }, events: { rows: [] } }),
    ]);
    const { blocks } = render(report);
    expect(blocks[3].text!.text).toBe("*Quiet*\nNo visitors this week.");
  });

  it("explains the comparison and the totals in the footer", () => {
    const { blocks } = render(sampleReport());
    expect(blocks[blocks.length - 1].elements![0].text).toBe(
      "Mon–Sun, Eastern time. Changes compare with Nov 9–15. A person who visits two sites counts once on each. 1 site couldn't be read. From Google Analytics."
    );
  });

  it("marks a preview as private and not yet posted", () => {
    const { blocks } = render(sampleReport(), { preview: true });
    expect(blocks[0].type).toBe("context");
    expect(blocks[0].elements![0].text).toBe(
      "Preview, only you can see this. The real post goes to the channel on Monday morning."
    );
    expect(blocks[1].type).toBe("header");
  });

  it("escapes Slack control characters in site and source names", () => {
    const report = buildTrafficReport(WEEKS, [
      siteTraffic({ site: "<!channel> & Sons", propertyId: "1" }, siteData({ sources: sourcesReport([["<@U123>", 5]]) })),
    ]);
    const all = texts((render(report)).blocks).join("\n");
    expect(all).toContain("*&lt;!channel&gt; &amp; Sons*");
    expect(all).toContain("&lt;@U123&gt; 5");
    expect(all).not.toMatch(/<!channel>|<@U123>/);
  });

  it("stays within Slack's limits with 12 sites with very long names", () => {
    const long = "Capital Region Emergency Plumbing Drain Cleaning Sewer And Water Heater Repair Services Of Albany";
    const sites = Array.from({ length: 12 }, (_, i) =>
      siteTraffic(
        { site: `${long} ${i + 1}`.repeat(3), propertyId: String(1000 + i) },
        siteData({
          totals: totalsReport({ this: 1000 * (i + 1), last: 900 }, { this: 1200, last: 1000 }),
          sources: sourcesReport([["x".repeat(500), 900], ["Organic Search", 800], ["Direct", 700]]),
        })
      )
    );
    const { text, blocks } = render(buildTrafficReport(WEEKS, sites), { preview: true });
    expect(blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(blocks.filter((b) => b.type === "section")).toHaveLength(13);
    for (const b of blocks) {
      if (b.type === "header") expect(b.text!.text.length).toBeLessThanOrEqual(HEADER_MAX);
      if (b.type === "section") expect(b.text!.text.length).toBeLessThanOrEqual(SECTION_TEXT_MAX);
      for (const e of b.elements ?? []) expect(e.text.length).toBeLessThanOrEqual(SECTION_TEXT_MAX);
    }
    expect(text.length).toBeLessThanOrEqual(SECTION_TEXT_MAX);
    // Busiest first: site 12 had the most visitors.
    expect(blocks[4].text!.text.startsWith("*Capital Region")).toBe(true);
    expect(blocks[4].text!.text).toContain("12,000 visitors");
  });

  it("caps the sections and sums up the rest, so even 60 sites fit in 50 blocks", () => {
    const sites = Array.from({ length: 60 }, (_, i) => okSite(`Site ${String(i + 1).padStart(2, "0")}`, 100 - i));
    const { blocks } = render(buildTrafficReport(WEEKS, sites), { preview: true });
    expect(blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    const last = blocks[blocks.length - 2].text!.text;
    expect(last).toMatch(/^…and \d+ more sites/);
  });
});

describe("unavailableLine", () => {
  it.each([
    ["PERMISSION_DENIED", /no access/],
    ["http_403", /no access/],
    ["NOT_FOUND", /Check its ID in GA_PROPERTIES/],
    ["RESOURCE_EXHAUSTED", /limit/],
    ["network", /couldn't reach Google/],
    ["SOMETHING_NEW", /Google said SOMETHING_NEW/],
  ])("explains %s", (code, pattern) => {
    expect(unavailableLine(code)).toMatch(pattern);
  });
});
