import { getJobDetail } from "@/lib/mobile/jobDetail";
import { appJson, appError } from "@/lib/mobile/envelope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const detail = await getJobDetail(params.id);
    if (!detail) return appError("Job not found.", 404);
    return appJson(detail);
  } catch (err) {
    return appError(
      `Couldn't load the job: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
