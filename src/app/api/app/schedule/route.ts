import { getScheduleDays } from "@/lib/dashboard/queries";
import { weekRange } from "@/lib/dashboard/week";
import { getSupabaseServerClient } from "@/lib/supabase/client";
import { appJson, appError } from "@/lib/mobile/envelope";
import { requireUser } from "@/lib/mobile/session";
import type { MirrorResource } from "@/lib/mobile/mirrorFreshness";

export const dynamic = "force-dynamic";

const BUSINESS_TIME_ZONE = "America/New_York";
const MAX_OFFSET_WEEKS = 26;

// The week grid and its rows. Same reasoning as the today route: jobs and
// customers both ride the 15-minute cron, so this screen's stamp can hold a
// tight threshold and actually mean something.
const RESOURCES: MirrorResource[] = ["jobs", "customers"];

function clampOffset(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_OFFSET_WEEKS, Math.max(-MAX_OFFSET_WEEKS, Math.trunc(n)));
}

export async function GET(req: Request) {
  // See the comment in the today route: the service-role client plus the
  // absence of RLS on every table meant the middleware matcher was the single
  // point of enforcement for this data. This makes the check the route's own,
  // so a test can hold it rather than trusting one array literal stays right.
  if (!(await requireUser())) return appError("Not signed in", 401);

  const offset = clampOffset(new URL(req.url).searchParams.get("offset"));

  try {
    // weekRange gives this week's Monday; step whole weeks from there. Anchored
    // at 16:00 UTC (noon-ish Eastern under either DST offset) so the calendar
    // date is never ambiguous — the same trick getScheduleDays uses internally.
    const monday = new Date(weekRange(new Date(), "this").startIso);
    const anchor = new Date(
      Date.UTC(
        monday.getUTCFullYear(),
        monday.getUTCMonth(),
        monday.getUTCDate() + offset * 7,
        16,
        0,
        0
      )
    );

    const [days, technicians] = await Promise.all([
      getScheduleDays(anchor, 7),
      listTechnicians(),
    ]);

    return await appJson(
      {
        weekLabel: `Week of ${anchor.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: BUSINESS_TIME_ZONE,
        })}`,
        offset,
        days: days.map((d) => ({
          ...d,
          // d.dateKey is a bare YYYY-MM-DD; anchor mid-day before parsing so a
          // DST boundary can't roll the label onto the wrong calendar day (same
          // reason getScheduleDays anchors its own buckets at 16:00 UTC).
          label: new Date(`${d.dateKey}T16:00:00Z`).toLocaleDateString("en-US", {
            weekday: "short",
            timeZone: BUSINESS_TIME_ZONE,
          }),
        })),
        technicians,
      },
      RESOURCES
    );
  } catch (err) {
    return appError(
      `Couldn't load the schedule: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
}

async function listTechnicians(): Promise<{ id: string; name: string }[]> {
  // Six employees on the live account, so one bounded page is plenty — but the
  // range is explicit rather than relying on PostgREST's silent 1000-row cap.
  const { data, error } = await getSupabaseServerClient()
    .from("technicians")
    .select("id, first_name, last_name")
    .range(0, 999);
  if (error) throw new Error(`technicians query failed: ${error.message}`);

  const named = (data ?? []).map(
    (t: { id: string; first_name: string | null; last_name: string | null }) => ({
      id: t.id,
      name: [t.first_name, t.last_name].filter(Boolean).join(" ") || "Unnamed",
    })
  );

  // The Schedule screen filters TodayScheduleRow[] by technicianName (that type
  // carries no technician id — see queries.ts), so two technicians who happen
  // to share a display name are already indistinguishable to the filter once
  // it reaches the rows. Offering both as separate dropdown options would just
  // add a second entry that filters identically to the first, which reads as
  // a bug rather than a UI quirk. Collapsing them here at least keeps the
  // dropdown honest about what it can actually discriminate; a real fix needs
  // technician_id threaded onto TodayScheduleRow, which is outside this route.
  const seen = new Set<string>();
  const deduped: { id: string; name: string }[] = [];
  for (const t of named) {
    const key = t.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }
  return deduped;
}
