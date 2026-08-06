import { listOpenEstimates, listUnpaidInvoices } from "@/lib/mobile/money";
import { appJson, appError } from "@/lib/mobile/envelope";
import { requireUser } from "@/lib/mobile/session";
import type { MirrorResource } from "@/lib/mobile/mirrorFreshness";

export const dynamic = "force-dynamic";

// Both segments this screen shows. `invoices` is what earns this route the
// long threshold -- it reconciles at most once every INVOICE_RECONCILE_HOURS
// because HCP gives invoices no usable cursor -- and since a screen is only
// as fresh as its stalest input, invoices governs. Estimates ride the
// 15-minute cron and would otherwise have earned the short one.
const RESOURCES: MirrorResource[] = ["invoices", "estimates"];

export async function GET() {
  // See the comment in the today route: the service-role client plus the
  // absence of RLS on every table meant the middleware matcher was the single
  // point of enforcement for this data. This makes the check the route's own,
  // so a test can hold it rather than trusting one array literal stays right.
  if (!(await requireUser())) return appError("Not signed in", 401);

  try {
    const [estimates, invoices] = await Promise.all([listOpenEstimates(), listUnpaidInvoices()]);
    return await appJson(
      {
        estimates,
        estimatesTotalCents: estimates.reduce((s, e) => s + (e.amountCents ?? 0), 0),
        invoices,
        invoicesTotalCents: invoices.reduce((s, i) => s + (i.amountCents ?? 0), 0),
      },
      RESOURCES
    );
  } catch (err) {
    return appError(
      `Couldn't load money: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
