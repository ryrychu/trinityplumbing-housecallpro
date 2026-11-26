// Google Analytics settings, read from the environment. Error text names the
// variable and, for GA_PROPERTIES, the bad entry; never the key itself.
type Env = Record<string, string | undefined>;

export type GaProperty = { site: string; propertyId: string };
export type ServiceAccount = { clientEmail: string; privateKey: string };

export type AnalyticsConfig =
  | { ok: true; properties: GaProperty[]; account: ServiceAccount }
  | { ok: false; missing: string };

// Off unless exactly "true", like SLACK_ALERTS_ENABLED. Covers the Monday post
// only: the preview and the ChatGPT tool work as soon as the GA variables do.
export function analyticsWeeklyEnabled(env: Env = process.env): boolean {
  return env.ANALYTICS_WEEKLY_ENABLED === "true";
}

/** "Trinity Plumbing=123456789,Albany Rooter=987654321". Site names can't contain commas. */
export function parseProperties(raw: string | undefined): { ok: true; properties: GaProperty[] } | { ok: false; error: string } {
  const entries = (raw ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return { ok: false, error: "GA_PROPERTIES is empty" };

  const properties: GaProperty[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const eq = entry.lastIndexOf("=");
    const site = eq > 0 ? entry.slice(0, eq).trim() : "";
    const id = eq > 0 ? entry.slice(eq + 1).trim().replace(/^properties\//, "") : "";
    if (!site || !id) {
      return { ok: false, error: `GA_PROPERTIES entry "${entry}" should look like Site Name=123456789` };
    }
    if (/^G-/i.test(id)) {
      return {
        ok: false,
        error: `GA_PROPERTIES entry "${entry}" has a Measurement ID (G-…). Use the numeric Property ID from GA4 Admin → Property details`,
      };
    }
    if (!/^\d+$/.test(id)) {
      return { ok: false, error: `GA_PROPERTIES entry "${entry}" needs a numeric property ID` };
    }
    const key = site.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `GA_PROPERTIES names "${site}" twice` };
    seen.add(key);
    properties.push({ site, propertyId: id });
  }
  return { ok: true, properties };
}

function decode(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  return JSON.parse(Buffer.from(trimmed, "base64").toString("utf8"));
}

/** The whole service-account key file, as JSON or base64 of that JSON. */
export function parseServiceAccount(raw: string | undefined): { ok: true; account: ServiceAccount } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = decode(raw ?? "");
  } catch {
    return { ok: false, error: "GA_SERVICE_ACCOUNT_JSON isn't the key file's JSON (or base64 of it)" };
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const clientEmail = typeof o.client_email === "string" ? o.client_email.trim() : "";
  // Some env editors flatten the key's newlines into the two characters \n.
  const privateKey = typeof o.private_key === "string" ? o.private_key.replace(/\\n/g, "\n") : "";
  if (!clientEmail) return { ok: false, error: "GA_SERVICE_ACCOUNT_JSON has no client_email" };
  if (!privateKey.includes("PRIVATE KEY")) return { ok: false, error: "GA_SERVICE_ACCOUNT_JSON has no private_key" };
  return { ok: true, account: { clientEmail, privateKey } };
}

/** Both GA variables, parsed; or the first problem, by variable name. */
export function analyticsConfig(env: Env = process.env): AnalyticsConfig {
  if (!env.GA_SERVICE_ACCOUNT_JSON?.trim()) return { ok: false, missing: "GA_SERVICE_ACCOUNT_JSON is not set" };
  if (!env.GA_PROPERTIES?.trim()) return { ok: false, missing: "GA_PROPERTIES is not set" };
  const account = parseServiceAccount(env.GA_SERVICE_ACCOUNT_JSON);
  if (!account.ok) return { ok: false, missing: account.error };
  const props = parseProperties(env.GA_PROPERTIES);
  if (!props.ok) return { ok: false, missing: props.error };
  return { ok: true, properties: props.properties, account: account.account };
}
