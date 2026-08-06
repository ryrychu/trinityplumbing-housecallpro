import { listOpenEstimates, listUnpaidInvoices } from "@/lib/mobile/money";
import { appJson, appError } from "@/lib/mobile/envelope";
import { requireUser } from "@/lib/mobile/session";

export const dynamic = "force-dynamic";

export async function GET() {
  // See the comment in the today route: the service-role client plus the
  // absence of RLS on every table meant the middleware matcher was the single
  // point of enforcement for this data. This makes the check the route's own,
  // so a test can hold it rather than trusting one array literal stays right.
  if (!(await requireUser())) return appError("Not signed in", 401);

  try {
    const [estimates, invoices] = await Promise.all([listOpenEstimates(), listUnpaidInvoices()]);
    return appJson({
      estimates,
      estimatesTotalCents: estimates.reduce((s, e) => s + (e.amountCents ?? 0), 0),
      invoices,
      invoicesTotalCents: invoices.reduce((s, i) => s + (i.amountCents ?? 0), 0),
    });
  } catch (err) {
    return appError(
      `Couldn't load money: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
