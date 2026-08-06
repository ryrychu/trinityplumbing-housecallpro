import { listOpenEstimates, listUnpaidInvoices } from "@/lib/mobile/money";
import { appJson, appError } from "@/lib/mobile/envelope";

export const dynamic = "force-dynamic";

export async function GET() {
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
