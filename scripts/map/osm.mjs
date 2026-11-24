// Footpaths from OpenStreetMap: the walkways, campus paths, park trails, steps, and pedestrian
// streets that TIGER/Line mostly leaves out (a college campus like Stony Brook's is nearly blank in
// it). Fetched from the Overpass API in squares over the detailed area, kept as compact JSON, and
// added to the road layer as kind `path`, less the short dead-end stubs (to a door, a bench, a
// parking spot) and small loops (around a planter or a fountain) that would only clutter the map.
// Sidewalks come along only where no street runs beside them (a campus walk tagged as a sidewalk);
// along a street they'd only double its line. Informal and unpaved paths (worn shortcuts, dirt
// trails) are marked `trail` (drawn dashed), and
// sports fields, courts, and stadiums come along too, added to the park layer as kind `pitch`.
//
// OpenStreetMap data is © OpenStreetMap contributors, under the Open Database License: the map
// credits it (mapStyle.ts's source attribution, and Settings → About → Map data).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DETAIL } from './bounds.mjs';
import { boxContainsBox, clipLine, orient, ringAreaMeters, ringBounds, zoomForArea } from './geometry.mjs';
import { addPolygons, clipPolygons } from './sources.mjs';
import { LINE } from './store.mjs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
/** Squares this many degrees on a side; one that's too busy for the server is split in four. */
const STEP = 0.5;
const MAX_SPLITS = 3;
/** Footpaths show from this zoom (MapLibre's), like TIGER's walkways. */
const PATH_MINZOOM = 13;
/**
 * Dead-end paths shorter than this (meters), a few rounds over so a branch of stubs counts too, are
 * marked `stub`: kept only in the last zoom's tiles, and drawn only zoomed in close (mapStyle.ts).
 */
const STUB_METERS = 50;
const STUB_ROUNDS = 3;
const STUB_MINZOOM = 14;
/** Closed loops shorter than this all the way around (meters: around a planter, a fountain, a building) are left out. */
const LOOP_METERS = 150;
/** The fetched squares' file prefix; bumped when what's kept changes, so older fetches are ignored. */
const PREFIX = 'paths4_';

/** Whether `osmDir` holds fetched footpaths (any square). */
export function hasOsmPaths(osmDir) {
  return existsSync(osmDir) && readdirSync(osmDir).some((name) => name.startsWith(PREFIX) && name.endsWith('.json'));
}
/** A sidewalk is beside a street when most of it is within this many meters of one (TIGER's centerlines). */
const BESIDE_STREET_METERS = 25;
const BESIDE_SHARE = 0.6;
/** Sidewalks are checked at points this far apart (meters). */
const SAMPLE_METERS = 10;
/** Fields show from this zoom (MapLibre's), small courts later (when they're a few pixels across). */
const FIELD_MINZOOM = 13;
/** Surfaces that make a path a trail rather than a walkway. */
const UNPAVED = /^(unpaved|dirt|earth|ground|grass|gravel|fine_gravel|mud|sand|woodchips|rock|pebblestone|compacted)$/;

/**
 * The ways a walker can use that aren't streets: footways (crossings left out: they just cross a
 * street), sidewalks (sorted out at build time, addOsmPaths), paths, pedestrian streets, and steps,
 * plus bike paths only where they're also meant for walking. Bike-only paths, bridleways, private
 * or closed ways, indoor corridors, and plazas drawn as areas are left out.
 */
function query({ west, south, east, north }) {
  const box = `${south},${west},${north},${east}`;
  const open = '["footway"!="crossing"]["access"!~"^(private|no)$"]["foot"!~"^(no|private)$"]["indoor"!~"."]["area"!="yes"]';
  return `[out:json][timeout:180];
(
  way["highway"~"^(footway|path|pedestrian|steps)$"]${open}(${box});
  way["highway"="cycleway"]["foot"~"^(yes|designated|permissive)$"]${open}(${box});
  way["leisure"~"^(pitch|stadium|track)$"](${box});
);
out tags geom qt;`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A path that's informal or unpaved: a worn shortcut, a dirt or gravel trail, a `path` with no paving given. */
export function isTrail(tags) {
  if (tags.informal === 'yes') return true;
  if (tags.surface) return UNPAVED.test(tags.surface);
  return tags.highway === 'path';
}

/**
 * One square's footpaths, as [id, bridge|tunnel|'', [lon, lat, ...], 1 for a trail, 1 for a
 * sidewalk], and fields, as
 * [id, [lon, lat, ...] around]; null when the server gave up on it.
 */
async function fetchSquare(box) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(OVERPASS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Pathly map build' },
        body: `data=${encodeURIComponent(query(box))}`,
      });
      // Busy: wait and ask again.
      if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) {
        await sleep(15_000 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      // A query that ran out of time or memory comes back as a remark, not an error status.
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) return null;
      const paths = [];
      const fields = [];
      for (const element of json.elements) {
        if (element.type !== 'way' || !Array.isArray(element.geometry) || element.geometry.length < 2) continue;
        const tags = element.tags ?? {};
        const line = element.geometry.flatMap(({ lon, lat }) => [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]);
        if (tags.leisure && !tags.highway) {
          // A field drawn as a closed outline (a running track drawn as a line is left out).
          const end = line.length - 2;
          if (line.length >= 8 && line[0] === line[end] && line[1] === line[end + 1]) fields.push([element.id, line]);
          continue;
        }
        const brunnel = tags.bridge && tags.bridge !== 'no' ? 'bridge' : tags.tunnel && tags.tunnel !== 'no' ? 'tunnel' : '';
        paths.push([element.id, brunnel, line, isTrail(tags) ? 1 : 0, tags.footway === 'sidewalk' ? 1 : 0]);
      }
      return { paths, fields };
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(10_000);
    }
  }
  return null;
}

