#!/usr/bin/env node
/**
 * Builds the pedestrian street graph Nearby and the trip planner use to find the stop closest on
 * foot and draw the walk there (see src/walkingGraph.ts), into static_data/walking/, which is bundled
 * with the deploy, from OpenStreetMap's pedestrian network when its extracts have been fetched
 * (<data-dir>/osm-pbf/*.osm.pbf: npm run map:download fetches the states the service area reaches).
 * OpenStreetMap maps the sidewalks, crossings, stairs, and campus and park paths that make walks
 * accurate; its license asks for a credit wherever the walks show, which the app's map carries
 * (MapCredit) and the manifest records (credits).
 *
 * Without the extracts, it falls back to the base map's public sources:
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
 *   2. node --max-old-space-size=12288 scripts/build-walking-tiles.js <data-dir>
 *   node scripts/build-walking-tiles.js --check   build nothing; exit 1 if the tiles are missing or
 *                                                 incomplete (run before every deploy)
 *
 * The tiles are gitignored, so a fresh checkout has none until step 2 runs. Without them Nearby
 * still works but quietly falls back to straight-line distance, which is why deploys check.
 *
 * Walks keep to the sidewalk and cross at the corner, as people do: each edge has a cost the
 * search minimizes besides its meters (see src/walkingGraph.ts). Along a street whose sidewalks
 * OpenStreetMap maps as their own ways (tagged so, or found running beside it), the middle of the
 * street costs STREET_BESIDE_SIDEWALK times its length, so walks take the sidewalk on the side they
 * need and change sides at a crossing; a crossing costs more without a traffic signal, and more
 * again unmarked, the more so the wider the street it crosses.
 *
 * Keeps only the service area, joins ways at shared points (OpenStreetMap's ways share their nodes;
 * TIGER's streets share their intersections' exact coordinates), drops points along a street that aren't intersections
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

/** The credit OpenStreetMap's license (ODbL) asks for wherever its data shows. */
const OSM_CREDIT = '© OpenStreetMap contributors';
/** The app's map style, whose credit (MAP_ATTRIBUTION, shown by MapCredit) every walk shows under. */
const MAP_STYLE = path.join(__dirname, '../../../mobile/src/map/mapStyle.ts');

// OpenStreetMap ways a person can walk along. Motorways are left out; so is anything tagged as closed to people on foot.
const WALKABLE_HIGHWAYS = new Set([
  'footway', 'path', 'pedestrian', 'steps', 'living_street', 'residential', 'service', 'unclassified', 'road',
  'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'trunk', 'trunk_link',
  'track', 'cycleway', 'bridleway', 'corridor', 'crossing', 'elevator',
]);
const FOOT_ALLOWED = new Set(['yes', 'designated', 'permissive', 'official']);
/** Ways cars drive on, which may have sidewalks mapped beside them. */
const CAR_HIGHWAYS = new Set([
  'residential', 'service', 'unclassified', 'road', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link',
  'primary', 'primary_link', 'trunk', 'trunk_link',
]);

// What each walkable line is, for its edges' costs.
const PATH = 0;
const STREET = 1;
/** A street tagged as having its sidewalks mapped as their own ways (sidewalk=separate). */
const STREET_SIDEWALKS_SEPARATE = 2;
const SIDEWALK = 3;
const CROSSING_SIGNALS = 4;
const CROSSING_MARKED = 5;
const CROSSING_UNMARKED = 6;
const CROSSING_UNKNOWN = 7;

/** How much more the middle of a street costs than the sidewalk beside it. */
const STREET_BESIDE_SIDEWALK = 3;
/** Each crossing's cost: meters × per, plus a fixed amount (a crossing at a light costs little more than its width). */
const CROSSING_COST = {
  [CROSSING_SIGNALS]: { per: 1, plus: 5 },
  [CROSSING_MARKED]: { per: 1.5, plus: 15 },
  [CROSSING_UNKNOWN]: { per: 1.5, plus: 20 },
  [CROSSING_UNMARKED]: { per: 2.5, plus: 40 },
};
/** A sidewalk within this many meters of a street, running the same way, runs beside it. */
const BESIDE_METERS = 22;

