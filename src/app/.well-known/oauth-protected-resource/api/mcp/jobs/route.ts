// RFC 9728 path-specific metadata for /api/mcp/jobs. The 401 from that
// endpoint points here, so ChatGPT registers the jobs connector on its own.
import { JOBS_RESOURCE, metadataResponse } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return metadataResponse(req, JOBS_RESOURCE);
}
