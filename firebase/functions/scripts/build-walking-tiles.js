#!/usr/bin/env node
/**
 * Builds the pedestrian street graph Nearby and the trip planner use to find the stop closest on
 * foot and draw the walk there (see src/walkingGraph.ts), into static_data/walking/, which is bundled
 * with the deploy. It reads the base map's own public sources, so walks drawn on the map need no
 * credit there either:
 *   - US Census Bureau TIGER/Line 2025 streets and walkways, in every county the service area touches
 *     (limited-access highways and their ramps left out);
 *   - New York City's paths and trails, boardwalks, and step streets (NYC Street Centerline);
 *   - New York City's interior sidewalks: the walks inside parks, campuses, and housing
 *     developments (NYC Planimetric Database);
 *   - USGS National Digital Trails: trails in parks and on public lands.
 * Paths are joined to the streets where they end within a few meters of one. Streets change
 * slowly; rebuild every few months, with the base map.
 *
 * Usage (after `npm run build`, which compiles the tile writer this runs):
 *   1. From the repository root, fetch the map's sources: npm run map:download -- <data-dir>
 *   2. node --max-old-space-size=6144 scripts/build-walking-tiles.js <data-dir>
 *   node scripts/build-walking-tiles.js --check   build nothing; exit 1 if the tiles are missing or
 *                                                 incomplete (run before every deploy)
 *
 * The tiles are gitignored, so a fresh checkout has none until step 2 runs. Without them Nearby
 * still works but quietly falls back to straight-line distance, which is why deploys check.
 *
 * Keeps only the service area, joins ways at shared points (TIGER's streets share their
 * intersections' exact coordinates), drops points along a street that aren't intersections
 * (keeping one every ~50 m so a stop mid-block snaps nearby), and drops tiny disconnected pieces a
 * stop could snap onto by mistake.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { pathToFileURL } = require('url');

const { haversineMeters } = require('../lib/geo');
const { SERVICE_AREA_BOUNDS } = require('../lib/serviceArea');
const { WALKING_FORMAT_VERSION, WALKING_TILE_DEGREES } = require('../lib/walkingGraph');
const { writeWalkingTiles } = require('../lib/walkingTilesBuild');

const OUT_DIR = path.join(__dirname, '../static_data/walking');
const MAP_SCRIPTS = path.join(__dirname, '../../../scripts/map');
const MAX_EDGE_METERS = 50;
const MIN_COMPONENT_NODES = 25;
/** A path's end within this many meters of a street's point is joined to it. */
const JOIN_METERS = 15;

/**
 * TIGER road kinds a person can walk along: secondary roads, streets, trails, service drives,
 * walkways, stairways, alleys, private and parking-lot roads, bike and bridle paths. Primary roads
 * (S1100: limited-access highways) and ramps (S1630) are left out.
 */
const WALKABLE_ROADS = new Set(['S1200', 'S1400', 'S1500', 'S1640', 'S1710', 'S1720', 'S1730', 'S1740', 'S1780', 'S1820', 'S1830']);

/** A growable Float64Array. */
class Float64List {
  constructor() { this.data = new Float64Array(1 << 20); this.length = 0; }
  push(value) {
    if (this.length === this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = value;
  }
  view() { return this.data.subarray(0, this.length); }
}

/** Why the bundled tiles can't be used, or null when they're all there in the current format. */
function checkTiles() {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return `${manifestPath} is missing`;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    return `${manifestPath} is unreadable: ${error.message}`;
  }
  if (manifest.version !== WALKING_FORMAT_VERSION || manifest.tileDegrees !== WALKING_TILE_DEGREES) return 'tiles are in an older format';
  // No OpenStreetMap (or other credit-requiring) data ships: only graphs this script built from public sources.
  if (manifest.publicDataOnly !== true) return `they weren't built from public data alone (built from ${manifest.source ?? 'unknown sources'}); rebuild them`;
  if (!Array.isArray(manifest.tiles) || manifest.tiles.length === 0) return 'the manifest lists no tiles';
  const missing = manifest.tiles.filter((key) => !fs.existsSync(path.join(OUT_DIR, `${key}.bin.gz`)));
  if (missing.length > 0) return `${missing.length} of ${manifest.tiles.length} tiles are missing (e.g. ${missing[0]})`;
  return null;
}

