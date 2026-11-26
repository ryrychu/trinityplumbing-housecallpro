// Which listed site a browser request comes from. The Origin header must equal
// one of the site's origins in CHAT_SITES, character for character: no
// wildcards, no suffix or prefix matching. CORS headers only ever echo a
// listed origin.
import type { ChatSite } from "./config";

export function siteFor(sites: ChatSite[], key: unknown, origin: string | null): ChatSite | null {
  if (typeof key !== "string" || !origin) return null;
  const site = sites.find((s) => s.key === key);
  return site && site.origins.includes(origin) ? site : null;
}

export function isListedOrigin(sites: ChatSite[], origin: string | null): origin is string {
  return !!origin && sites.some((s) => s.origins.includes(origin));
}

export function corsHeaders(origin: string): Record<string, string> {
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

/** The browser's OPTIONS check before the bubble's JSON POST. */
export function preflightResponse(sites: ChatSite[], origin: string | null): Response {
  if (!isListedOrigin(sites, origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
