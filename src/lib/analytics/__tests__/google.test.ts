import { describe, it, expect, vi, afterEach } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { GaApiError, getAccessToken, runReport, TOKEN_URL } from "../google";

// A throwaway key made for this test run only.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const ACCOUNT = { clientEmail: "ga-reader@example.iam.gserviceaccount.com", privateKey };
const NOW = new Date("2026-11-23T14:00:00Z");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

afterEach(() => vi.unstubAllGlobals());

describe("getAccessToken", () => {
  it("exchanges a signed RS256 JWT for an access token, read-only scope", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => json({ access_token: "ya29.test-token", expires_in: 3599 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getAccessToken(ACCOUNT, NOW)).toBe("ya29.test-token");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [h, c, sig] = form.get("assertion")!.split(".");
    expect(b64urlJson(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(b64urlJson(c)).toEqual({
      iss: ACCOUNT.clientEmail,
      scope: "https://www.googleapis.com/auth/analytics.readonly",
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    });
    const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });

  it("throws Google's error code, never the key or the response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400)));
    const err = await getAccessToken(ACCOUNT, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(GaApiError);
    expect(err.code).toBe("invalid_grant");
    expect(err.message).not.toContain("PRIVATE KEY");
  });

  it("throws bad_key for a key Node can't read, without calling Google", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const err = await getAccessToken({ ...ACCOUNT, privateKey: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" }, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(GaApiError);
    expect(err.code).toBe("bad_key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws network on a fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect((await getAccessToken(ACCOUNT, NOW).catch((e) => e)).code).toBe("network");
  });
});

describe("runReport", () => {
  it("posts the request to the property's runReport endpoint with the token", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => json({ rows: [], rowCount: 0 }));
    vi.stubGlobal("fetch", fetchMock);

    const body = { dateRanges: [{ startDate: "2026-11-16", endDate: "2026-11-22" }], metrics: [{ name: "sessions" }] };
    expect(await runReport("ya29.test-token", "123456789", body)).toEqual({ rows: [], rowCount: 0 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ya29.test-token");
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it("throws GA's status code, e.g. PERMISSION_DENIED when the service account isn't a Viewer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { code: 403, status: "PERMISSION_DENIED", message: "User does not have sufficient permissions" } }, 403))
    );
    const err = await runReport("t", "123", {}).catch((e) => e);
    expect(err).toBeInstanceOf(GaApiError);
    expect(err.code).toBe("PERMISSION_DENIED");
  });

  it("falls back to the HTTP status when the error body isn't JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    expect((await runReport("t", "123", {}).catch((e) => e)).code).toBe("http_502");
  });

  it("refuses a property ID that isn't digits, without calling Google", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await runReport("t", "../123", {}).catch((e) => e)).code).toBe("bad_property_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