/** Fetches a square into `dir`, split into four when it's too much for one request. */
async function fetchInto(dir, box, depth) {
  const name = `${PREFIX}${box.west.toFixed(4)}_${box.south.toFixed(4)}_${box.east.toFixed(4)}_${box.north.toFixed(4)}.json`;
  const path = join(dir, name);
  if (existsSync(path)) return 0;
  const ways = await fetchSquare(box);
  if (ways === null) {
    if (depth >= MAX_SPLITS) throw new Error(`the server couldn't answer for ${name} even split up`);
    const midX = (box.west + box.east) / 2;
    const midY = (box.south + box.north) / 2;
    let count = 0;
    for (const quarter of [
      { west: box.west, south: box.south, east: midX, north: midY },
      { west: midX, south: box.south, east: box.east, north: midY },
      { west: box.west, south: midY, east: midX, north: box.north },
      { west: midX, south: midY, east: box.east, north: box.north },
    ]) count += await fetchInto(dir, quarter, depth + 1);
    return count;
  }
  writeFileSync(`${path}.partial`, JSON.stringify(ways));
  renameSync(`${path}.partial`, path);
  // A pause between requests, as the Overpass API asks of bulk users.
  await sleep(2_000);
  return ways.paths.length;
}

/** Fetches the detailed area's footpaths into <dir>/osm (squares already there are kept). */
export async function downloadOsmPaths(dir, log = console.log) {
  const out = join(dir, 'osm');
  mkdirSync(out, { recursive: true });
  const squares = [];
  for (let west = DETAIL.west; west < DETAIL.east; west += STEP) {
    for (let south = DETAIL.south; south < DETAIL.north; south += STEP) {
      squares.push({ west, south, east: Math.min(west + STEP, DETAIL.east), north: Math.min(south + STEP, DETAIL.north) });
    }
  }
  log(`Fetching OpenStreetMap footpaths in ${squares.length} squares...`);
  let total = 0;
  for (const [index, square] of squares.entries()) {
    try {
      total += await fetchInto(out, square, 0);
    } catch (error) {
      // Left out, like any source that fails: the build says which squares are missing.
      log(`  square ${index + 1}: ${error.message}; skipped (run the download again to retry)`);
    }
    if ((index + 1) % 10 === 0) log(`  ${index + 1} of ${squares.length} squares`);
  }
  log(`  ${total} footpaths fetched`);
}

function lineMeters(line) {
  let meters = 0;
  for (let i = 2; i < line.length; i += 2) {
    const dy = (line[i + 1] - line[i - 1]) * 111_320;
    const dx = (line[i] - line[i - 2]) * 111_320 * Math.cos((line[i - 1] * Math.PI) / 180);
    meters += Math.hypot(dx, dy);
  }
  return meters;
}

// ── Sidewalks beside streets ────────────────────────────────────────────────────────────────

/** Grid cells about 45 m on a side, for finding the streets near a point. */
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
 * The sidewalks to leave out: those running beside a street already on the map (most of their
 * length within BESIDE_STREET_METERS of one). Streets are indexed only where sidewalks are.
 */
