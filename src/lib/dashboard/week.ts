// Mon–Sun week and day boundaries in America/New_York (Trinity's local time),
// returned as UTC ISO instants so they compare directly against `scheduled_start`
// (stored as timestamptz/ISO UTC). `now` is injected for deterministic tests.
// End is exclusive. DST-safe: every boundary is derived from the tz offset at
// that specific calendar day.
const TZ = "America/New_York";

function tzOffsetMs(instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) m[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(m.year),
    Number(m.month) - 1,
    Number(m.day),
    Number(m.hour),
    Number(m.minute),
    Number(m.second)
  );
  return asUtc - instant.getTime();
}

// UTC instant of local (TZ) midnight for calendar day y/m0/d.
function localMidnightUtc(y: number, m0: number, d: number): Date {
  const guess = Date.UTC(y, m0, d, 0, 0, 0);
  const off = tzOffsetMs(new Date(guess));
  return new Date(guess - off);
}

// Local calendar Y/M/D + weekday (0=Sun..6=Sat) for an instant.
function localCal(instant: Date): { y: number; m0: number; d: number; dow: number } {
  const off = tzOffsetMs(instant);
  const local = new Date(instant.getTime() + off);
  return {
    y: local.getUTCFullYear(),
    m0: local.getUTCMonth(),
    d: local.getUTCDate(),
    dow: local.getUTCDay(),
  };
}

// Add `days` calendar days to y/m0/d, normalized.
function addDays(y: number, m0: number, d: number, days: number): { y: number; m0: number; d: number } {
  const t = new Date(Date.UTC(y, m0, d + days));
  return { y: t.getUTCFullYear(), m0: t.getUTCMonth(), d: t.getUTCDate() };
}

export function weekRange(now: Date, which: "this" | "next"): { startIso: string; endIso: string } {
  const { y, m0, d, dow } = localCal(now);
  const offsetDays = (dow + 6) % 7; // days since Monday (local)
  const monday = addDays(y, m0, d, -offsetDays + (which === "next" ? 7 : 0));
  const start = localMidnightUtc(monday.y, monday.m0, monday.d);
  const endCal = addDays(monday.y, monday.m0, monday.d, 7);
  const end = localMidnightUtc(endCal.y, endCal.m0, endCal.d);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function dayRange(now: Date): { startIso: string; endIso: string } {
  const { y, m0, d } = localCal(now);
  const start = localMidnightUtc(y, m0, d);
  const next = addDays(y, m0, d, 1);
  const end = localMidnightUtc(next.y, next.m0, next.d);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}
