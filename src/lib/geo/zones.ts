import { distanceFromAverillPark, compassDirectionFromAverillPark } from "./distance";
import { zoneForTown } from "./townZones";

// Town-first zone resolution. A known town wins (matches how the dispatcher
// thinks); otherwise fall back to distance/compass rules. Starting thresholds
// encode Ellah's informal dispatch zones from the roadmap doc — tune as real
// job data comes in.
export function classifyZone(
  lat: number,
  lng: number,
  town?: string | null
): { zone: string; compass: string; source: "town" | "distance" } {
  const compass = compassDirectionFromAverillPark(lat, lng);

  const townZone = zoneForTown(town);
  if (townZone) {
    return { zone: townZone, compass, source: "town" };
  }

  const { miles } = distanceFromAverillPark(lat, lng);

  if (miles <= 15) return { zone: "Albany Zone", compass, source: "distance" };
  // North Route extends farther: Glens Falls (~46 mi due north) is regular.
  if ((compass === "N" || compass === "NW") && miles <= 50) return { zone: "North Route", compass, source: "distance" };
  if ((compass === "E" || compass === "SE") && miles <= 35) return { zone: "Southern Berkshire Route", compass, source: "distance" };
  if ((compass === "NE" || compass === "E") && miles > 15 && miles <= 40) return { zone: "Vermont Route", compass, source: "distance" };
  if (miles <= 40) return { zone: "Extended Service Area", compass, source: "distance" };
  return { zone: "Outside Service Area", compass, source: "distance" };
}
