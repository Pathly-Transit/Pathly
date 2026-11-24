// Footpaths, trails, sports fields, and station platforms from public data: the walkways, park paths,
// and trails the Census road data (TIGER/Line) mostly leaves out.
//
//   NYC Street Centerline (CSCL, NYC Open Data): New York City's own paths and trails, boardwalks,
//     and step streets and pedestrian bridges (roadway types 6, 5, and 7), added to the road layer as
//     kind `path`. They replace TIGER's walkways inside the city (the same paths, drawn twice).
//   NYC Planimetric Database (the city's ArcGIS service): interior sidewalk centerlines, the walks
//     inside parks, campuses, and housing developments, also kind `path`.
//   USGS National Digital Trails (The National Map's state transportation packages): trails in parks
//     and on public lands, from federal and state agencies, kind `path` marked `trail` (drawn dashed).
//     Where one runs along a street or a path already on the map, it's left out.
//   NYC Planimetric Database (NYC Open Data): ball fields, courts, soccer and football fields, and
//     running tracks (the park layer, kind `pitch`), and rail and subway station platforms above
//     ground (the landuse layer, kind `platform`).
//
// All of it is public: the map needs no credit for any of it (Settings → About lists the sources).
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { DETAIL } from './bounds.mjs';
import { boxContainsBox, boxesOverlap, clipLine, orient, pointInRing, ringBounds, zoomForArea } from './geometry.mjs';
import { fetchZipEntries } from './remotezip.mjs';
import { readShapefile, readShapefileZip } from './shapefile.mjs';
import { addPolygons, parseCsvLine, parseMultiPolygon, polygonsArea } from './sources.mjs';
import { LINE } from './store.mjs';

const NYC_DATA = 'https://data.cityofnewyork.us/resource';
/** NYC Open Data's files, filtered to what the map draws (SODA queries, so each file stays small). */
export const NYC_PATH_FILES = [
  // Street Centerline: paths and trails (6), boardwalks (5), step streets and pedestrian bridges (7), built (status 2).
  [`${NYC_DATA}/inkn-q76z.csv?$select=the_geom,rw_type,full_street_name&$where=rw_type in('5','6','7') AND status='2'&$limit=100000`, 'nyc/centerline_paths.csv'],
  // Planimetric parks: ball fields (4900), courts (4910), football (4920) and soccer (4930) fields, running tracks (4960).
  [`${NYC_DATA}/y6ja-fw4f.csv?$select=the_geom,feat_code&$where=feat_code in('4900','4910','4920','4930','4960')&$limit=100000`, 'nyc/planimetric_fields.csv'],
  // Planimetric railroad structures: stations and their platforms, at grade (2160) and elevated (2140).
  [`${NYC_DATA}/dwer-xbgx.csv?$select=the_geom,feat_code&$where=feat_code in('2140','2160')&$limit=100000`, 'nyc/planimetric_platforms.csv'],
];

/**
 * The NYC Planimetric Database's 2022 layers, traced from the city's aerial imagery by the Office of
 * Technology and Innovation and served from its ArcGIS services (NYC Open Data's copies of these
 * two are mislinked):
 *   interior sidewalk centerlines (feature code 3810): the walkways inside blocks rather than along
 *     streets: park paths, campus walks, housing-development paths;
 *   plazas (6000): pedestrian plazas, Times Square's and the ones outside stations among them.
 */
const NYC_PLANIMETRIC = 'https://services6.arcgis.com/yG5s3afENB5iO9fj/ArcGIS/rest/services';
const NYC_SIDEWALK_LINES = `${NYC_PLANIMETRIC}/Sidewalk_Line_2022/FeatureServer/23/query`;
const NYC_PLAZAS = `${NYC_PLANIMETRIC}/Plaza_2022/FeatureServer/16/query`;
/** Where the download keeps them: JSON arrays of flat [lon, lat, ...] lines, and of polygons (rings of them). */
export const SIDEWALK_LINES_FILE = 'nyc/sidewalk_lines.json';
const PLAZAS_FILE = 'nyc/plazas.json';
const ARCGIS_PAGE = 2000;

