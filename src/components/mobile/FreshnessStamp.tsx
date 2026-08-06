"use client";

// Business timezone, not the server's. Vercel runs UTC, and a tech reading
// "showing data from 8:42" needs that clock read in America/New_York or the
// number is simply wrong for anyone in the field.
const BUSINESS_TIME_ZONE = "America/New_York";

function relative(generatedAt: string): string {
  const ageMs = Date.now() - Date.parse(generatedAt);
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
}: {
  generatedAt: string | null;
  fromCache: boolean;
}) {
  // Null means no successful fetch has landed yet (first paint, or every
  // attempt errored). Saying nothing beats guessing an age for data that
  // was never received.
  if (!generatedAt) return null;

  if (fromCache) {
    // The service worker (Task 11) served this from its cache, which only
    // happens when the network request failed -- i.e. offline. The product
    // promise is that the app never implies data is current when it isn't,
    // so this state gets its own sentence and its own color rather than
    // reusing the relative-time copy below.
    const clock = new Date(generatedAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: BUSINESS_TIME_ZONE,
    });
    return (
      <p className="text-xs text-warn">Offline — showing data from {clock}</p>
    );
  }
  return <p className="text-xs text-ink-faint">Updated {relative(generatedAt)}</p>;
}