function sidewalksBesideStreets(store, sidewalks) {
  const samples = new Map(sidewalks.map(([id, line]) => [id, samplePoints(line)]));
  const wanted = new Set();
  for (const points of samples.values()) for (let i = 0; i < points.length; i += 2) wanted.add(cellKey(points[i], points[i + 1]));
  // Street segments by cell, each in every cell within reach of it.
  const reach = BESIDE_STREET_METERS / 111_320 / Math.cos((41 * Math.PI) / 180);
  const grid = new Map();
  for (let index = 0; index < store.count; index += 1) {
    if (store.deleted.array[index] || store.layerName(index) !== 'road' || store.propsOf(index).kind === 'path') continue;
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
  const beside = new Set();
  for (const [id, points] of samples) {
    let close = 0;
    for (let i = 0; i < points.length; i += 2) {
      const [x, y] = [points[i], points[i + 1]];
      if ((grid.get(cellKey(x, y)) ?? []).some(([ax, ay, bx, by]) => segmentMeters(x, y, ax, ay, bx, by) <= BESIDE_STREET_METERS)) close += 1;
    }
    if (close >= (points.length / 2) * BESIDE_SHARE) beside.add(id);
  }
  return beside;
}

/**
 * Adds the fetched footpaths to the road layer as kind `path` (a way in two squares, once). Sidewalks
 * beside a street on the map are left out (needs the streets added first: addRoads), and so are
 * small closed loops. A short path with an end no other path touches (a stub to a door, a bench, a
 * parking spot), found repeatedly, is kept for close in only. OpenStreetMap's paths share their junction points,
 * so ends are matched exactly.
 */
export function addOsmPaths(store, osmDir, log) {
  const files = existsSync(osmDir) ? readdirSync(osmDir).filter((name) => name.startsWith(PREFIX) && name.endsWith('.json')) : [];
  if (files.length === 0) {
    log(`  footpaths: none in ${osmDir}; skipped (npm run map:download fetches them)`);
    return;
  }
  const ways = new Map();
  const fields = new Map();
  for (const file of files) {
    const square = JSON.parse(readFileSync(join(osmDir, file), 'utf8'));
    for (const [id, brunnel, line, trail, sidewalk] of square.paths) if (!ways.has(id)) ways.set(id, { brunnel, line, trail, sidewalk });
    for (const [id, ring] of square.fields) if (!fields.has(id)) fields.set(id, ring);
  }
  // Small loops first: a ring around a planter or a fountain isn't a way anywhere.
  let loops = 0;
  for (const [id, { line }] of ways) {
    const end = line.length - 2;
    if (line[0] === line[end] && line[1] === line[end + 1] && lineMeters(line) < LOOP_METERS) {
      ways.delete(id);
      loops += 1;
    }
  }
  // Sidewalks beside a street: the street's own line already shows the way.
  const besideStreets = sidewalksBesideStreets(store, [...ways].filter(([, way]) => way.sidewalk).map(([id, way]) => [id, way.line]));
  for (const id of besideStreets) ways.delete(id);
  const sidewalksKept = [...ways.values()].filter((way) => way.sidewalk).length;
  // Then short dead ends, a few rounds over: setting one stub aside can leave the stub it hung off.
  const key = (x, y) => `${x},${y}`;
  let stubs = 0;
  for (let round = 0; round < STUB_ROUNDS; round += 1) {
    // How many paths (other than stubs) pass through each point.
    const touching = new Map();
    for (const { line, stub } of ways.values()) {
      if (stub) continue;
      const points = new Set();
      for (let i = 0; i < line.length; i += 2) points.add(key(line[i], line[i + 1]));
      for (const point of points) touching.set(point, (touching.get(point) ?? 0) + 1);
    }
    const joined = (line, i) => (touching.get(key(line[i], line[i + 1])) ?? 0) > 1;
    let marked = 0;
    for (const way of ways.values()) {
      if (way.stub) continue;
      const end = way.line.length - 2;
      if ((!joined(way.line, 0) || !joined(way.line, end)) && lineMeters(way.line) < STUB_METERS) {
        way.stub = true;
        marked += 1;
      }
    }
    stubs += marked;
    if (marked === 0) break;
  }
  let count = 0;
  let trails = 0;
  for (const { brunnel, line, trail, stub } of ways.values()) {
    const parts = boxContainsBox(DETAIL, ringBounds(line)) ? [line] : clipLine(line, DETAIL);
    if (parts.length === 0) continue;
    const props = { kind: 'path' };
    if (brunnel) props.brunnel = brunnel;
    if (trail) props.trail = 1;
    if (stub) props.stub = 1;
    store.add('road', LINE, stub ? STUB_MINZOOM : PATH_MINZOOM, props, parts);
    count += 1;
    trails += trail ? 1 : 0;
  }
  let fieldCount = 0;
  for (const ring of fields.values()) {
    const outline = orient(ring.slice(0, -2), true);
    const polygons = clipPolygons([[outline]], DETAIL);
    const area = ringAreaMeters(outline);
    if (addPolygons(store, 'park', Math.max(FIELD_MINZOOM, zoomForArea(Math.abs(area), 16)), { kind: 'pitch' }, polygons) >= 0) fieldCount += 1;
  }
  log(`  footpaths (OpenStreetMap): ${count} lines, ${trails} of them trails and ${stubs} short dead ends for close in (${besideStreets.size} sidewalks beside streets and ${loops} small loops left out; ${sidewalksKept} sidewalks away from streets kept); ${fieldCount} sports fields`);
}
