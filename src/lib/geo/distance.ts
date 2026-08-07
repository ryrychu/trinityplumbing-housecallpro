const AVERILL_PARK_LAT = 42.6337;
const AVERILL_PARK_LNG = -73.5504;
const EARTH_RADIUS_MILES = 3958.8;

// Starting estimate for local/regional roads — tune against Ellah's real dispatch
// experience once a few weeks of jobs have gone through the dashboard.
const AVG_SPEED_MPH = 32;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

// Great-circle miles between any two points. Straight-line, not road distance —
// good enough to answer "is this near that", which is all the nearby-work
// lookup asks of it. A real routing distance would need a paid API and would
// change the answer by a mile or two on a question whose threshold is already
// a judgement call.
export function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

export function driveMinutesForMiles(miles: number): number {
  return Math.round((miles / AVG_SPEED_MPH) * 60);
}

export function distanceFromAverillPark(lat: number, lng: number) {
  const miles = milesBetween(AVERILL_PARK_LAT, AVERILL_PARK_LNG, lat, lng);
  return {
    miles: Math.round(miles * 10) / 10,
    driveMinutes: driveMinutesForMiles(miles),
  };
}

// True initial bearing from Averill Park, in degrees clockwise from north
// (0 = due north, 90 = due east). The dispatch dial plots jobs at their real
// angle, so it needs the continuous value; compassDirectionFromAverillPark
// below buckets this same number into the eight names a dispatcher says out
// loud. Both must come from one implementation — a second copy of the
// spherical bearing formula is how the dial and the run sheet would start
// disagreeing about which way a job is.
export function bearingFromAverillPark(lat: number, lng: number): number {
  const dLng = toRadians(lng - AVERILL_PARK_LNG);

  const y = Math.sin(dLng) * Math.cos(toRadians(lat));
  const x =
    Math.cos(toRadians(AVERILL_PARK_LAT)) * Math.sin(toRadians(lat)) -
    Math.sin(toRadians(AVERILL_PARK_LAT)) * Math.cos(toRadians(lat)) * Math.cos(dLng);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

export function compassDirectionFromAverillPark(lat: number, lng: number): string {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(bearingFromAverillPark(lat, lng) / 45) % 8;
  return directions[index];
}
