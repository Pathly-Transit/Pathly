#!/usr/bin/env node
// Builds Pathly's base map: vector tiles for New York City, Long Island, and the region around them,
// from public-domain government data (see scripts/map/sources.mjs) plus OpenStreetMap's footpaths
// (scripts/map/osm.mjs) and Microsoft's building footprints outside NYC (scripts/map/msbuildings.mjs),
// cut by Pathly's own tiler. The
// tiles go to maptiles/tiles/{z}/{x}/{y}.pbf (gitignored), and `npm run build:site` publishes them
// at pathly.web.app/map/. Rebuild every few months as the sources update.
//
//   node scripts/build-map.mjs download <data-dir>   fetch the sources (~1 GB) into <data-dir>
//   node --max-old-space-size=8192 scripts/build-map.mjs build <data-dir> [--tiles-only]
//                                                    build the tiles (--tiles-only reuses the
//                                                    features read last time)
//
// Labels need the map's fonts too: node scripts/build-map-fonts.mjs
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { DETAIL, EXPLORATION, MAX_ZOOM, OVERVIEW, ROOT } from './map/bounds.mjs';
import { boxesOverlap, ringBounds } from './map/geometry.mjs';
import { addOsmPaths, downloadOsmPaths } from './map/osm.mjs';
import { LAYERS } from './map/schema.mjs';
import { addMsBuildings, downloadMsBuildings } from './map/msbuildings.mjs';
import { readShapefileZip } from './map/shapefile.mjs';
import { TRANSIT_FEEDS, addBuildings, addGnisWaterNames, addLandAndStates, addLandmarks, addOverview, addPlaces, addRail, addRoads, addTransit, addWater, addWaterways, readWater } from './map/sources.mjs';
import { FeatureStore, POLYGON } from './map/store.mjs';
import { writeTiles } from './map/tiler.mjs';

const OUT = join(ROOT, 'maptiles');
const TIGER = 'https://www2.census.gov/geo/tiger/TIGER2025';
const STATE_CODES = { 36: 'NY', 34: 'NJ', '09': 'CT', 44: 'RI', 25: 'MA', 42: 'PA' };
const NATURAL_EARTH = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson';