const TNM = 'https://prd-tnm.s3.amazonaws.com/StagedProducts';

/**
 * The states whose outlines touch a box (TIGER's states), as { code: 'NY', name: 'New_York' }: the
 * name as The National Map spells it in its state packages' file names.
 */
export function statesOver(tigerDir, box) {
  // A state's outline reaches into the box, or the box sits inside it (outlines' bounds alone
  // overlap too often: Maine's take in a corner of New Hampshire).
  const touches = (parts) => parts.some((ring) => {
    if (!boxesOverlap(ringBounds(ring), box)) return false;
    for (let i = 0; i < ring.length; i += 2) if (ring[i] >= box.west && ring[i] <= box.east && ring[i + 1] >= box.south && ring[i + 1] <= box.north) return true;
    return pointInRing(ring, box.west, box.south) || pointInRing(ring, box.east, box.north) || pointInRing(ring, box.west, box.north) || pointInRing(ring, box.east, box.south);
  });
  return readShapefileZip(join(tigerDir, 'tl_2025_us_state.zip'))
    .filter(({ shape }) => shape && touches(shape.parts))
    .map(({ props }) => ({ code: props.STUSPS, name: props.NAME.replace(/ /g, '_') }));
}

/** Footpaths show from this zoom (MapLibre's), like TIGER's walkways. */
const PATH_MINZOOM = 13;
/** Fields show from this zoom, small courts later (once they're a few pixels across). */
const FIELD_MINZOOM = 13;
/** Platforms show from this zoom. */
const PLATFORM_MINZOOM = 14;
/** A trail mostly (this share of it) within this many meters of a street or path already on the map is that street or path. */
const ALONG_METERS = 15;
const ALONG_SHARE = 0.6;
/** Lines are checked at points this far apart (meters). */
const SAMPLE_METERS = 10;
/** The five boroughs' county codes. */
const NYC_COUNTIES = new Set(['36005', '36047', '36061', '36081', '36085']);

/**
 * Fetches the USGS trails over the detailed area (just the trails files out of each state's
 * transportation package) into <dir>/usgs/trails/<state>. Needs TIGER's states (tiger/).
 */
export async function downloadUsgsTrails(dir, log = console.log) {
  for (const { code, name } of statesOver(join(dir, 'tiger'), DETAIL)) {
    log(`Fetching USGS trails for ${name.replace(/_/g, ' ')}...`);
    try {
      await fetchZipEntries(`${TNM}/Tran/Shape/TRAN_${name}_State_Shape.zip`, (entry) => /Trans_TrailSegment\.(shp|dbf|prj)$/i.test(entry), join(dir, 'usgs', 'trails', code), log);
    } catch (error) {
      log(`  ${error.message}; skipped (run the download again to retry)`);
    }
  }
}

