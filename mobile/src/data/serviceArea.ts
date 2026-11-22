/**
 * Rectangular bounding box covering NYC's five boroughs, Nassau County, Suffolk County
 * (Montauk to the North Fork), the Metro-North Railroad's station network, and New Jersey, where
 * PATH runs, with room for the rest of the state (Cape May and Philadelphia's 30th Street to Port Jervis). A rectangle is
 * necessarily an approximation of these areas' actual shapes — it also takes in parts of
 * Pennsylvania, Delaware, CT, the Sound and the ocean that fall inside the box. This is the transit/search coverage boundary; the map's
 * camera uses the larger MAP_EXPLORATION_BOUNDS below.
 */
export const SERVICE_AREA_BOUNDS = {
  north: 41.85,
  south: 38.9,
  east: -71.85,
  west: -75.6,
};

/**
 * Room to browse around everything Pathly serves without changing route/search coverage: about a
 * degree past Metro-North's reach (Poughkeepsie and Wassaic up the Hudson and Harlem lines, New
 * Haven and Waterbury in Connecticut, Port Jervis west of the Hudson), past Montauk to the east, and
 * past New Jersey to the south and west (Cape May, Philadelphia).
 * Both maps keep their center inside this box; the edges of the view can go beyond it.
 */
export const MAP_EXPLORATION_BOUNDS = {
  north: 43.0,
  south: 37.9,
  east: -71.0,
  west: -76.6,
};

/** Default map center before the user's real location is known or if permission is denied. */
export const SERVICE_AREA_FALLBACK = { latitude: 40.9157, longitude: -73.124 };
