// RFC 9728 path-specific metadata for /api/mcp/tasks. The 401 from that
// endpoint points here, so ChatGPT registers the tasks connector on its own.
import { TASKS_RESOURCE, metadataResponse } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  return metadataResponse(req, TASKS_RESOURCE);
}
