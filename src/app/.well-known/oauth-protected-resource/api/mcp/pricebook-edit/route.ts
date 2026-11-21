// RFC 9728 path-specific metadata for /api/mcp/pricebook-edit.
import { PRICEBOOK_EDIT_RESOURCE, metadataResponse } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return metadataResponse(req, PRICEBOOK_EDIT_RESOURCE);
}