// Points are identified by their coordinates, to a millionth of a degree (~10 cm), packed into one
// number: TIGER's streets meet at exactly shared points, so equal keys are the same intersection.
const { north, south, east, west } = SERVICE_AREA_BOUNDS;
const ORIGIN_LON = west - 0.05;
const ORIGIN_LAT = south - 0.05;
const keyOf = (lon, lat) => Math.round((lon - ORIGIN_LON) * 1e6) * 4194304 + Math.round((lat - ORIGIN_LAT) * 1e6);
/** Every point outside the service area (keys are only for points inside it). */
const OUTSIDE = -1;
const lonOf = (key) => Math.floor(key / 4194304) / 1e6 + ORIGIN_LON;
const latOf = (key) => (key % 4194304) / 1e6 + ORIGIN_LAT;
const inServiceArea = (lon, lat) => lon >= west && lon <= east && lat >= south && lat <= north;
const touchesServiceArea = (line) => {
  for (let i = 0; i < line.length; i += 2) if (inServiceArea(line[i], line[i + 1])) return true;
  return false;
};

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

/** The streets, as lines of [lon, lat, ...]: each stretch once (TIGER lists a road with two names twice). */
async function readStreets(dataDir) {
  const { readShapefileZip } = await import(pathToFileURL(path.join(MAP_SCRIPTS, 'shapefile.mjs')).href);
  const countyDir = path.join(dataDir, 'county');
  const files = fs.existsSync(countyDir) ? fs.readdirSync(countyDir).filter((name) => name.endsWith('_roads.zip')) : [];
  if (files.length === 0) throw new Error(`no TIGER road files in ${countyDir} (run npm run map:download -- ${dataDir} from the repository root)`);
  const lines = [];
  const seen = new Set();
  for (const file of files) {
    for (const { shape, props } of readShapefileZip(path.join(countyDir, file))) {
      if (!shape || shape.type !== 'line' || !WALKABLE_ROADS.has(props.MTFCC)) continue;
      for (const line of shape.parts) {
        if (line.length < 4 || !touchesServiceArea(line)) continue;
        const forward = `${keyOf(line[0], line[1])}:${keyOf(line[line.length - 2], line[line.length - 1])}:${line.length}`;
        const backward = `${keyOf(line[line.length - 2], line[line.length - 1])}:${keyOf(line[0], line[1])}:${line.length}`;
        if (seen.has(forward) || seen.has(backward)) continue;
        seen.add(forward);
        lines.push(line);
      }
    }
  }
  return lines;
}

