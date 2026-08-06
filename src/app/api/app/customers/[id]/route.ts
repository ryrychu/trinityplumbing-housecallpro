import { getCustomerDetail } from "@/lib/mobile/customers";
import { appJson, appError } from "@/lib/mobile/envelope";
import { requireUser } from "@/lib/mobile/session";
import type { MirrorResource } from "@/lib/mobile/mirrorFreshness";

export const dynamic = "force-dynamic";

// Both, unlike the search route: getCustomerDetail reads the customer row
// AND runs a jobs query for the history list and lifetime value. Declaring
// only `customers` would date half of what this screen renders.
const RESOURCES: MirrorResource[] = ["customers", "jobs"];

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  // See the comment in the today route: the service-role client plus the
  // absence of RLS on every table meant the middleware matcher was the single
  // point of enforcement for this data. This makes the check the route's own,
  // so a test can hold it rather than trusting one array literal stays right.
  if (!(await requireUser())) return appError("Not signed in", 401);

  try {
    const detail = await getCustomerDetail(params.id);
    if (!detail) return appError("Customer not found.", 404);
    return await appJson(detail, RESOURCES);
  } catch (err) {
    return appError(
      `Couldn't load the customer: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
