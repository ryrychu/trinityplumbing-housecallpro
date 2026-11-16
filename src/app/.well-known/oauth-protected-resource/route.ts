// RFC 9728 protected-resource metadata. ChatGPT reads this after its first
// 401 from /api/mcp to learn that Supabase Auth is where users sign in.
import { metadataResponse, PRICEBOOK_RESOURCE } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return metadataResponse(req, PRICEBOOK_RESOURCE);
}
