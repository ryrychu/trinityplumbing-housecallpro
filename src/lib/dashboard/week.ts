// Mon–Sun week boundaries in UTC. `scheduled_start` is stored as an ISO
// timestamptz, so UTC ranges compare directly. `now` is injected for
// deterministic tests. End is exclusive (use with >= start, < end semantics).
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Days since Monday: getUTCDay() is 0=Sun..6=Sat; Monday-based is (day+6)%7.
function mondayOfWeek(d: Date): Date {
  const day = startOfUtcDay(d);
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * 86_400_000);
}

export function weekRange(now: Date, which: "this" | "next"): { startIso: string; endIso: string } {
  const thisMon = mondayOfWeek(now);
  const start = which === "this" ? thisMon : new Date(thisMon.getTime() + 7 * 86_400_000);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function dayRange(now: Date): { startIso: string; endIso: string } {
  const start = startOfUtcDay(now);
  const end = new Date(start.getTime() + 86_400_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}
