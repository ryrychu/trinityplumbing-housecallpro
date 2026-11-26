// The two Google calls this feature makes: a service-account token
// (JWT bearer grant, signed here with node:crypto so no Google SDK is needed)
// and the GA4 Data API's runReport.
//
// Errors THROW a GaApiError carrying only Google's error code (or http_<n>),
// never the key, the token or a response body.
import { createSign } from "node:crypto";
import type { ServiceAccount } from "./config";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const TIMEOUT_MS = 15_000;
const TOKEN_LIFETIME_SEC = 3600;

export class GaApiError extends Error {
  constructor(
    readonly op: string,
    readonly code: string
  ) {
    super(`[ga] ${op} failed: ${code}`);
    this.name = "GaApiError";
  }
}

/** The parts of a runReport response this app reads. */
export type GaReport = {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type?: string }[];
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  rowCount?: number;
};

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

function signedAssertion(account: ServiceAccount, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: account.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + TOKEN_LIFETIME_SEC })
  );
  let signature: Buffer;
  try {
    signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.privateKey);
  } catch {
    throw new GaApiError("token", "bad_key");
  }
  return `${header}.${claims}.${b64url(signature)}`;
}

async function send(op: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new GaApiError(op, timedOut ? "timeout" : "network");
  }
}

// Google's codes are short identifiers; anything else is reduced to the HTTP status.
function safeCode(candidate: unknown, status: number): string {
  return typeof candidate === "string" && /^[A-Za-z_]{1,60}$/.test(candidate) ? candidate : `http_${status}`;
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const e = body?.error;
  if (typeof e === "string") return safeCode(e, res.status);
  if (e && typeof e === "object") return safeCode((e as { status?: unknown }).status, res.status);
  return `http_${res.status}`;
}

/** A one-hour, read-only Analytics access token for the service account. */
export async function getAccessToken(account: ServiceAccount, now: Date = new Date()): Promise<string> {
  const assertion = signedAssertion(account, now);
  const res = await send("token", TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) throw new GaApiError("token", await errorCode(res));
  const data = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  if (typeof data?.access_token !== "string" || !data.access_token) throw new GaApiError("token", "bad_response");
  return data.access_token;
}

export async function runReport(token: string, propertyId: string, body: Record<string, unknown>): Promise<GaReport> {
  if (!/^\d+$/.test(propertyId)) throw new GaApiError("runReport", "bad_property_id");
  const res = await send("runReport", `${DATA_API}/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new GaApiError("runReport", await errorCode(res));
  const data = (await res.json().catch(() => null)) as GaReport | null;
  if (!data || typeof data !== "object") throw new GaApiError("runReport", "bad_response");
  return data;
}
