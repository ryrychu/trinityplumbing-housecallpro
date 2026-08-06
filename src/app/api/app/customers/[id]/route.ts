import { getCustomerDetail } from "@/lib/mobile/customers";
import { appJson, appError } from "@/lib/mobile/envelope";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const detail = await getCustomerDetail(params.id);
    if (!detail) return appError("Customer not found.", 404);
    return appJson(detail);
  } catch (err) {
    return appError(
      `Couldn't load the customer: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}
