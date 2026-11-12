// Auth for the ChatGPT connector. Supabase Auth is the OAuth 2.1 authorization
// server; this app is only the protected resource. It publishes where to log
// in (RFC 9728 metadata) and checks the access tokens Supabase issued.
import { createClient } from "@supabase/supabase-js";

export const MCP_PATH = "/api/mcp";
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

export interface McpCaller {
  userId: string;
  clientId: string;
  token: string;
}

export type ClaimsVerifier = (jwt: string) => Promise<Record<string, unknown> | null>;

// getClaims verifies the JWT signature: locally against the project's JWKS
// when it uses asymmetric signing keys, otherwise by asking the Auth server.
export function supabaseClaimsVerifier(): ClaimsVerifier {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new Error("Missing env var: NEXT_PUBLIC_SUPABASE_URL");
  if (!anonKey) throw new Error("Missing env var: NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return async (jwt) => {
    const { data, error } = await supabase.auth.getClaims(jwt);
    if (error || !data) return null;
    return data.claims as unknown as Record<string, unknown>;
  };
}

export async function verifyMcpToken(header: string | null, verify: ClaimsVerifier): Promise<McpCaller | null> {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return null;
  const token = match[1];

  let claims: Record<string, unknown> | null;
  try {
    claims = await verify(token);
  } catch {
    return null;
  }
  if (!claims) return null;
  if (claims.role !== "authenticated") return null;
  if (claims.is_anonymous === true) return null;
  // Only tokens Supabase issued to an OAuth client carry client_id. Requiring
  // it keeps a copied browser-session token from working here.
  if (typeof claims.client_id !== "string" || claims.client_id === "") return null;
  if (typeof claims.sub !== "string" || claims.sub === "") return null;

  return { userId: claims.sub, clientId: claims.client_id, token };
}

// Public origin of this deployment as the caller saw it. Vercel sets the
// forwarded headers; req.url is the fallback for local dev and tests.
export function requestOrigin(req: Request): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return new URL(req.url).origin;
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function protectedResourceMetadata(origin: string, supabaseUrl: string) {
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [`${supabaseUrl.replace(/\/+$/, "")}/auth/v1`],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
    resource_name: "Trinity Plumbing price book (read-only)",
  };
}

export function wwwAuthenticate(origin: string, invalidToken: boolean): string {
  const meta = `resource_metadata="${origin}${RESOURCE_METADATA_PATH}"`;
  return invalidToken ? `Bearer error="invalid_token", ${meta}` : `Bearer ${meta}`;
}