/** The city's paths, boardwalks, step streets, and interior sidewalks, and the USGS trails, as lines of [lon, lat, ...]. */
async function readPaths(dataDir) {
  const lines = [];
  const csv = path.join(dataDir, 'nyc', 'centerline_paths.csv');
  if (fs.existsSync(csv)) {
    const { parseCsvLine } = await import(pathToFileURL(path.join(MAP_SCRIPTS, 'sources.mjs')).href);
    let header = null;
    for await (const row of readline.createInterface({ input: fs.createReadStream(csv), crlfDelay: Infinity })) {
      if (!row) continue;
      const fields = parseCsvLine(row);
      if (!header) {
        header = fields.map((field) => field.replace(/^﻿/, '').trim());
        continue;
      }
      const geometry = fields[header.indexOf('the_geom')] ?? '';
      for (const line of parseLines(geometry)) if (touchesServiceArea(line)) lines.push(line);
    }
  } else {
    console.warn(`  no ${csv}: walks won't follow the city's park paths`);
  }
  const { readCitySidewalks } = await import(pathToFileURL(path.join(MAP_SCRIPTS, 'publicpaths.mjs')).href);
  const sidewalks = readCitySidewalks(dataDir);
  if (sidewalks) {
    for (const line of sidewalks) if (line.length >= 4 && touchesServiceArea(line)) lines.push(line);
  } else {
    console.warn("  no NYC interior sidewalk lines: walks won't cut through parks, campuses, and courtyards");
  }
  const trailsDir = path.join(dataDir, 'usgs', 'trails');
  if (fs.existsSync(trailsDir)) {
    const { readShapefile } = await import(pathToFileURL(path.join(MAP_SCRIPTS, 'shapefile.mjs')).href);
    const seen = new Set();
    for (const state of fs.readdirSync(trailsDir)) {
      const file = path.join(trailsDir, state, 'Trans_TrailSegment.shp');
      if (!fs.existsSync(file)) continue;
      for (const { shape, props } of readShapefile(file)) {
        if (!shape || shape.type !== 'line') continue;
        if (props.trailtype && props.trailtype !== 'Terra Trail') continue;
        if (/^(N|No)$/.test(props.hikerpedes ?? '')) continue;
        if (props.GLOBALID && seen.has(props.GLOBALID)) continue;
        if (props.GLOBALID) seen.add(props.GLOBALID);
        for (const line of shape.parts) if (line.length >= 4 && touchesServiceArea(line)) lines.push(line);
      }
    }
  } else {
    console.warn(`  no ${trailsDir}: walks won't follow trails`);
  }
  return lines;
}

/** A coordinate rounded as the graph keys points (keyOf), so a point added to two lines is one node. */
const roundCoordinate = (value) => Math.round(value * 1e6) / 1e6;

/**
 * Joins each path's ends to the streets and the other paths: an end within JOIN_METERS of another
 * line moves onto the closest spot on it, and that spot becomes a point of that line when it falls
 * between two of its points, so the two meet in the graph. (The paths come from other surveys, so
 * their ends rarely land exactly on TIGER's points, and mid-block a street's nearest point can be
 * far off: without this, a campus's walks, say, would never reach the street beside it.) Lines that
 * gain points are replaced in `streets` and `paths`. Returns how many ends were joined.
 */
