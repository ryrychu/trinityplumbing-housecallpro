import { getJobDetail } from "@/lib/mobile/jobDetail";
import { appJson, appError } from "@/lib/mobile/envelope";
import { requireUser } from "@/lib/mobile/session";
import type { MirrorResource } from "@/lib/mobile/mirrorFreshness";

export const dynamic = "force-dynamic";

// KNOWN GAP, same as the today route and stated for the same reason: the
// linked invoice this screen renders comes from `invoices`, which is NOT
// declared here. Declaring it would push the threshold past 20 hours and
// stop the stamp from ever revealing a dead 15-minute cron -- the job's
// time, address and technician are what someone acts on, and those are
// what this stamp dates.
const RESOURCES: MirrorResource[] = ["jobs", "customers"];

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  // See the comment in the today route: the service-role client plus the
  // absence of RLS on every table meant the middleware matcher was the single
  // point of enforcement for this data. This makes the check the route's own,
  // so a test can hold it rather than trusting one array literal stays right.
  if (!(await requireUser())) return appError("Not signed in", 401);

  try {
    const detail = await getJobDetail(params.id);
    if (!detail) return appError("Job not found.", 404);
    return await appJson(detail, RESOURCES);
  } catch (err) {
    return appError(
      `Couldn't load the job: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
