import { searchCustomers } from "@/lib/mobile/customers";
import { appJson, appError } from "@/lib/mobile/envelope";
import { requireUser } from "@/lib/mobile/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // See the comment in the today route: the service-role client plus the
  // absence of RLS on every table meant the middleware matcher was the single
  // point of enforcement for this data. This makes the check the route's own,
  // so a test can hold it rather than trusting one array literal stays right.
  if (!(await requireUser())) return appError("Not signed in", 401);

  const q = new URL(req.url).searchParams.get("q") ?? "";
  try {
    return appJson({ query: q, hits: await searchCustomers(q) });
  } catch (err) {
    return appError(
      `Search failed: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
