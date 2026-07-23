import { distanceFromAverillPark, compassDirectionFromAverillPark } from "./distance";

// Starting thresholds — these encode Ellah's informal dispatch zones from the
// roadmap doc. Tune the mile/compass ranges as real job data comes in.
export function classifyZone(lat: number, lng: number) {
  const { miles } = distanceFromAverillPark(lat, lng);
  const compass = compassDirectionFromAverillPark(lat, lng);

  if (miles <= 15) {
    return { zone: "Albany Zone", compass };
  }

  // North Route extends farther than the other spokes: Glens Falls (~46 mi due
  // north) is a regular destination, so the cap is 50 mi rather than 40.
  if ((compass === "N" || compass === "NW") && miles <= 50) {
    return { zone: "North Route", compass };
  }

  if ((compass === "E" || compass === "SE") && miles <= 35) {
    return { zone: "Southern Berkshire Route", compass };
  }

  if ((compass === "NE" || compass === "E") && miles > 15 && miles <= 40) {
    return { zone: "Vermont Route", compass };
  }

  if (miles <= 40) {
    return { zone: "Extended Service Area", compass };
  }

  return { zone: "Outside Service Area", compass };
}
