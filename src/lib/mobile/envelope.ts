import { NextResponse } from "next/server";
import { mirrorSyncedAt, staleAfterMinutes, type MirrorResource } from "./mirrorFreshness";

// Every /api/app/* response is shaped { data, generated_at, mirror_synced_at,
// stale_after_minutes } so freshness is a property of the payload, not a
// client-side guess. FreshnessStamp and useAppData (src/components/mobile)
// both depend on this exact shape.
//
// generated_at is kept, but it is NOT the freshness signal. It answers "when
// did this HTTP request happen", which is always seconds ago and therefore
// never interesting. mirror_synced_at answers "how old is the data", which is
// the question the stamp was added to answer. generated_at still earns its
// place: it dates a cached copy while offline, where request time genuinely is
// the useful number -- that is when this device last held the data.
export interface AppEnvelope<T> {
  data: T;
  generated_at: string;
  mirror_synced_at: string | null;
  stale_after_minutes: number;
}

/**
 * `resources` is required rather than optional on purpose: a route that forgot
 * to declare what it reads would otherwise report a freshness it never
 * established, and the compiler is the cheapest place to catch that.
 */
export async function appJson<T>(
  data: T,
  resources: MirrorResource[],
  status = 200
): Promise<NextResponse> {
  return NextResponse.json(
    {
      data,
      generated_at: new Date().toISOString(),
      mirror_synced_at: await mirrorSyncedAt(resources),
      stale_after_minutes: staleAfterMinutes(resources),
    },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export function appError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
