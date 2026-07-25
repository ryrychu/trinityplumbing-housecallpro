// Full literal class strings per zone — Tailwind's content scanner only keeps
// classes it finds verbatim in source, so these must not be composed at runtime.
//
// Keys must stay in sync with every zone classifyZone() can return
// (src/lib/geo/zones.ts + the town table in src/lib/geo/townZones.ts).
const ZONE_STYLES: Record<string, string> = {
  "Albany Zone": "bg-brand-tint text-brand",
  "North Route": "bg-info-tint text-info",
  "Vermont Route": "bg-success-tint text-success",
  "Southern Berkshire Route": "bg-warn-tint text-warn",
  "Extended Service Area": "bg-surface-elevated text-ink-muted",
  // Beyond the routine service radius — worth flagging, not just neutral.
  "Outside Service Area": "bg-danger-tint text-danger",
};
const UNKNOWN_STYLE = "bg-surface-elevated text-ink-faint";

export function ZoneBadge({ zone }: { zone: string }) {
  const style = ZONE_STYLES[zone] ?? UNKNOWN_STYLE;
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${style}`}
    >
      {zone}
    </span>
  );
}