const WAY_TAGS = [
  'highway', 'foot', 'access', 'sidewalk', 'sidewalk:both', 'sidewalk:left', 'sidewalk:right',
  'footway', 'crossing', 'crossing:signals', 'crossing:markings', 'crossing_ref',
];
const SIGNAL_CROSSINGS = /^(traffic_signals|pelican|toucan|puffin|pegasus)$/;

/** A walkable way's class (PATH, STREET, ... above) by its tags (readOsmWays adds the signals its nodes show). */
function wayClass(tags) {
  if (tags.footway === 'sidewalk') return SIDEWALK;
  if (tags.footway === 'crossing' || tags.highway === 'crossing' || tags.crossing) {
    if (SIGNAL_CROSSINGS.test(tags.crossing ?? '') || tags['crossing:signals'] === 'yes') return CROSSING_SIGNALS;
    if (tags.crossing === 'unmarked' || tags['crossing:markings'] === 'no') return CROSSING_UNMARKED;
    if (/^(marked|zebra|uncontrolled)$/.test(tags.crossing ?? '') || tags.crossing_ref || (tags['crossing:markings'] && tags['crossing:markings'] !== 'no')) return CROSSING_MARKED;
    return CROSSING_UNKNOWN;
  }
  if (!CAR_HIGHWAYS.has(tags.highway)) return PATH;
  const separate = (value) => value === 'separate';
  if (separate(tags.sidewalk) || separate(tags['sidewalk:both']) || ((separate(tags['sidewalk:left']) || separate(tags['sidewalk:right'])) && (separate(tags['sidewalk:left']) || tags['sidewalk:left'] === 'no') && (separate(tags['sidewalk:right']) || tags['sidewalk:right'] === 'no'))) return STREET_SIDEWALKS_SEPARATE;
  return STREET;
}

function isWalkable(tags) {
  if (!tags || !WALKABLE_HIGHWAYS.has(tags.highway)) return false;
  // A crossing mapped as not allowed: people cross elsewhere.
  if (tags.crossing === 'no') return false;
  if (tags.foot && FOOT_ALLOWED.has(tags.foot)) return true;
  // use_sidepath: walk on the separately mapped sidewalk instead, which is its own way.
  if (tags.foot === 'no' || tags.foot === 'private' || tags.foot === 'use_sidepath') return false;
  if (tags.access === 'no' || tags.access === 'private') return false;
  if (tags.highway === 'trunk' || tags.highway === 'trunk_link') return tags.sidewalk !== undefined && tags.sidewalk !== 'no' && tags.sidewalk !== 'none';
  return true;
}

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
  // Only a graph that lists the credits its sources need ships, and only when the app's map shows them.
  if (!Array.isArray(manifest.credits)) return `the manifest doesn't list the credits its sources need (built from ${manifest.source ?? 'unknown sources'}); rebuild them`;
  const shown = fs.readFileSync(MAP_STYLE, 'utf-8').match(/export const MAP_ATTRIBUTION = '([^']*)'/)?.[1] ?? '';
  const unshown = manifest.credits.filter((credit) => !shown.includes(credit));
  if (unshown.length > 0) return `walks need ${unshown.join(', ')} credited, but the app's map (mapStyle.ts MAP_ATTRIBUTION) doesn't show it`;
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

/** The states (Geofabrik's extract names) the service area reaches; the map's other extracts are left alone. */
const WALKING_STATES = ['new-york', 'new-jersey', 'connecticut', 'pennsylvania', 'delaware'];

/** OpenStreetMap's extracts of WALKING_STATES in <data-dir>/osm-pbf. */
function osmExtracts(dataDir) {
  const dir = path.join(dataDir, 'osm-pbf');
  const wanted = new Set(WALKING_STATES.map((state) => `${state}-latest.osm.pbf`));
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => wanted.has(name)).sort().map((name) => path.join(dir, name)) : [];
}