async function fetchTo(url, path) {
  if (existsSync(path)) return;
  let response = await fetch(url);
  // The Census site turns away rapid downloads (HTTP 429): wait longer each time and ask again.
  for (let attempt = 1; response.status === 429 && attempt <= 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20_000 * attempt));
    response = await fetch(url);
  }
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const partial = `${path}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const { renameSync } = await import('node:fs');
  renameSync(partial, path);
}

async function download(dir) {
  for (const sub of ['tiger', 'county', 'gnis', 'nyc', 'ne', 'gtfs']) mkdirSync(join(dir, sub), { recursive: true });
  const jobs = [
    [`${TIGER}/COUNTY/tl_2025_us_county.zip`, 'tiger/tl_2025_us_county.zip'],
    [`${TIGER}/STATE/tl_2025_us_state.zip`, 'tiger/tl_2025_us_state.zip'],
    [`${TIGER}/RAILS/tl_2025_us_rails.zip`, 'tiger/tl_2025_us_rails.zip'],
    ['https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv', 'tiger/sub-est2024.csv'],
    ['https://data.cityofnewyork.us/api/views/5zhs-2jue/rows.csv?accessType=DOWNLOAD', 'nyc/buildings.csv'],
  ];
  for (const [code, state] of Object.entries(STATE_CODES)) {
    for (const kind of ['arealm', 'place', 'cousub']) jobs.push([`${TIGER}/${kind.toUpperCase()}/tl_2025_${code}_${kind}.zip`, `tiger/tl_2025_${code}_${kind}.zip`]);
    jobs.push([`https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_${state}_Text.zip`, `gnis/DomesticNames_${state}_Text.zip`]);
  }
  for (const name of ['ne_10m_land', 'ne_10m_lakes', 'ne_10m_roads', 'ne_10m_populated_places_simple']) jobs.push([`${NATURAL_EARTH}/${name}.geojson`, `ne/${name}.geojson`]);
  for (const [agency, { url }] of Object.entries(TRANSIT_FEEDS)) jobs.push([url, `gtfs/${agency}.zip`]);
  for (const [url, path] of jobs) {
    console.log(`Fetching ${path}`);
    try {
      await fetchTo(url, join(dir, path));
    } catch (error) {
      // A feed that refuses the download is left out (the build skips what's missing and says so).
      console.warn(`  ${error.message}; skipped`);
    }
  }
  // Every county the detailed area touches: its roads and water.
  const counties = readShapefileZip(join(dir, 'tiger/tl_2025_us_county.zip'))
    .filter(({ shape }) => shape && shape.parts.some((part) => boxesOverlap(ringBounds(part), DETAIL)))
    .map(({ props }) => props.GEOID);
  console.log(`Fetching roads and water for ${counties.length} counties...`);
  for (const geoid of counties) {
    for (const kind of ['roads', 'areawater', 'linearwater']) await fetchTo(`${TIGER}/${kind.toUpperCase()}/tl_2025_${geoid}_${kind}.zip`, join(dir, `county/tl_2025_${geoid}_${kind}.zip`));
  }
  await downloadOsmPaths(dir);
  await downloadMsBuildings(dir);
  console.log(`Sources ready in ${dir}.`);
}

async function build(dir, tilesOnly) {
  const cache = join(dir, 'features');
  const started = Date.now();
  const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);
  let store;
  if (tilesOnly && existsSync(join(cache, 'props.json'))) {
    store = FeatureStore.load(cache);
    log(`Loaded ${store.count} features from ${cache}`);
  } else {
    store = new FeatureStore();
    log('Reading sources...');
    const water = readWater(join(dir, 'county'));
    addLandAndStates(store, join(dir, 'tiger'), water, log);
    const waterNames = addWater(store, water, log);
    addWaterways(store, join(dir, 'county'), log);
    const landmarkNames = addLandmarks(store, join(dir, 'tiger'), log);
    const gnis = addPlaces(store, join(dir, 'tiger'), join(dir, 'gnis'), log);
    addGnisWaterNames(store, gnis, [...waterNames, ...landmarkNames], log);
    addRoads(store, join(dir, 'county'), log);
    addOsmPaths(store, join(dir, 'osm'), log);
    addRail(store, join(dir, 'tiger'), log);
    addTransit(store, join(dir, 'gtfs'), log);
    await addBuildings(store, join(dir, 'nyc/buildings.csv'), log);
    await addMsBuildings(store, join(dir, 'msbuildings'), join(dir, 'tiger'), log);
    addOverview(store, join(dir, 'ne'), log);
    store.save(cache);
    log(`${store.count} features (saved to ${cache})`);
  }
  // The sea: a square under everything, so the map's background (shown while tiles load) is land.
  const { west, south, east, north } = OVERVIEW;
  store.add('sea', POLYGON, 0, {}, [[west, south, east, south, east, north, west, north]], [true]);
  rmSync(join(OUT, 'tiles'), { recursive: true, force: true });
  const stats = writeTiles(store, join(OUT, 'tiles'), log);
  writeFileSync(join(OUT, 'metadata.json'), `${JSON.stringify({
    name: 'Pathly',
    format: 'pbf',
    minzoom: 0,
    maxzoom: MAX_ZOOM,
    bounds: [OVERVIEW.west, OVERVIEW.south, OVERVIEW.east, OVERVIEW.north],
    detailBounds: [DETAIL.west, DETAIL.south, DETAIL.east, DETAIL.north],
    explorationBounds: [EXPLORATION.west, EXPLORATION.south, EXPLORATION.east, EXPLORATION.north],
    layers: LAYERS,
    built: new Date().toISOString(),
    tiles: stats.tiles,
  }, null, 2)}\n`);
  log(`Wrote ${stats.tiles} tiles (${(stats.bytes / 1e6).toFixed(0)} MB; ${stats.empty} empty; largest ${(stats.largest / 1e3).toFixed(0)} KB at ${stats.largestTile}) to ${join(OUT, 'tiles')}`);
}

const [command, dir, ...flags] = process.argv.slice(2);
if (!dir || !['download', 'build'].includes(command)) {
  console.error('Usage: node scripts/build-map.mjs download <data-dir>\n       node --max-old-space-size=8192 scripts/build-map.mjs build <data-dir> [--tiles-only]');
  process.exit(2);
}
if (command === 'download') await download(dir);
else await build(dir, flags.includes('--tiles-only'));
