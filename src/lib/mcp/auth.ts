// Auth for the ChatGPT connector. Supabase Auth is the OAuth 2.1 authorization
// server; this app is only the protected resource. It publishes where to log
// in (RFC 9728 metadata) and checks the access tokens Supabase issued.
import { createClient } from "@supabase/supabase-js";

export const MCP_PATH = "/api/mcp";
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

// One protected resource per ChatGPT connector. Each has its own endpoint and
// its own RFC 9728 metadata document, and the 401 challenge names the right
// one, so ChatGPT registers each connector separately. Both use the same
// Supabase authorization server and the same token check.
export interface McpResource {
  /** The MCP endpoint path, e.g. "/api/mcp". */
  path: string;
  /** Where that endpoint's protected-resource metadata is served. */
  metadataPath: string;
  /** Shown to users as the connector's name. */
  name: string;
}

export const PRICEBOOK_RESOURCE: McpResource = {
  path: MCP_PATH,
  metadataPath: RESOURCE_METADATA_PATH,
  name: "Trinity Plumbing price book (read-only)",
};

export const JOBS_RESOURCE: McpResource = {
  path: "/api/mcp/jobs",
  metadataPath: "/.well-known/oauth-protected-resource/api/mcp/jobs",
  name: "Trinity Plumbing jobs & customers (read-only)",
};

export const TASKS_RESOURCE: McpResource = {
  path: "/api/mcp/tasks",
  metadataPath: "/.well-known/oauth-protected-resource/api/mcp/tasks",
  name: "Trinity Plumbing tasks (Dave only)",
};

export const PRICEBOOK_EDIT_RESOURCE: McpResource = {
  path: "/api/mcp/pricebook-edit",
  metadataPath: "/.well-known/oauth-protected-resource/api/mcp/pricebook-edit",
  name: "Trinity Plumbing price book editor (Dave and Ella)",
};

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
    // Thrown, not returned as null, so the log can say why ("JWT expired").
    if (error) throw new Error(error.message);
    if (!data) return null;
    return data.claims as unknown as Record<string, unknown>;
  };
}

/** Why a request's token was turned away; logged, never sent to the caller. */
export type TokenRejection =
  | "no_header"
  | "not_bearer"
  | "verify_error"
  | "no_claims"
  | "not_authenticated"
  | "anonymous"
  | "no_client_id"
  | "no_sub";

export type TokenCheck =
  | { ok: true; caller: McpCaller }
  | { ok: false; reason: TokenRejection; detail?: string };

export async function checkMcpToken(header: string | null, verify: ClaimsVerifier): Promise<TokenCheck> {
  if (!header) return { ok: false, reason: "no_header" };
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return { ok: false, reason: "not_bearer" };
  const token = match[1];

  let claims: Record<string, unknown> | null;
  try {
    claims = await verify(token);
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 200) : undefined;
    return { ok: false, reason: "verify_error", ...(detail ? { detail } : {}) };
  }
  if (!claims) return { ok: false, reason: "no_claims" };
  if (claims.role !== "authenticated") return { ok: false, reason: "not_authenticated" };
  if (claims.is_anonymous === true) return { ok: false, reason: "anonymous" };
  // Only tokens Supabase issued to an OAuth client carry client_id. Requiring
  // it keeps a copied browser-session token from working here.
  if (typeof claims.client_id !== "string" || claims.client_id === "") return { ok: false, reason: "no_client_id" };
  if (typeof claims.sub !== "string" || claims.sub === "") return { ok: false, reason: "no_sub" };

  return { ok: true, caller: { userId: claims.sub, clientId: claims.client_id, token } };
}

export async function verifyMcpToken(header: string | null, verify: ClaimsVerifier): Promise<McpCaller | null> {
  const check = await checkMcpToken(header, verify);
  return check.ok ? check.caller : null;
}

// Public origin of this deployment as the caller saw it. Vercel sets the
// forwarded headers; req.url is the fallback for local dev and tests.
export function requestOrigin(req: Request): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return new URL(req.url).origin;
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function protectedResourceMetadata(
  origin: string,
  supabaseUrl: string,
  resource: McpResource = PRICEBOOK_RESOURCE
) {
  return {
    resource: `${origin}${resource.path}`,
    authorization_servers: [`${supabaseUrl.replace(/\/+$/, "")}/auth/v1`],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
    resource_name: resource.name,
  };
}

export function wwwAuthenticate(
  origin: string,
  invalidToken: boolean,
  resource: McpResource = PRICEBOOK_RESOURCE
): string {
  const meta = `resource_metadata="${origin}${resource.metadataPath}"`;
  return invalidToken ? `Bearer error="invalid_token", ${meta}` : `Bearer ${meta}`;
}

// The body of every protected-resource metadata route. Fails closed when the
// Supabase URL is missing rather than advertising an authorization server
// that doesn't exist.
export function metadataResponse(req: Request, resource: McpResource): Response {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }
  return Response.json(protectedResourceMetadata(requestOrigin(req), supabaseUrl, resource), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
