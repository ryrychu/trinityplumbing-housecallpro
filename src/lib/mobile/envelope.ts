import { NextResponse } from "next/server";

// Every /api/app/* response is shaped { data, generated_at } so freshness is
// a property of the payload, not a client-side guess. FreshnessStamp and
// useAppData (src/components/mobile) both depend on this exact shape.
export interface AppEnvelope<T> {
  data: T;
  generated_at: string;
}

export function appJson<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(
    { data, generated_at: new Date().toISOString() },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export function appError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
