// Named places close up, from OpenStreetMap: restaurants, cafes, shops, hotels, libraries, campus
// halls, and other named buildings, read from <data-dir>/osm/venues1_pbf_<state>.ndjson (osmpbf.mjs,
// from Geofabrik's state extracts) into the `venue` layer. The map shows them only once a street
// fills the screen (mapStyle.ts's venueLayers: zoom 16, and 17 for shops and restaurants), the way
// Google's map names every storefront only when you're close.
//
// OpenStreetMap data is © OpenStreetMap contributors, under the Open Database License: the map
// credits it (mapStyle.ts's MAP_ATTRIBUTION, shown by MapCredit, and Settings → About).
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { DETAIL, MAX_ZOOM } from './bounds.mjs';
import { insideBox } from './geometry.mjs';
import { VENUES_PREFIX } from './osmpbf.mjs';
import { nameKey } from './schema.mjs';
import { POINT } from './store.mjs';

/** Each kind's rank (lower wins a crowded spot) and, for the small ones, the zoom it shows from (`lz`). */
const KINDS = {
  civic: { rank: 30 },
  lodging: { rank: 32 },
  leisure: { rank: 34 },
  building: { rank: 40 },
  food: { rank: 50, lz: 17 },
  health: { rank: 52, lz: 17 },
  shop: { rank: 56, lz: 17 },
  bank: { rank: 58, lz: 17 },
};

/** About 60 m: a shop drawn as a point inside its own named outline is labeled once. */
const SAME_PLACE = 0.0007;

const venueFiles = (osmDir) => (existsSync(osmDir) ? readdirSync(osmDir).filter((name) => name.startsWith(VENUES_PREFIX) && name.endsWith('.ndjson')).sort() : []);

/**
 * Adds the named places to the `venue` layer: once each (states' extracts overlap at their
 * borders), and not where the map already names the same place nearby (a landmark, a station, a park).
 */
export async function addOsmVenues(store, osmDir, log) {
  const files = venueFiles(osmDir);
  if (files.length === 0) {
    log(`  named places (OpenStreetMap): none in ${osmDir}; skipped (npm run map:download reads them)`);
    return false;
  }
  // Names already on the map, bucketed by name and a coarse grid square.
  const named = new Map();
  const cell = (x, y) => `${Math.floor(x / SAME_PLACE)},${Math.floor(y / SAME_PLACE)}`;
  const remember = (key, x, y) => {
    const id = `${key}|${cell(x, y)}`;
    named.set(id, true);
  };
  const near = (key, x, y) => {
    const cx = Math.floor(x / SAME_PLACE);
    const cy = Math.floor(y / SAME_PLACE);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) if (named.has(`${key}|${cx + dx},${cy + dy}`)) return true;
    return false;
  };
  for (let index = 0; index < store.count; index += 1) {
    if (store.deleted.array[index] || store.type.array[index] !== POINT) continue;
    const name = store.propsOf(index).name;
    if (!name) continue;
    const { west, south } = store.boundsOf(index);
    remember(nameKey(name), west, south);
  }
  const seen = new Set();
  // Points first, then outlines: a hall's own point beats the middle of its roof.
  const venues = [];
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(join(osmDir, file)), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const [id, kind, name, x, y] = JSON.parse(line);
      if (seen.has(id) || !KINDS[kind] || !insideBox(DETAIL, x, y)) continue;
      seen.add(id);
      venues.push({ id, kind, name: name.trim(), x, y });
    }
  }
  venues.sort((a, b) => (a.id[0] === b.id[0] ? 0 : a.id[0] === 'n' ? -1 : 1));
  const counts = {};
  let alreadyNamed = 0;
  for (const { kind, name, x, y } of venues) {
    if (!name || name.length > 60) continue;
    const key = nameKey(name);
    if (!key || near(key, x, y)) {
      alreadyNamed += 1;
      continue;
    }
    remember(key, x, y);
    const { rank, lz } = KINDS[kind];
    store.add('venue', POINT, MAX_ZOOM, lz ? { kind, name, rank, lz } : { kind, name, rank }, [[x, y]]);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  log(`  named places (OpenStreetMap): ${total} (${Object.entries(counts).map(([kind, n]) => `${n} ${kind}`).join(', ')}; ${alreadyNamed} already named left out)`);
  return total > 0;
}
