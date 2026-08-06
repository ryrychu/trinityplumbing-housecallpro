import { getJobDetail } from "@/lib/mobile/jobDetail";
import { appJson, appError } from "@/lib/mobile/envelope";
import { requireUser } from "@/lib/mobile/session";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  // See the comment in the today route: the service-role client plus the
  // absence of RLS on every table meant the middleware matcher was the single
  // point of enforcement for this data. This makes the check the route's own,
  // so a test can hold it rather than trusting one array literal stays right.
  if (!(await requireUser())) return appError("Not signed in", 401);

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
