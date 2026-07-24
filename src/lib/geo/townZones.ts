// Town/city -> dispatch zone. The authoritative zone signal for a job; when a
// town is absent from this table, callers fall back to distance/compass rules
// (see zones.ts). Finalized from a live census of Trinity's customer cities
// (2026-07-24) with the owner's routing decisions: NE border towns (Hoosick
// Falls / Cambridge / Greenwich) dispatch as Albany Zone; Schenectady/Niskayuna
// fold into Albany Zone; low-frequency outliers (Amsterdam W, Valatie S) are
// intentionally omitted so the distance fallback classifies them. Extend as new
// regular towns appear.
export const TOWN_ZONES: Record<string, string> = {
  // Albany Zone — core Capital District, close-in
  "averill park": "Albany Zone",
  "albany": "Albany Zone",
  "troy": "Albany Zone",
  "schenectady": "Albany Zone",
  "rensselaer": "Albany Zone",
  "cohoes": "Albany Zone",
  "latham": "Albany Zone",
  "colonie": "Albany Zone",
  "delmar": "Albany Zone",
  "niskayuna": "Albany Zone",
  "watervliet": "Albany Zone",
  "menands": "Albany Zone",
  "green island": "Albany Zone",
  "waterford": "Albany Zone",
  "slingerlands": "Albany Zone",
  "wynantskill": "Albany Zone",
  "east greenbush": "Albany Zone",
  "castleton-on-hudson": "Albany Zone",
  "selkirk": "Albany Zone",
  "glenmont": "Albany Zone",
  "voorheesville": "Albany Zone",
  "ravena": "Albany Zone",
  "coeymans hollow": "Albany Zone",
  "nassau": "Albany Zone",
  "altamont": "Albany Zone",
  // NE border towns — owner routes these as Albany Zone
  "hoosick falls": "Albany Zone",
  "cambridge": "Albany Zone",
  "greenwich": "Albany Zone",
  // North Route — Saratoga and north
  "clifton park": "North Route",
  "ballston lake": "North Route",
  "ballston spa": "North Route",
  "saratoga springs": "North Route",
  "mechanicville": "North Route",
  "rexford": "North Route",
  "glens falls": "North Route",
  "queensbury": "North Route",
  // Vermont Route — NE into VT
  "bennington": "Vermont Route",
  "manchester": "Vermont Route",
  "pownal": "Vermont Route",
  // Southern Berkshire Route — E into MA
  "pittsfield": "Southern Berkshire Route",
  "great barrington": "Southern Berkshire Route",
  "williamstown": "Southern Berkshire Route",
  "stephentown": "Southern Berkshire Route",
};

export function zoneForTown(town: string | null | undefined): string | null {
  if (!town) return null;
  return TOWN_ZONES[town.trim().toLowerCase()] ?? null;
}
