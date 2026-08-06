"use client";

// Business timezone, not the server's. Vercel runs UTC, and a tech reading
// "showing data from 8:42" needs that clock read in America/New_York or the
// number is simply wrong for anyone in the field.
const BUSINESS_TIME_ZONE = "America/New_York";

function relative(iso: string): string {
  const ageMs = Date.now() - Date.parse(iso);
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function FreshnessStamp({
  generatedAt,
  fromCache,
  mirrorSyncedAt = null,
  staleAfterMinutes = null,
}: {
  generatedAt: string | null;
  fromCache: boolean;
  mirrorSyncedAt?: string | null;
  staleAfterMinutes?: number | null;
}) {
  // Null means no successful fetch has landed yet (first paint, or every
  // attempt errored). Saying nothing beats guessing an age for data that
  // was never received.
  if (!generatedAt) return null;

  if (fromCache) {
    // The service worker served this from its cache, which only happens when
    // the network request failed -- i.e. offline. Here `generatedAt` IS the
    // right timestamp, and the only one available: it dates the moment this
    // device last held the data. Mirror age is a server-side fact this device
    // cannot currently re-check, so claiming it would be asserting something
    // unverifiable. This path is unchanged on purpose.
    const clock = new Date(generatedAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: BUSINESS_TIME_ZONE,
    });
    return <p className="text-xs text-warn">Offline — showing data from {clock}</p>;
  }

  // Online. The interesting question is not "when did this request happen"
  // (always seconds ago) but "how old is the data behind it" -- a request
  // served in 40ms from a mirror last synced on Tuesday is a fast lie.
  if (mirrorSyncedAt) {
    const ageMinutes = Math.floor((Date.now() - Date.parse(mirrorSyncedAt)) / 60_000);
    const stale = staleAfterMinutes != null && ageMinutes > staleAfterMinutes;

    if (stale) {
      // A visible warning rather than a quiet grey line: past the route's own
      // threshold, something is actually wrong upstream (most likely the cron
      // has stopped), and every number on the screen is older than it looks.
      return (
        <p role="status" className="text-xs font-semibold text-warn">
          ⚠ Sync is behind — data is {relative(mirrorSyncedAt)}
        </p>
      );
    }
    return <p className="text-xs text-ink-faint">Synced {relative(mirrorSyncedAt)}</p>;
  }

  // No mirror age available: sync_cursors was empty or unreadable, or this is
  // a cached response predating the field. Degrade to the old request-time
  // wording rather than claiming a freshness we could not establish.
  return <p className="text-xs text-ink-faint">Updated {relative(generatedAt)}</p>;
}
