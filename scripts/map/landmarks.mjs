// Landmarks from OpenStreetMap: the stadiums, malls, museums, zoos, and sights people find their way
// by, as named points in the `landmark` layer. Only places with a Wikidata entry come along, which
// keeps it to the notable ones (a city's big museum, not every gallery), the way Google's map names
// landmarks long before it shows every shop. Campuses, hospitals, cemeteries, parks, and stations
// are named from their own sources (sources.mjs), so they're left out here.
//
// OpenStreetMap data is © OpenStreetMap contributors, under the Open Database License: the map
// credits it (mapStyle.ts's source attribution, and Settings → About → Map data).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DETAIL } from './bounds.mjs';
import { insideBox } from './geometry.mjs';
import { nameKey } from './schema.mjs';
import { POINT } from './store.mjs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
/** Squares this many degrees on a side (few landmarks fit in one, so they're big). */
const STEP = 1;
/** The fetched squares' file prefix; bumped when what's kept changes, so older fetches are ignored. */
const PREFIX = 'landmarks1_';

/**
 * Kinds of landmark: the zoom (MapLibre's) each shows from, and its rank (lower wins a crowded
 * spot). Big venues first; museums and sights at street level.
 */
export const LANDMARK_KINDS = {
  stadium: { minzoom: 13, rank: 10 },
  zoo: { minzoom: 13, rank: 12 },
  aquarium: { minzoom: 13, rank: 12 },
  theme_park: { minzoom: 13, rank: 12 },
  mall: { minzoom: 13, rank: 14 },
  museum: { minzoom: 14, rank: 20 },
  theatre: { minzoom: 14, rank: 24 },
  attraction: { minzoom: 14, rank: 26 },
};

function query({ west, south, east, north }) {
  const box = `${south},${west},${north},${east}`;
  return `[out:json][timeout:180];
(
  nwr["wikidata"]["name"]["leisure"="stadium"](${box});
  nwr["wikidata"]["name"]["shop"="mall"](${box});
  nwr["wikidata"]["name"]["tourism"~"^(museum|gallery|zoo|aquarium|theme_park|attraction)$"](${box});
  nwr["wikidata"]["name"]["amenity"~"^(theatre|arts_centre|events_venue)$"](${box});
);
out tags center qt;`;
}

/** A landmark's kind from its tags, or undefined for one this map names some other way. */
function kindOf(tags) {
  // A park, a garden, water, a bridge, or a street that's also tagged as a sight is already on the map.
  if (tags.highway || tags.railway || tags.natural || tags.waterway || tags.place || tags.boundary || tags.bridge || tags.public_transport) return undefined;
  if (/^(park|garden|nature_reserve|playground|pitch)$/.test(tags.leisure ?? '')) return undefined;
  if (/^(university|college|school|hospital|grave_yard|place_of_worship)$/.test(tags.amenity ?? '')) return undefined;
  if (tags.leisure === 'stadium') return 'stadium';
  if (tags.shop === 'mall') return 'mall';
  if (tags.tourism === 'zoo') return 'zoo';
  if (tags.tourism === 'aquarium') return 'aquarium';
  if (tags.tourism === 'theme_park') return 'theme_park';
  if (tags.tourism === 'museum' || tags.tourism === 'gallery') return 'museum';
  if (/^(theatre|arts_centre|events_venue)$/.test(tags.amenity ?? '')) return 'theatre';
  if (tags.tourism === 'attraction') return 'attraction';
  return undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One square's landmarks as [kind, name, lon, lat]. */
async function fetchSquare(box) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(OVERPASS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Pathly map build' },
        body: `data=${encodeURIComponent(query(box))}`,
      });
      if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) {
        await sleep(15_000 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark);
      const out = [];
      for (const element of json.elements) {
        const tags = element.tags ?? {};
        const kind = kindOf(tags);
        const lon = element.lon ?? element.center?.lon;
        const lat = element.lat ?? element.center?.lat;
        if (!kind || lon === undefined || lat === undefined) continue;
        out.push([kind, tags.name, Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
      }
      return out;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(10_000);
    }
  }
  throw new Error('the server stayed busy');
}

/** Fetches the detailed area's landmarks into <dir>/osm (squares already there are kept). */
export async function downloadOsmLandmarks(dir, log = console.log) {
  const out = join(dir, 'osm');
  mkdirSync(out, { recursive: true });
  let total = 0;
  for (let west = DETAIL.west; west < DETAIL.east; west += STEP) {
    for (let south = DETAIL.south; south < DETAIL.north; south += STEP) {
      const box = { west, south, east: Math.min(west + STEP, DETAIL.east), north: Math.min(south + STEP, DETAIL.north) };
      const path = join(out, `${PREFIX}${box.west.toFixed(4)}_${box.south.toFixed(4)}_${box.east.toFixed(4)}_${box.north.toFixed(4)}.json`);
      if (existsSync(path)) continue;
      try {
        const landmarks = await fetchSquare(box);
        writeFileSync(`${path}.partial`, JSON.stringify(landmarks));
        renameSync(`${path}.partial`, path);
        total += landmarks.length;
      } catch (error) {
        log(`  landmarks ${path}: ${error.message}; skipped (run the download again to retry)`);
      }
      // A pause between requests, as the Overpass API asks of bulk users.
      await sleep(2_000);
    }
  }
  log(`  ${total} landmarks fetched`);
}

/** Adds the fetched landmarks to the `landmark` layer (one per name nearby, since a place can be both a point and an outline). */
export function addOsmLandmarks(store, osmDir, log) {
  if (!existsSync(osmDir)) return;
  const placed = new Map();
  let count = 0;
  for (const file of readdirSync(osmDir).filter((name) => name.startsWith(PREFIX) && name.endsWith('.json'))) {
    for (const [kind, name, x, y] of JSON.parse(readFileSync(join(osmDir, file), 'utf8'))) {
      if (!insideBox(DETAIL, x, y)) continue;
      const key = nameKey(name);
      const near = placed.get(key) ?? [];
      if (near.some((p) => Math.abs(p.x - x) < 0.005 && Math.abs(p.y - y) < 0.004)) continue;
      near.push({ x, y });
      placed.set(key, near);
      const { minzoom, rank } = LANDMARK_KINDS[kind];
      store.add('landmark', POINT, minzoom, { kind, name, rank }, [[x, y]]);
      count += 1;
    }
  }
  log(`  landmarks (OpenStreetMap): ${count}`);
}
