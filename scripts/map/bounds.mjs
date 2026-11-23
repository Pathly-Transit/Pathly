// Where Pathly's base map has data, and the tile math used to cut it up (Web Mercator, as every
// map renderer expects).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reads a bounds constant from the app, so the map covers exactly what the app lets riders explore. */
function appBounds(name) {
  const source = readFileSync(join(ROOT, 'mobile/src/data/serviceArea.ts'), 'utf8');
  const match = source.match(new RegExp(`export const ${name} = \\{([^}]*)\\}`));
  if (!match) throw new Error(`${name} not found in mobile/src/data/serviceArea.ts`);
  const bounds = {};
  for (const [, key, value] of match[1].matchAll(/(north|south|east|west):\s*(-?[\d.]+)/g)) bounds[key] = Number(value);
  if (!['north', 'south', 'east', 'west'].every((key) => Number.isFinite(bounds[key]))) throw new Error(`${name} is incomplete`);
  return bounds;
}

export const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export function lat2y(lat, z) {
  const sin = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** z;
}
export const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
export const y2lat = (y, z) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z));

/** A tile's bounds in degrees. */
export const tileBounds = (z, x, y) => ({ west: x2lon(x, z), east: x2lon(x + 1, z), north: y2lat(y, z), south: y2lat(y + 1, z) });

/** The tiles at zoom z that touch a box. */
export function tilesIn(bounds, z) {
  const max = 2 ** z - 1;
  const clamp = (v) => Math.max(0, Math.min(max, v));
  return {
    minX: clamp(Math.floor(lon2x(bounds.west, z))),
    maxX: clamp(Math.floor(lon2x(bounds.east, z) - 1e-9)),
    minY: clamp(Math.floor(lat2y(bounds.north, z))),
    maxY: clamp(Math.floor(lat2y(bounds.south, z) - 1e-9)),
  };
}

/** The camera's bounds in the app: its center can't leave this box. */
export const EXPLORATION = appBounds('MAP_EXPLORATION_BOUNDS');

/** Zoom levels are MapLibre's (512-pixel tiles); the app shows them one higher (mapTypes.ts). */
export const MAX_ZOOM = 14;
/** The zoom detail tiles are built in batches of: one batch per tile at this zoom. */
export const CHUNK_ZOOM = 10;

/**
 * The detailed map: streets, buildings, water, and places from the government and other public
 * sources, a little past the exploration box on every side and squared up to whole zoom-10 tiles
 * (so its edge falls on tile edges). All of that data is cut to this box.
 */
const DETAIL_MARGIN = 0.3;
export const DETAIL = {
  west: x2lon(Math.floor(lon2x(EXPLORATION.west - DETAIL_MARGIN, CHUNK_ZOOM)), CHUNK_ZOOM),
  east: x2lon(Math.ceil(lon2x(EXPLORATION.east + DETAIL_MARGIN, CHUNK_ZOOM)), CHUNK_ZOOM),
  north: y2lat(Math.floor(lat2y(EXPLORATION.north + DETAIL_MARGIN, CHUNK_ZOOM)), CHUNK_ZOOM),
  south: y2lat(Math.ceil(lat2y(EXPLORATION.south - DETAIL_MARGIN, CHUNK_ZOOM)), CHUNK_ZOOM),
};

/**
 * The overview: what a zoomed-out map can show around the detailed area (coastlines, lakes, state
 * lines, highways, and cities from Natural Earth), wide enough to fill the screen at the app's
 * farthest zoom from anywhere the camera can go.
 */
export const OVERVIEW = {
  west: EXPLORATION.west - 5,
  east: EXPLORATION.east + 5,
  north: EXPLORATION.north + 4,
  south: EXPLORATION.south - 4,
};

/** Every overview tile up to this zoom is built; above it, only tiles a screen can reach. */
export const OVERVIEW_MAX_ZOOM = 8;

/**
 * How far past the exploration box a screen reaches at zoom z: half of a large tablet's screen
 * (800 points) either way. Tiles there are built even outside the detailed area (overview data
 * only), so a zoomed-out map at the box's edge never shows a blank.
 */
export function reach(z) {
  const lon = (800 * 360) / (512 * 2 ** z);
  const lat = lon * Math.cos((EXPLORATION.south * Math.PI) / 180);
  return {
    west: Math.max(OVERVIEW.west, EXPLORATION.west - lon),
    east: Math.min(OVERVIEW.east, EXPLORATION.east + lon),
    north: Math.min(OVERVIEW.north, EXPLORATION.north + lat),
    south: Math.max(OVERVIEW.south, EXPLORATION.south - lat),
  };
}

/** The tile ranges built at zoom z (one range, or two when the reach pokes past the detailed area). */
export function tileRangesAt(z) {
  if (z <= OVERVIEW_MAX_ZOOM) return [tilesIn(OVERVIEW, z)];
  return [tilesIn(DETAIL, z), tilesIn(reach(z), z)];
}

export function hasTile(z, x, y) {
  return tileRangesAt(z).some((r) => x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY);
}

/** The overview outside the detailed area, as four boxes (west, east, and the strips north and south). */
export const OVERVIEW_STRIPS = [
  { west: OVERVIEW.west, east: DETAIL.west, south: OVERVIEW.south, north: OVERVIEW.north },
  { west: DETAIL.east, east: OVERVIEW.east, south: OVERVIEW.south, north: OVERVIEW.north },
  { west: DETAIL.west, east: DETAIL.east, south: DETAIL.north, north: OVERVIEW.north },
  { west: DETAIL.west, east: DETAIL.east, south: OVERVIEW.south, north: DETAIL.south },
];
