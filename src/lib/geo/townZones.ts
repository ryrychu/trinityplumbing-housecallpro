// Town/city -> dispatch zone. The authoritative zone signal for a job; when a
// town is absent from this table, callers fall back to distance/compass rules
// (see zones.ts). Seeded from the roadmap's example zones and common Capital
// District towns; extend as real job towns appear (see the census in Step 5).
export const TOWN_ZONES: Record<string, string> = {
  "averill park": "Albany Zone",
  "albany": "Albany Zone",
  "delmar": "Albany Zone",
  "slingerlands": "Albany Zone",
  "troy": "Albany Zone",
  "east greenbush": "Albany Zone",
  "rensselaer": "Albany Zone",
  "wynantskill": "Albany Zone",
  "saratoga springs": "North Route",
  "glens falls": "North Route",
  "ballston spa": "North Route",
  "queensbury": "North Route",
  "bennington": "Vermont Route",
  "manchester": "Vermont Route",
  "pownal": "Vermont Route",
  "pittsfield": "Southern Berkshire Route",
  "great barrington": "Southern Berkshire Route",
  "williamstown": "Southern Berkshire Route",
};

export function zoneForTown(town: string | null | undefined): string | null {
  if (!town) return null;
  return TOWN_ZONES[town.trim().toLowerCase()] ?? null;
}