/** Every feature's GeoJSON geometry from an ArcGIS layer's query URL, a page at a time; null when the service won't answer. */
async function fetchArcgisGeometries(url, log) {
  const geometries = [];
  for (let offset = 0; ; offset += ARCGIS_PAGE) {
    const params = new URLSearchParams({
      where: '1=1', outFields: 'OBJECTID', returnGeometry: 'true', outSR: '4326', geometryPrecision: '6',
      orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(ARCGIS_PAGE), f: 'geojson',
    });
    let page = null;
    for (let attempt = 0; attempt < 4 && !page; attempt += 1) {
      try {
        const response = await fetch(`${url}?${params}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        page = await response.json();
        if (page.error) throw new Error(page.error.message ?? 'query failed');
      } catch (error) {
        page = null;
        if (attempt === 3) {
          log(`  ${error.message}; skipped (run the download again to retry)`);
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
      }
    }
    const features = page.features ?? [];
    for (const { geometry } of features) if (geometry) geometries.push(geometry);
    if (features.length < ARCGIS_PAGE) return geometries;
  }
}

function writeJson(path, value) {
  writeFileSync(`${path}.partial`, JSON.stringify(value));
  renameSync(`${path}.partial`, path);
}

/** A GeoJSON ring as a flat [lon, lat, ...] ring: no closing point, wound as the map's polygons are. */
function flatRing(coordinates, outer) {
  const flat = coordinates.flat();
  if (flat.length >= 4 && flat[0] === flat[flat.length - 2] && flat[1] === flat[flat.length - 1]) flat.length -= 2;
  return orient(flat, outer);
}

/**
 * Fetches the city's interior sidewalk centerlines and plazas into <dir>/nyc (each kept when
 * already there).
 */
export async function downloadCitySidewalks(dir, log = console.log) {
  mkdirSync(join(dir, 'nyc'), { recursive: true });
  const linesPath = join(dir, SIDEWALK_LINES_FILE);
  if (!existsSync(linesPath)) {
    log('Fetching NYC interior sidewalk centerlines (planimetric)...');
    const geometries = await fetchArcgisGeometries(NYC_SIDEWALK_LINES, log);
    if (geometries) {
      const lines = geometries
        .flatMap((geometry) => (geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : []))
        .filter((part) => part.length >= 2)
        .map((part) => part.flat());
      writeJson(linesPath, lines);
      log(`  ${lines.length} sidewalk lines`);
    }
  }
  const plazasPath = join(dir, PLAZAS_FILE);
  if (!existsSync(plazasPath)) {
    log('Fetching NYC pedestrian plazas (planimetric)...');
    const geometries = await fetchArcgisGeometries(NYC_PLAZAS, log);
    if (geometries) {
      const polygons = geometries
        .flatMap((geometry) => (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : []))
        .map((rings) => rings.map((ring, i) => flatRing(ring, i === 0)).filter((ring) => ring.length >= 6))
        .filter((rings) => rings.length > 0);
      writeJson(plazasPath, polygons);
      log(`  ${polygons.length} plazas`);
    }
  }
}

/** The city's interior sidewalk centerlines, as flat [lon, lat, ...] lines, or null when not downloaded. */
export function readCitySidewalks(dir) {
  const path = join(dir, SIDEWALK_LINES_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** The five boroughs' outlines (TIGER's counties), as a point test. */
export function nycTest(tigerDir) {
  const rings = readShapefileZip(join(tigerDir, 'tl_2025_us_county.zip'))
    .filter(({ props, shape }) => shape && NYC_COUNTIES.has(props.GEOID))
    .flatMap(({ shape }) => shape.parts.map((ring) => ({ ring, box: ringBounds(ring) })));
  return (x, y) => rings.some(({ ring, box }) => x >= box.west && x <= box.east && y >= box.south && y <= box.north && pointInRing(ring, x, y));
}

/** Each row of a CSV file, as an object by header. */
async function* csvRows(path) {
  let header = null;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (!line) continue;
    const fields = parseCsvLine(line);
    if (!header) {
      header = fields.map((field) => field.replace(/^﻿/, '').trim());
      continue;
    }
    yield Object.fromEntries(header.map((key, i) => [key, fields[i] ?? '']));
  }
}

/** "MULTILINESTRING ((x y, ...), (...))" (or a LINESTRING) as flat [lon, lat, ...] lines. */
function parseLines(wkt) {
  const open = wkt.indexOf('(');
  const close = wkt.lastIndexOf(')');
  if (open < 0 || close < open) return [];
  return wkt.slice(open, close + 1).replace(/^\(+|\)+$/g, '').split(/\)\s*,\s*\(/).map((part) => {
    const flat = [];
    for (const pair of part.split(',')) {
      const [x, y] = pair.trim().split(/\s+/).map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) flat.push(x, y);
    }
    return flat;
  }).filter((line) => line.length >= 4);
}

function cutToDetail(line) {
  return boxContainsBox(DETAIL, ringBounds(line)) ? [line] : clipLine(line, DETAIL);
}

// ── Along streets ─────────────────────────────────────────────────────────────────────────────

/** Grid cells about 45 m on a side, for finding the lines near a point. */
const CELL = 0.0004;
const cellKey = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;

/** Points every SAMPLE_METERS along a line (its vertices among them), as [lon, lat, ...]. */
function samplePoints(line) {
  const out = [line[0], line[1]];
  for (let i = 2; i < line.length; i += 2) {
    const [x0, y0, x1, y1] = [line[i - 2], line[i - 1], line[i], line[i + 1]];
    const meters = Math.hypot((x1 - x0) * 111_320 * Math.cos((y0 * Math.PI) / 180), (y1 - y0) * 111_320);
    const steps = Math.max(1, Math.ceil(meters / SAMPLE_METERS));
    for (let step = 1; step <= steps; step += 1) out.push(x0 + ((x1 - x0) * step) / steps, y0 + ((y1 - y0) * step) / steps);
  }
  return out;
}

/** Meters from a point to a segment, flattened around the point's latitude. */
function segmentMeters(px, py, ax, ay, bx, by) {
  const kx = 111_320 * Math.cos((py * Math.PI) / 180);
  const ky = 111_320;
  const [x, y, x1, y1, x2, y2] = [px * kx, py * ky, ax * kx, ay * ky, bx * kx, by * ky];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length2));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/**
 * Which of `lines` (an id → line map) run mostly along a road-layer line already in the store (most
 * of their length within ALONG_METERS of one). Roads are indexed only near those lines.
 */
function linesAlongRoads(store, lines) {
  const samples = new Map([...lines].map(([id, line]) => [id, samplePoints(line)]));
  const wanted = new Set();
  for (const points of samples.values()) for (let i = 0; i < points.length; i += 2) wanted.add(cellKey(points[i], points[i + 1]));
  const reach = ALONG_METERS / 111_320 / Math.cos((41 * Math.PI) / 180);
  const grid = new Map();
  for (let index = 0; index < store.count; index += 1) {
    if (store.deleted.array[index] || store.layerName(index) !== 'road') continue;
    const box = store.boundsOf(index);
    let near = false;
    for (let x = Math.floor((box.west - reach) / CELL); x <= Math.floor((box.east + reach) / CELL) && !near; x += 1) {
      for (let y = Math.floor((box.south - reach) / CELL); y <= Math.floor((box.north + reach) / CELL) && !near; y += 1) near = wanted.has(`${x},${y}`);
    }
    if (!near) continue;
    for (const part of store.partsOf(index).parts) {
      for (let i = 2; i < part.length; i += 2) {
        const segment = [part[i - 2], part[i - 1], part[i], part[i + 1]];
        const [west, east] = [Math.min(segment[0], segment[2]) - reach, Math.max(segment[0], segment[2]) + reach];
        const [south, north] = [Math.min(segment[1], segment[3]) - reach, Math.max(segment[1], segment[3]) + reach];
        for (let x = Math.floor(west / CELL); x <= Math.floor(east / CELL); x += 1) {
          for (let y = Math.floor(south / CELL); y <= Math.floor(north / CELL); y += 1) {
            const key = `${x},${y}`;
            if (!wanted.has(key)) continue;
            let list = grid.get(key);
            if (!list) grid.set(key, (list = []));
            list.push(segment);
          }
        }
      }
    }
  }
  const along = new Set();
  for (const [id, points] of samples) {
    let close = 0;
    for (let i = 0; i < points.length; i += 2) {
      const [x, y] = [points[i], points[i + 1]];
      if ((grid.get(cellKey(x, y)) ?? []).some(([ax, ay, bx, by]) => segmentMeters(x, y, ax, ay, bx, by) <= ALONG_METERS)) close += 1;
    }
    if (close >= (points.length / 2) * ALONG_SHARE) along.add(id);
  }
  return along;
}

// ── Adding them ───────────────────────────────────────────────────────────────────────────────

/** New York City's paths, boardwalks, and step streets (CSCL), in place of TIGER's walkways there. */
async function addCityPaths(store, nycDir, inNyc, log) {
  const path = join(nycDir, 'centerline_paths.csv');
  if (!existsSync(path)) {
    log(`  NYC paths: no ${path}; skipped (npm run map:download fetches it)`);
    return 0;
  }
  // TIGER's walkways inside the city are the same paths, less exactly: the city's own replace them.
  let replaced = 0;
  for (let index = 0; index < store.count; index += 1) {
    if (store.deleted.array[index] || store.layerName(index) !== 'road' || store.propsOf(index).kind !== 'path') continue;
    const { west, south, east, north } = store.boundsOf(index);
    if (inNyc((west + east) / 2, (south + north) / 2)) {
      store.delete(index);
      replaced += 1;
    }
  }
  let count = 0;
  for await (const row of csvRows(path)) {
    const type = row.rw_type;
    if (type !== '5' && type !== '6' && type !== '7') continue;
    const name = row.full_street_name ?? '';
    // Pedestrian bridges and underpasses among the step streets (OPAS/OVPS: overpass; UPAS: underpass).
    const brunnel = type === '7' && /\b(OPAS|OVPS|OVERPASS|BRIDGE)\b/.test(name) ? 'bridge' : type === '7' && /\b(UPAS|UNDERPASS|TUNNEL)\b/.test(name) ? 'tunnel' : '';
    const parts = parseLines(row.the_geom ?? '').flatMap(cutToDetail);
    if (parts.length === 0) continue;
    store.add('road', LINE, PATH_MINZOOM, { kind: 'path', ...(brunnel ? { brunnel } : {}) }, parts);
    count += 1;
  }
  log(`  NYC paths (Street Centerline): ${count} lines (in place of ${replaced} TIGER walkways)`);
  return count;
}

/**
 * The city's interior sidewalks (planimetric): the park, campus, and courtyard walks between the
 * Street Centerline's main paths, less those along a street or a path already on the map.
 */
function addCitySidewalks(store, dir, log) {
  const raw = readCitySidewalks(dir);
  if (!raw) {
    log(`  NYC interior sidewalks: no ${join(dir, SIDEWALK_LINES_FILE)}; skipped (npm run map:download fetches it)`);
    return;
  }
  const lines = new Map();
  raw.forEach((line, i) => cutToDetail(line).forEach((part, j) => lines.set(`${i}#${j}`, part)));
  const along = linesAlongRoads(store, lines);
  let count = 0;
  for (const [key, part] of lines) {
    if (along.has(key)) continue;
    store.add('road', LINE, PATH_MINZOOM, { kind: 'path' }, [part]);
    count += 1;
  }
  log(`  NYC interior sidewalks (planimetric): ${count} lines (${along.size} along streets and paths already on the map left out)`);
}

/** USGS trails over the detailed area (once each: neighboring states' packages share some), less those along streets and paths. */
function addUsgsTrails(store, trailsDir, log) {
  const files = existsSync(trailsDir) ? readdirSync(trailsDir).map((state) => join(trailsDir, state, 'Trans_TrailSegment.shp')).filter((file) => existsSync(file)) : [];
  if (files.length === 0) {
    log(`  trails (USGS): none in ${trailsDir}; skipped (npm run map:download fetches them)`);
    return;
  }
  const trails = new Map();
  for (const file of files) {
    for (const { shape, props } of readShapefile(file)) {
      if (!shape || shape.type !== 'line') continue;
      // Walkable trails on land (not snow or water trails, not ones closed to people on foot).
      if (props.trailtype && props.trailtype !== 'Terra Trail') continue;
      if (/^(N|No)$/.test(props.hikerpedes ?? '')) continue;
      const id = props.GLOBALID || props.permanenti || `${file}:${trails.size}`;
      if (trails.has(id)) continue;
      const parts = shape.parts.flatMap(cutToDetail);
      if (parts.length) trails.set(id, parts);
    }
  }
  const lines = new Map();
  for (const [id, parts] of trails) parts.forEach((part, i) => lines.set(`${id}#${i}`, part));
  const along = linesAlongRoads(store, lines);
  let count = 0;
  for (const [key, part] of lines) {
    if (along.has(key)) continue;
    store.add('road', LINE, PATH_MINZOOM, { kind: 'path', trail: 1 }, [part]);
    count += 1;
  }
  log(`  trails (USGS): ${count} lines (${along.size} along streets and paths already on the map left out)`);
}

/** New York City's sports fields and courts (planimetric parks), as the park layer's kind `pitch`. */
async function addCityFields(store, nycDir, log) {
  const path = join(nycDir, 'planimetric_fields.csv');
  if (!existsSync(path)) {
    log(`  sports fields: no ${path}; skipped (npm run map:download fetches it)`);
    return;
  }
  let count = 0;
  for await (const row of csvRows(path)) {
    if (!row.the_geom?.startsWith('MULTIPOLYGON')) continue;
    const polygons = parseMultiPolygon(row.the_geom);
    if (polygons.length === 0) continue;
    const minzoom = Math.max(FIELD_MINZOOM, zoomForArea(polygonsArea(polygons), 16));
    if (addPolygons(store, 'park', minzoom, { kind: 'pitch' }, polygons) >= 0) count += 1;
  }
  log(`  sports fields (NYC planimetric): ${count}`);
}

/** New York City's above-ground station platforms (planimetric railroad structures), as the landuse layer's kind `platform`. */
async function addCityPlatforms(store, nycDir, log) {
  const path = join(nycDir, 'planimetric_platforms.csv');
  if (!existsSync(path)) {
    log(`  platforms: no ${path}; skipped (npm run map:download fetches it)`);
    return;
  }
  let count = 0;
  for await (const row of csvRows(path)) {
    if (!row.the_geom?.startsWith('MULTIPOLYGON')) continue;
    const polygons = parseMultiPolygon(row.the_geom);
    if (polygons.length && addPolygons(store, 'landuse', PLATFORM_MINZOOM, { kind: 'platform' }, polygons) >= 0) count += 1;
  }
  log(`  station platforms (NYC planimetric): ${count}`);
}

/** New York City's pedestrian plazas (planimetric), as the landuse layer's kind `plaza`: paved like the streets. */
function addCityPlazas(store, dir, log) {
  const path = join(dir, PLAZAS_FILE);
  if (!existsSync(path)) {
    log(`  plazas: no ${path}; skipped (npm run map:download fetches it)`);
    return;
  }
  let count = 0;
  for (const polygon of JSON.parse(readFileSync(path, 'utf8'))) {
    const minzoom = Math.max(PLATFORM_MINZOOM, zoomForArea(polygonsArea([polygon]), 16));
    if (addPolygons(store, 'landuse', minzoom, { kind: 'plaza' }, [polygon]) >= 0) count += 1;
  }
  log(`  pedestrian plazas (NYC planimetric): ${count}`);
}

/**
 * Adds the public footpaths, trails, sports fields, platforms, and plazas. Needs the streets added
 * first (addRoads), and OpenStreetMap's paths and platforms when there are any (osm.mjs,
 * transitways.mjs): trails and sidewalks along streets and paths already on the map are left out.
 *
 * OpenStreetMap's footpaths and fields (`osmPaths`) cover the whole map more completely than the
 * city's paths, sidewalks, and fields, so those stand in only without them; its platforms
 * (`osmPlatforms`) carry their names, so the city's (unnamed) stand in only without them. USGS
 * trails (on public lands OpenStreetMap may have missed) and the city's plazas always come along.
 */
export async function addPublicPaths(store, dir, log, { osmPaths = false, osmPlatforms = false } = {}) {
  if (!osmPaths) {
    const inNyc = nycTest(join(dir, 'tiger'));
    await addCityPaths(store, join(dir, 'nyc'), inNyc, log);
    addCitySidewalks(store, dir, log);
  }
  addUsgsTrails(store, join(dir, 'usgs', 'trails'), log);
  if (!osmPaths) await addCityFields(store, join(dir, 'nyc'), log);
  if (!osmPlatforms) await addCityPlatforms(store, join(dir, 'nyc'), log);
  addCityPlazas(store, dir, log);
}
