// Building footprints outside New York City, from Microsoft's Global ML Building Footprints (traced
// from aerial imagery; https://github.com/microsoft/GlobalMLBuildingFootprints). New York City
// keeps its own, more exact footprints (addBuildings, NYC Open Data), so Microsoft's are used only
// outside the five boroughs, and only over the area riders explore (EXPLORATION), not the margin.
//
// The data is under the Open Database License, like OpenStreetMap's: the map credits it
// (mapStyle.ts's MAP_ATTRIBUTION, and Settings → About → Map data).
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { EXPLORATION } from './bounds.mjs';
import { orient, pointInRing, ringBounds } from './geometry.mjs';
import { readShapefileZip } from './shapefile.mjs';
import { addPolygons } from './sources.mjs';

const INDEX = 'https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv';
/** The dataset's files each cover one square of this zoom (a Bing Maps quadkey). */
const QUADKEY_ZOOM = 9;
/** Buildings show from this zoom (MapLibre's), like New York City's. */
const BUILDING_MINZOOM = 14;
/** The five boroughs' county codes, whose buildings come from NYC Open Data instead. */
const NYC_COUNTIES = new Set(['36005', '36047', '36061', '36081', '36085']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function quadkey(x, y, z) {
  let key = '';
  for (let i = z; i > 0; i -= 1) {
    const mask = 1 << (i - 1);
    key += String((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
  }
  return key;
}

/** The quadkeys of the squares over the explored area. */
function quadkeysOver({ west, south, east, north }) {
  const n = 2 ** QUADKEY_ZOOM;
  const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  const keys = new Set();
  for (let x = tx(west); x <= tx(east); x += 1) for (let y = ty(north); y <= ty(south); y += 1) keys.add(quadkey(x, y, QUADKEY_ZOOM));
  return keys;
}

async function fetchFile(url, path) {
  if (existsSync(path)) return;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(`${path}.partial`));
      renameSync(`${path}.partial`, path);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(15_000 * (attempt + 1));
    }
  }
}

/** Fetches the footprints over the explored area into <dir>/msbuildings (files already there are kept). */
export async function downloadMsBuildings(dir, log = console.log) {
  const out = join(dir, 'msbuildings');
  mkdirSync(out, { recursive: true });
  const response = await fetch(INDEX);
  if (!response.ok) throw new Error(`${INDEX}: HTTP ${response.status}`);
  const keys = quadkeysOver(EXPLORATION);
  const rows = (await response.text()).split('\n').map((line) => line.split(','))
    .filter(([location, key]) => location === 'UnitedStates' && keys.has(key));
  log(`Fetching Microsoft building footprints in ${rows.length} files...`);
  for (const [index, [, key, url]] of rows.entries()) {
    const part = url.split('/').pop().split('-')[1] ?? String(index);
    try {
      await fetchFile(url, join(out, `${key}_${part}.csv.gz`));
    } catch (error) {
      log(`  ${key}: ${error.message}; skipped (run the download again to retry)`);
    }
    if ((index + 1) % 5 === 0) log(`  ${index + 1} of ${rows.length} files`);
  }
}

/** The five boroughs' outlines (from TIGER's counties), to leave New York City's buildings to its own data. */
function nycOutlines(tigerDir) {
  return readShapefileZip(join(tigerDir, 'tl_2025_us_county.zip'))
    .filter(({ props, shape }) => shape && NYC_COUNTIES.has(props.GEOID))
    .flatMap(({ shape }) => shape.parts.map((ring) => ({ ring, box: ringBounds(ring) })));
}

/** Adds the footprints to the building layer (outside New York City, inside the explored area). */
export async function addMsBuildings(store, msDir, tigerDir, log) {
  const files = existsSync(msDir) ? readdirSync(msDir).filter((name) => name.endsWith('.csv.gz')) : [];
  if (files.length === 0) {
    log(`  buildings (Microsoft): none in ${msDir}; skipped (npm run map:download fetches them)`);
    return;
  }
  const nyc = nycOutlines(tigerDir);
  const inNyc = (x, y) => nyc.some(({ ring, box }) => x >= box.west && x <= box.east && y >= box.south && y <= box.north && pointInRing(ring, x, y));
  const { west, south, east, north } = EXPLORATION;
  let count = 0;
  let skipped = 0;
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(join(msDir, file)).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      let feature;
      try {
        feature = JSON.parse(line);
      } catch {
        continue;
      }
      const geometry = feature.geometry;
      if (!geometry || geometry.type !== 'Polygon') continue;
      const outer = geometry.coordinates[0];
      if (!outer || outer.length < 4) continue;
      const [x, y] = outer[0];
      if (x < west || x > east || y < south || y > north) continue;
      if (inNyc(x, y)) {
        skipped += 1;
        continue;
      }
      const polygon = geometry.coordinates.map((ring, i) => orient(ring.slice(0, -1).flat(), i === 0)).filter((ring) => ring.length >= 6);
      if (polygon.length > 0 && addPolygons(store, 'building', BUILDING_MINZOOM, {}, [polygon]) >= 0) count += 1;
    }
  }
  log(`  buildings (Microsoft): ${count} (${skipped} in New York City left to its own)`);
}
