// @vitest-environment node
import { describe, it, expect } from "vitest";
import { verifyMcpToken, protectedResourceMetadata, requestOrigin, wwwAuthenticate } from "../auth";

const VALID = { sub: "user-1", role: "authenticated", client_id: "chatgpt-client", is_anonymous: false };
const verifier = (claims: Record<string, unknown> | null) => async () => claims;

describe("verifyMcpToken", () => {
  it("rejects missing or malformed headers without calling the verifier", async () => {
    let called = false;
    const spy = async () => {
      called = true;
      return VALID;
    };
    for (const h of [null, "", "Basic abc", "Bearer ", "Bearer a b"]) {
      expect(await verifyMcpToken(h, spy)).toBeNull();
    }
    expect(called).toBe(false);
  });

  it("rejects when the verifier returns null or throws", async () => {
    expect(await verifyMcpToken("Bearer t", verifier(null))).toBeNull();
    expect(
      await verifyMcpToken("Bearer t", async () => {
        throw new Error("bad signature");
      })
    ).toBeNull();
  });

  it("requires an authenticated, non-anonymous, OAuth-issued token", async () => {
    expect(await verifyMcpToken("Bearer t", verifier({ ...VALID, role: "anon" }))).toBeNull();
    expect(await verifyMcpToken("Bearer t", verifier({ ...VALID, is_anonymous: true }))).toBeNull();
    expect(await verifyMcpToken("Bearer t", verifier({ ...VALID, client_id: undefined }))).toBeNull();
    expect(await verifyMcpToken("Bearer t", verifier({ ...VALID, client_id: "" }))).toBeNull();
    expect(await verifyMcpToken("Bearer t", verifier({ ...VALID, sub: undefined }))).toBeNull();
  });

  it("returns the caller for a valid token", async () => {
    expect(await verifyMcpToken("Bearer tok-123", verifier(VALID))).toEqual({
      userId: "user-1",
      clientId: "chatgpt-client",
      token: "tok-123",
    });
  });
});

describe("protected resource metadata", () => {
  it("points ChatGPT at Supabase Auth", () => {
    expect(protectedResourceMetadata("https://ops.example.com", "https://abc.supabase.co/")).toMatchObject({
      resource: "https://ops.example.com/api/mcp",
      authorization_servers: ["https://abc.supabase.co/auth/v1"],
      bearer_methods_supported: ["header"],
      scopes_supported: expect.arrayContaining(["openid"]),
    });
  });

  it("derives the origin from forwarded headers, then the URL", () => {
    const fwd = new Request("http://internal:3000/api/mcp", {
      headers: { "x-forwarded-host": "ops.example.com", "x-forwarded-proto": "https" },
    });
    expect(requestOrigin(fwd)).toBe("https://ops.example.com");
    expect(requestOrigin(new Request("http://localhost:3000/api/mcp"))).toBe("http://localhost:3000");
  });

  it("builds the WWW-Authenticate challenge", () => {
    expect(wwwAuthenticate("https://o.example", false)).toBe(
      'Bearer resource_metadata="https://o.example/.well-known/oauth-protected-resource"'
    );
    expect(wwwAuthenticate("https://o.example", true)).toMatch(/^Bearer error="invalid_token", resource_metadata=/);
  });
});
