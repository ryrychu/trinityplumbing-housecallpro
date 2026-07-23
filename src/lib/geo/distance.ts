const AVERILL_PARK_LAT = 42.6337;
const AVERILL_PARK_LNG = -73.5504;
const EARTH_RADIUS_MILES = 3958.8;

// Starting estimate for local/regional roads — tune against Ellah's real dispatch
// experience once a few weeks of jobs have gone through the dashboard.
const AVG_SPEED_MPH = 32;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function distanceFromAverillPark(lat: number, lng: number) {
  const dLat = toRadians(lat - AVERILL_PARK_LAT);
  const dLng = toRadians(lng - AVERILL_PARK_LNG);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(AVERILL_PARK_LAT)) * Math.cos(toRadians(lat)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const miles = EARTH_RADIUS_MILES * c;

  return {
    miles: Math.round(miles * 10) / 10,
    driveMinutes: Math.round((miles / AVG_SPEED_MPH) * 60),
  };
}

export function compassDirectionFromAverillPark(lat: number, lng: number): string {
  const dLat = toRadians(lat - AVERILL_PARK_LAT);
  const dLng = toRadians(lng - AVERILL_PARK_LNG);

  const y = Math.sin(dLng) * Math.cos(toRadians(lat));
  const x =
    Math.cos(toRadians(AVERILL_PARK_LAT)) * Math.sin(toRadians(lat)) -
    Math.sin(toRadians(AVERILL_PARK_LAT)) * Math.cos(toRadians(lat)) * Math.cos(dLng);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  const normalized = (bearing + 360) % 360;

  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(normalized / 45) % 8;
  return directions[index];
}
