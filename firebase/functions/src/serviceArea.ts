/**
 * The app's service area: NYC, Nassau, Suffolk, Metro-North's destinations, and New Jersey (PATH, with
 * room for the rest of the state, from Cape May and Philadelphia's 30th Street to Port Jervis) as one rectangle. Mirrors
 * mobile/src/data/serviceArea.ts (a test keeps the two identical).
 */
export const SERVICE_AREA_BOUNDS = {
  north: 41.85,
  south: 38.9,
  east: -71.85,
  west: -75.6,
};

export function isInServiceArea(lat: number, lng: number): boolean {
  return lat >= SERVICE_AREA_BOUNDS.south && lat <= SERVICE_AREA_BOUNDS.north && lng >= SERVICE_AREA_BOUNDS.west && lng <= SERVICE_AREA_BOUNDS.east;
}