/**
 * The walkable ways in OpenStreetMap's extracts, as lines of [lon, lat, ...] inside the service
 * area (a way leaving it is cut there), and each line's class (PATH, STREET, ...). Reads each file
 * twice: first the walkable ways (which nodes they use; a way in two states' files, once), then
 * those nodes' coordinates and traffic signals (a crossing through a signal's node crosses at it).
 */
async function readOsmWays(files) {
  const { OSMTransform } = await import('osm-pbf-parser-node');
  // Whole blocks at a time: tens of millions of entities read one by one would be far slower.
  const blocks = (file, options) => fs.createReadStream(file).pipe(new OSMTransform(options));
  const wayRefs = new Float64List();
  const wayStarts = [0];
  const wayClasses = [];
  const seenWays = new Set();
  for (const file of files) {
    console.log(`  walkable ways in ${path.basename(file)}...`);
    for await (const block of blocks(file, { withTags: { way: WAY_TAGS, node: false, relation: false }, withInfo: false })) {
      for (const item of block) {
        if (item.type !== 'way' || seenWays.has(item.id) || !isWalkable(item.tags)) continue;
        seenWays.add(item.id);
        for (const ref of item.refs) wayRefs.push(ref);
        wayStarts.push(wayRefs.length);
        wayClasses.push(wayClass(item.tags));
      }
    }
  }
  seenWays.clear();
  const refs = wayRefs.view();
  // The distinct nodes those ways use, sorted (in place: a Set can't hold this many), for binary search.
  const sorted = Float64Array.from(refs).sort();
  let distinct = 0;
  for (let i = 0; i < sorted.length; i += 1) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[distinct++] = sorted[i];
  const needed = sorted.subarray(0, distinct);
  const lat = new Float64Array(needed.length).fill(Number.NaN);
  const lon = new Float64Array(needed.length).fill(Number.NaN);
  const signal = new Uint8Array(needed.length);
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
  for (const file of files) {
    console.log(`  node positions in ${path.basename(file)}...`);
    reading: for await (const block of blocks(file, { withTags: { node: ['highway', 'crossing', 'crossing:signals'], way: false, relation: false }, withInfo: false })) {
      for (const item of block) {
        if (item.type === 'way') break reading; // Nodes come first in a sorted extract.
        if (item.type !== 'node' || !inServiceArea(item.lon, item.lat)) continue;
        const index = indexOf(item.id);
        if (index >= 0) {
          lat[index] = item.lat;
          lon[index] = item.lon;
          const tags = item.tags;
          if (tags && (tags.highway === 'traffic_signals' || SIGNAL_CROSSINGS.test(tags.crossing ?? '') || tags['crossing:signals'] === 'yes')) signal[index] = 1;
        }
      }
    }
  }
  // A crossing through a traffic signal's node crosses at the light, however the crossing itself is tagged.
  let signalled = 0;
  for (let way = 0; way + 1 < wayStarts.length; way += 1) {
    if (wayClasses[way] < CROSSING_MARKED) continue;
    for (let i = wayStarts[way]; i < wayStarts[way + 1]; i += 1) {
      const index = indexOf(refs[i]);
      if (index >= 0 && signal[index]) {
        wayClasses[way] = CROSSING_SIGNALS;
        signalled += 1;
        break;
      }
    }
  }
  console.log(`  ${signalled} crossings at traffic signals found by their nodes`);
  // Each way as lines through its nodes inside the service area (a node outside cuts it).
  const lines = [];
  const classes = [];
  for (let way = 0; way + 1 < wayStarts.length; way += 1) {
    let line = [];
    for (let i = wayStarts[way]; i < wayStarts[way + 1]; i += 1) {
      const index = indexOf(refs[i]);
      if (index >= 0 && !Number.isNaN(lat[index])) {
        line.push(lon[index], lat[index]);
        continue;
      }
      if (line.length >= 4) {
        lines.push(line);
        classes.push(wayClasses[way]);
      }
      line = [];
    }
    if (line.length >= 4) {
      lines.push(line);
      classes.push(wayClasses[way]);
    }
  }
  return { lines, classes };
}

