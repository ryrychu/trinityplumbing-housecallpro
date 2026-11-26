// Website chat settings, read from the environment. Error text names the
// variable and, for CHAT_SITES, the bad entry; never the salt.
type Env = Record<string, string | undefined>;

export type ChatSite = { key: string; origins: string[]; knowledgeUrl: string };
export type ChatLimits = { ipMax: number; ipWindowMs: number; siteDailyMax: number };
export type ChatConfig =
  | { ok: true; sites: ChatSite[]; limits: ChatLimits; ipSalt: string }
  | { ok: false; missing: string };

export const DEFAULT_LIMITS: ChatLimits = { ipMax: 20, ipWindowMs: 10 * 60_000, siteDailyMax: 500 };

// Off unless exactly "true", like SLACK_ALERTS_ENABLED.
export function chatEnabled(env: Env = process.env): boolean {
  return env.CHAT_ENABLED === "true";
}

/** scheme://host[:port] exactly as the browser sends it in Origin, or null. */
function normalizeOrigin(raw: string): string | null {
  if (raw.includes("*")) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  // No path, query or trailing slash: those never appear in an Origin header.
  return url.origin === raw ? url.origin : null;
}

/**
 * "trinity=https://trinity.plumbing|https://www.trinity.plumbing,other=https://…".
 * The first origin of each site is where <origin>/chat-knowledge.json is fetched.
 */
export function parseChatSites(raw: string | undefined): { ok: true; sites: ChatSite[] } | { ok: false; error: string } {
  const entries = (raw ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return { ok: false, error: "CHAT_SITES is empty" };

  const sites: ChatSite[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const key = eq > 0 ? entry.slice(0, eq).trim() : "";
    const list = eq > 0 ? entry.slice(eq + 1).split("|").map((o) => o.trim()).filter(Boolean) : [];
    if (!/^[a-z0-9-]+$/.test(key) || list.length === 0) {
      return { ok: false, error: `CHAT_SITES entry "${entry}" should look like trinity=https://trinity.plumbing` };
    }
    const origins: string[] = [];
    for (const candidate of list) {
      const origin = normalizeOrigin(candidate);
      if (!origin) {
        return {
          ok: false,
          error: `CHAT_SITES entry "${entry}" has a bad origin "${candidate}": use https://host, with no path, wildcard or trailing slash`,
        };
      }
      if (!origins.includes(origin)) origins.push(origin);
    }
    if (seen.has(key)) return { ok: false, error: `CHAT_SITES names "${key}" twice` };
    seen.add(key);
    sites.push({ key, origins, knowledgeUrl: `${origins[0]}/chat-knowledge.json` });
  }
  return { ok: true, sites };
}

function positiveInt(env: Env, name: string, fallback: number): number | string {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) return `${name} should be a whole number above 0`;
  return Number(raw);
}

export function chatLimits(env: Env = process.env): { ok: true; limits: ChatLimits } | { ok: false; error: string } {
  const ipMax = positiveInt(env, "CHAT_IP_LIMIT", DEFAULT_LIMITS.ipMax);
  const windowMinutes = positiveInt(env, "CHAT_IP_WINDOW_MINUTES", DEFAULT_LIMITS.ipWindowMs / 60_000);
  const siteDailyMax = positiveInt(env, "CHAT_SITE_DAILY_LIMIT", DEFAULT_LIMITS.siteDailyMax);
  for (const value of [ipMax, windowMinutes, siteDailyMax]) {
    if (typeof value === "string") return { ok: false, error: value };
  }
  return {
    ok: true,
    limits: { ipMax: ipMax as number, ipWindowMs: (windowMinutes as number) * 60_000, siteDailyMax: siteDailyMax as number },
  };
}

/** Everything the route needs, parsed; or the first problem, by variable name. */
export function chatConfig(env: Env = process.env): ChatConfig {
  if (!env.CHAT_SITES?.trim()) return { ok: false, missing: "CHAT_SITES is not set" };
  const ipSalt = env.CHAT_IP_SALT?.trim();
  if (!ipSalt) return { ok: false, missing: "CHAT_IP_SALT is not set" };
  const sites = parseChatSites(env.CHAT_SITES);
  if (!sites.ok) return { ok: false, missing: sites.error };
  const limits = chatLimits(env);
  if (!limits.ok) return { ok: false, missing: limits.error };
  return { ok: true, sites: sites.sites, limits: limits.limits, ipSalt };
}
