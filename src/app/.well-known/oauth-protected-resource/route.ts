// RFC 9728 protected-resource metadata. ChatGPT reads this after its first
// 401 from /api/mcp to learn that Supabase Auth is where users sign in.
import { protectedResourceMetadata, requestOrigin } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }
  return Response.json(protectedResourceMetadata(requestOrigin(req), supabaseUrl), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