/** Grid cells about 45 m on a side, for finding the sidewalks near a street. */
const SIDEWALK_CELL = 0.0004;

/**
 * Finds sidewalks beside streets: returns `besideShare(x0, y0, x1, y1)`, the share of a street
 * segment that has a sidewalk (a SIDEWALK line) running the same way within BESIDE_METERS of it,
 * sampled every ~15 m.
 */
function sidewalkIndex(lines, classes) {
  const cell = (x, y) => Math.floor(x / SIDEWALK_CELL) * 1_000_000 + Math.floor(y / SIDEWALK_CELL);
  const segments = new Float64List();
  const grid = new Map();
  lines.forEach((line, index) => {
    if (classes[index] !== SIDEWALK) return;
    for (let i = 2; i < line.length; i += 2) {
      const start = segments.length;
      segments.push(line[i - 2]);
      segments.push(line[i - 1]);
      segments.push(line[i]);
      segments.push(line[i + 1]);
      const seen = new Set();
      // Every cell the segment passes through (sampled finely enough not to skip one).
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(line[i] - line[i - 2]), Math.abs(line[i + 1] - line[i - 1])) / (SIDEWALK_CELL / 2)));
      for (let step = 0; step <= steps; step += 1) {
        const key = cell(line[i - 2] + ((line[i] - line[i - 2]) * step) / steps, line[i - 1] + ((line[i + 1] - line[i - 1]) * step) / steps);
        if (seen.has(key)) continue;
        seen.add(key);
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(start);
      }
    }
  });
  const data = () => segments.data;
  return function besideShare(x0, y0, x1, y1) {
    const kx = 111_320 * Math.cos((y0 * Math.PI) / 180);
    const ky = 111_320;
    const [dx, dy] = [(x1 - x0) * kx, (y1 - y0) * ky];
    const length = Math.hypot(dx, dy);
    if (length === 0) return 0;
    const samples = Math.max(1, Math.round(length / 15));
    const reachCells = 1;
    let beside = 0;
    const seg = data();
    for (let s = 0; s < samples; s += 1) {
      const t = (s + 0.5) / samples;
      const [px, py] = [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
      const [cx, cy] = [Math.floor(px / SIDEWALK_CELL), Math.floor(py / SIDEWALK_CELL)];
      let found = false;
      for (let gx = cx - reachCells; gx <= cx + reachCells && !found; gx += 1) {
        for (let gy = cy - reachCells; gy <= cy + reachCells && !found; gy += 1) {
          for (const start of grid.get(gx * 1_000_000 + gy) ?? []) {
            const [ax, ay, bx, by] = [(seg[start] - px) * kx, (seg[start + 1] - py) * ky, (seg[start + 2] - px) * kx, (seg[start + 3] - py) * ky];
            const [sx, sy] = [bx - ax, by - ay];
            const segLength = Math.hypot(sx, sy);
            if (segLength === 0) continue;
            // Running the same way: within about 30 degrees of the street.
            if (Math.abs(sx * dx + sy * dy) < 0.85 * segLength * length) continue;
            const u = Math.max(0, Math.min(1, -(ax * sx + ay * sy) / (segLength * segLength)));
            if (Math.hypot(ax + u * sx, ay + u * sy) <= BESIDE_METERS) {
              found = true;
              break;
            }
          }
        }
      }
      if (found) beside += 1;
    }
    return beside / samples;
  };
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
    console.error('Usage: node --max-old-space-size=12288 scripts/build-walking-tiles.js <data-dir>   (the folder npm run map:download fills)');
    process.exit(2);
  }

  const extracts = osmExtracts(dataDir);
  let streets;
  let paths;
  let meta;
  // Each line's class (PATH, STREET, ...); without OpenStreetMap, every line is a plain path.
  let classes = null;
  if (extracts.length > 0) {
    const names = extracts.map((file) => path.basename(file)).join(', ');
    console.log(`Reading OpenStreetMap's walkable ways (${names})...`);
    ({ lines: streets, classes } = await readOsmWays(extracts));
    paths = [];
    console.log(`  ${streets.length} walkable lines`);
    meta = { source: `OpenStreetMap (${names}; ODbL)`, credits: [OSM_CREDIT] };
  } else {
    console.log('No OpenStreetMap extracts in osm-pbf/: reading the public streets and paths...');
    streets = await readStreets(dataDir);
    paths = await readPaths(dataDir);
    const joined = joinPathEnds(paths, streets);
    console.log(`  ${streets.length} street lines, ${paths.length} paths and trails (${joined} ends joined to streets and paths)`);
    meta = { source: 'US Census Bureau TIGER/Line 2025, NYC Street Centerline, NYC Planimetric Database interior sidewalks, USGS National Digital Trails (public domain)', credits: [] };
  }

  // Every line as a run of point keys (wayStarts[i]..wayStarts[i + 1] in wayRefs), as the graph below reads them.
  const lines = [...streets, ...paths];
  const lineClass = (way) => (classes ? classes[way] : PATH);
  const besideShare = classes ? sidewalkIndex(lines, classes) : null;
  const wayRefs = new Float64List();
  const wayStarts = [0];
  for (const line of lines) {
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
  const counts = { besideSidewalks: 0, streets: 0, crossings: [0, 0, 0, 0] };
  for (let way = 0; way + 1 < wayStarts.length; way += 1) {
    const kind = lineClass(way);
    const isStreet = kind === STREET || kind === STREET_SIDEWALKS_SEPARATE;
    let from = -1;
    let meters = 0;
    // Meters of this edge with a sidewalk beside it (for streets).
    let beside = 0;
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
        beside = 0;
        continue;
      }
      const previous = refIndex[i - 1];
      const step = haversineMeters(lat[previous], lon[previous], lat[index], lon[index]);
      meters += step;
      if (kind === STREET && besideShare) beside += step * besideShare(lon[previous], lat[previous], lon[index], lat[index]);
      const isEnd = i + 1 === wayStarts[way + 1] || Number.isNaN(lat[refIndex[i + 1]]);
      if (isEnd || uses[index] > 1 || meters >= MAX_EDGE_METERS) {
        let cost = meters;
        if (isStreet) {
          counts.streets += 1;
          if (kind === STREET_SIDEWALKS_SEPARATE || beside >= meters / 2) {
            cost = meters * STREET_BESIDE_SIDEWALK;
            counts.besideSidewalks += 1;
          }
        } else if (CROSSING_COST[kind]) {
          cost = meters * CROSSING_COST[kind].per + CROSSING_COST[kind].plus;
          counts.crossings[kind - CROSSING_SIGNALS] += 1;
        }
        edges.push({ a: nodeFor(from), b: nodeFor(index), meters, cost });
        from = index;
        meters = 0;
        beside = 0;
      }
    }
  }
  console.log(`  ${nodes.length} graph nodes, ${edges.length} edges`);
  if (classes) {
    const [signals, marked, unmarked, unknown] = counts.crossings;
    console.log(`  ${counts.besideSidewalks} of ${counts.streets} street edges have their sidewalks mapped beside them; crossings: ${signals} at signals, ${marked} marked, ${unmarked} unmarked, ${unknown} untagged`);
  }

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
  const keptEdges = edges.filter((edge) => keptIndex[edge.a] >= 0).map((edge) => ({ a: keptIndex[edge.a], b: keptIndex[edge.b], meters: edge.meters, cost: edge.cost }));

  const result = writeWalkingTiles(OUT_DIR, keptNodes, keptEdges, meta);
  console.log(`Wrote ${result.tiles} tiles (${result.nodes} nodes, ${result.edges} edges, ${(result.bytes / 1e6).toFixed(1)} MB) to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