function joinPathEnds(paths, streets) {
  const CELL = 0.0002;
  const cellOf = (value) => Math.floor(value / CELL);
  const wanted = new Set();
  for (const line of paths) {
    for (const at of [0, line.length - 2]) wanted.add(`${cellOf(line[at])},${cellOf(line[at + 1])}`);
  }
  // Every segment of every line near a path end, by cell: [line id, segment start index].
  const lists = [streets, paths];
  const lineAt = (id) => lists[id % 2][Math.floor(id / 2)];
  const grid = new Map();
  const reachX = JOIN_METERS / (111_320 * Math.cos((41 * Math.PI) / 180));
  const reachY = JOIN_METERS / 111_320;
  lists.forEach((list, which) => list.forEach((line, index) => {
    const id = index * 2 + which;
    for (let i = 2; i < line.length; i += 2) {
      const [x0, y0, x1, y1] = [line[i - 2], line[i - 1], line[i], line[i + 1]];
      for (let cx = cellOf(Math.min(x0, x1) - reachX); cx <= cellOf(Math.max(x0, x1) + reachX); cx += 1) {
        for (let cy = cellOf(Math.min(y0, y1) - reachY); cy <= cellOf(Math.max(y0, y1) + reachY); cy += 1) {
          const key = `${cx},${cy}`;
          if (!wanted.has(key)) continue;
          let cell = grid.get(key);
          if (!cell) grid.set(key, (cell = []));
          cell.push(id, i - 2);
        }
      }
    }
  }));
  // Points to add to lines, by line id: [segment start index, position along it, lon, lat].
  const additions = new Map();
  let joined = 0;
  paths.forEach((line, index) => {
    const ownId = index * 2 + 1;
    for (const at of [0, line.length - 2]) {
      const [x, y] = [line[at], line[at + 1]];
      const kx = 111_320 * Math.cos((y * Math.PI) / 180);
      const ky = 111_320;
      // The closest street and the closest other path within reach. A street wins: it ties the path
      // into the street grid, and a path's end near both usually meets the path elsewhere anyway.
      const closest = [null, null];
      const cell = grid.get(`${cellOf(x)},${cellOf(y)}`) ?? [];
      for (let k = 0; k < cell.length; k += 2) {
        const [id, i] = [cell[k], cell[k + 1]];
        if (id === ownId) continue;
        const other = lineAt(id);
        const [ax, ay, bx, by] = [(other[i] - x) * kx, (other[i + 1] - y) * ky, (other[i + 2] - x) * kx, (other[i + 3] - y) * ky];
        const [dx, dy] = [bx - ax, by - ay];
        const length2 = dx * dx + dy * dy;
        const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
        const meters = Math.hypot(ax + t * dx, ay + t * dy);
        if (meters < JOIN_METERS && (!closest[id % 2] || meters < closest[id % 2].meters)) closest[id % 2] = { id, i, t, meters };
      }
      const best = closest[0] ?? closest[1];
      if (!best || best.meters === 0) continue;
      const other = lineAt(best.id);
      const segmentMeters = haversineMeters(other[best.i + 1], other[best.i], other[best.i + 3], other[best.i + 2]);
      // Within a meter of one of the segment's points: that point. Otherwise a new point on the segment.
      let point;
      if (best.t * segmentMeters < 1) point = [other[best.i], other[best.i + 1]];
      else if ((1 - best.t) * segmentMeters < 1) point = [other[best.i + 2], other[best.i + 3]];
      else {
        point = [roundCoordinate(other[best.i] + best.t * (other[best.i + 2] - other[best.i])), roundCoordinate(other[best.i + 1] + best.t * (other[best.i + 3] - other[best.i + 1]))];
        let list = additions.get(best.id);
        if (!list) additions.set(best.id, (list = []));
        list.push([best.i, best.t, point[0], point[1]]);
      }
      line[at] = point[0];
      line[at + 1] = point[1];
      joined += 1;
    }
  });
  for (const [id, list] of additions) {
    const line = lineAt(id);
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out = [];
    let next = 0;
    for (let i = 0; i < line.length; i += 2) {
      out.push(line[i], line[i + 1]);
      while (next < list.length && list[next][0] === i) {
        out.push(list[next][2], list[next][3]);
        next += 1;
      }
    }
    lists[id % 2][Math.floor(id / 2)] = out;
  }
  return joined;
}

