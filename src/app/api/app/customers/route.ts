import { searchCustomers } from "@/lib/mobile/customers";
import { appJson, appError } from "@/lib/mobile/envelope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
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