async function main() {
  if (process.argv[2] === '--check') {
    const problem = checkTiles();
    if (problem) {
      console.error(`Walking tiles are not ready: ${problem}.`);
      console.error('Build them first (see scripts/build-walking-tiles.js): npm run map:download -- <data-dir> (repository root), then npm --prefix firebase/functions run build:walking -- <data-dir>');
      process.exit(1);
    }
    console.log('Walking tiles are ready.');
    return;
  }
  const dataDir = process.argv[2];
  if (!dataDir || !fs.existsSync(dataDir)) {
    console.error('Usage: node --max-old-space-size=6144 scripts/build-walking-tiles.js <data-dir>   (the folder npm run map:download fills)');
    process.exit(2);
  }

  console.log('Reading streets and paths...');
  const streets = await readStreets(dataDir);
  const paths = await readPaths(dataDir);
  const joined = joinPathEnds(paths, streets);
  console.log(`  ${streets.length} street lines, ${paths.length} paths and trails (${joined} ends joined to streets and paths)`);

  // Every line as a run of point keys (wayStarts[i]..wayStarts[i + 1] in wayRefs), as the graph below reads them.
  const wayRefs = new Float64List();
  const wayStarts = [0];
  for (const line of [...streets, ...paths]) {
    // A point outside the service area is OUTSIDE (no position), where the graph cuts the way.
    for (let i = 0; i < line.length; i += 2) wayRefs.push(inServiceArea(line[i], line[i + 1]) ? keyOf(line[i], line[i + 1]) : OUTSIDE);
    wayStarts.push(wayRefs.length);
  }
  const refs = wayRefs.view();
  console.log(`  ${wayStarts.length - 1} ways, ${refs.length} points`);

  // The distinct points, sorted, so each can be found by binary search (sorted and deduplicated in
  // place: a Set can't hold the tens of millions of points a large service area has).
  const sorted = Float64Array.from(refs).sort();
  let distinct = 0;
  for (let i = 0; i < sorted.length; i += 1) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[distinct++] = sorted[i];
  const needed = sorted.subarray(0, distinct);
  const lat = new Float64Array(needed.length);
  const lon = new Float64Array(needed.length);
  for (let index = 0; index < needed.length; index += 1) {
    const outside = needed[index] === OUTSIDE;
    lon[index] = outside ? Number.NaN : lonOf(needed[index]);
    lat[index] = outside ? Number.NaN : latOf(needed[index]);
  }
  const indexOf = (id) => {
    let low = 0;
    let high = needed.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (needed[mid] === id) return mid;
      if (needed[mid] < id) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  };

  // Graph nodes: way ends and nodes shared by several ways (intersections).
  const uses = new Uint8Array(needed.length);
  const refIndex = new Int32Array(refs.length);
  for (let i = 0; i < refs.length; i += 1) {
    const index = indexOf(refs[i]);
    refIndex[i] = index;
    if (uses[index] < 255) uses[index] += 1;
  }
  const graphIndex = new Int32Array(needed.length).fill(-1);
  const nodes = [];
  const edges = [];
  const nodeFor = (index) => {
    if (graphIndex[index] < 0) {
      graphIndex[index] = nodes.length;
      nodes.push({ lat: lat[index], lon: lon[index] });
    }
    return graphIndex[index];
  };
  for (let way = 0; way + 1 < wayStarts.length; way += 1) {
    let from = -1;
    let meters = 0;
    for (let i = wayStarts[way]; i < wayStarts[way + 1]; i += 1) {
      const index = refIndex[i];
      if (Number.isNaN(lat[index])) {
        // Outside the service area: the way is cut here.
        from = -1;
        continue;
      }
      if (from < 0) {
        from = index;
        meters = 0;
        continue;
      }
      const previous = refIndex[i - 1];
      meters += haversineMeters(lat[previous], lon[previous], lat[index], lon[index]);
      const isEnd = i + 1 === wayStarts[way + 1] || Number.isNaN(lat[refIndex[i + 1]]);
      if (isEnd || uses[index] > 1 || meters >= MAX_EDGE_METERS) {
        edges.push({ a: nodeFor(from), b: nodeFor(index), meters });
        from = index;
        meters = 0;
      }
    }
  }
  console.log(`  ${nodes.length} graph nodes, ${edges.length} edges`);

  // Drop small disconnected pieces (a mapped path in a courtyard, a lone driveway).
  const parent = Int32Array.from({ length: nodes.length }, (_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) index = parent[index] = parent[parent[index]];
    return index;
  };
  for (const edge of edges) parent[find(edge.a)] = find(edge.b);
  const componentSize = new Int32Array(nodes.length);
  for (let index = 0; index < nodes.length; index += 1) componentSize[find(index)] += 1;
  const keptIndex = new Int32Array(nodes.length).fill(-1);
  const keptNodes = [];
  nodes.forEach((node, index) => {
    if (componentSize[find(index)] >= MIN_COMPONENT_NODES) {
      keptIndex[index] = keptNodes.length;
      keptNodes.push(node);
    }
  });
  const keptEdges = edges.filter((edge) => keptIndex[edge.a] >= 0).map((edge) => ({ a: keptIndex[edge.a], b: keptIndex[edge.b], meters: edge.meters }));

  const result = writeWalkingTiles(OUT_DIR, keptNodes, keptEdges, { source: 'US Census Bureau TIGER/Line 2025, NYC Street Centerline, NYC Planimetric Database interior sidewalks, USGS National Digital Trails (public domain)', publicDataOnly: true });
  console.log(`Wrote ${result.tiles} tiles (${result.nodes} nodes, ${result.edges} edges, ${(result.bytes / 1e6).toFixed(1)} MB) to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
