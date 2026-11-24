// Transit's own roads and platforms from OpenStreetMap: bus terminals' ramps and lanes, busways,
// and the service roads only buses may use (St George's Ramps A to D, say), which the Census road
// data (TIGER/Line) leaves out, plus the platforms riders wait on, bus and train alike, with their
// names. Roads join the road layer as `service` roads marked `transit` (and `oneway` where they
// run one way, for the arrows); platforms join the landuse layer as kind `platform`, named.
//
// OpenStreetMap data is © OpenStreetMap contributors, under the Open Database License: the map
// credits it (mapStyle.ts's source attribution, and Settings → About → Map data).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DETAIL } from './bounds.mjs';
import { clipPolygons, addLabel, addLines, addPolygons } from './sources.mjs';
import { labelPoint } from './geometry.mjs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
/** Squares this many degrees on a side; one too busy for the server is split in four. */
const STEP = 1;
const MAX_SPLITS = 3;
/** The fetched squares' file prefix; bumped when what's kept changes, so older fetches are ignored. */
const PREFIX = 'transit1_';

/** Whether `osmDir` holds fetched transit roads and platforms (any square). */
export function hasOsmTransitways(osmDir) {
  return existsSync(osmDir) && readdirSync(osmDir).some((name) => name.startsWith(PREFIX) && name.endsWith('.json'));
}
/** Transit roads show from this zoom (MapLibre's), with the other service roads. */
const ROAD_MINZOOM = 14;
/** Platforms show from this zoom; their names one later (mapStyle.ts). */
const PLATFORM_MINZOOM = 14;
const PLATFORM_LABEL_ZOOM = 15;

function query({ west, south, east, north }) {
  const box = `${south},${west},${north},${east}`;
  return `[out:json][timeout:180];
(
  way["highway"="busway"](${box});
  way["highway"="bus_guideway"](${box});
  way["highway"~"^(service|unclassified)$"]["bus"~"^(yes|designated)$"](${box});
  way["highway"~"^(service|unclassified)$"]["psv"~"^(yes|designated)$"](${box});
  way["highway"="service"]["service"="bus"](${box});
  way["public_transport"="platform"]["area"="yes"](${box});
  way["railway"="platform"](${box});
  way["highway"="platform"]["area"="yes"](${box});
);
out tags geom qt;`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (v) => Math.round(v * 1e6) / 1e6;

/**
 * One square's transit roads, as [id, name, brunnel, oneway (1, -1 against the drawing, or 0),
 * [lon, lat, ...]], and platforms, as [id, name, [lon, lat, ...] around]; null when the server gave up.
 */
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
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) return null;
      const roads = [];
      const platforms = [];
      for (const element of json.elements) {
        if (element.type !== 'way' || !Array.isArray(element.geometry) || element.geometry.length < 2) continue;
        const tags = element.tags ?? {};
        const line = element.geometry.flatMap(({ lon, lat }) => [round(lon), round(lat)]);
        const closed = line.length >= 8 && line[0] === line[line.length - 2] && line[1] === line[line.length - 1];
        const isPlatform = tags.public_transport === 'platform' || tags.railway === 'platform' || tags.highway === 'platform';
        if (isPlatform) {
          // Outlines only: a platform drawn as a line (a curb's edge) is left out.
          if (closed) platforms.push([element.id, tags.name ?? '', line]);
          continue;
        }
        if (tags.access === 'private' && !tags.bus && !tags.psv) continue;
        const brunnel = tags.bridge && tags.bridge !== 'no' ? 'bridge' : tags.tunnel && tags.tunnel !== 'no' ? 'tunnel' : '';
        const oneway = tags.oneway === 'yes' || tags.oneway === '1' ? 1 : tags.oneway === '-1' ? -1 : 0;
        roads.push([element.id, tags.name ?? '', brunnel, oneway, line]);
      }
      return { roads, platforms };
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(10_000);
    }
  }
  return null;
}

async function fetchInto(dir, box, depth) {
  const path = join(dir, `${PREFIX}${box.west.toFixed(4)}_${box.south.toFixed(4)}_${box.east.toFixed(4)}_${box.north.toFixed(4)}.json`);
  if (existsSync(path)) return 0;
  const found = await fetchSquare(box);
  if (found === null) {
    if (depth >= MAX_SPLITS) throw new Error(`the server couldn't answer for ${path} even split up`);
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
  writeFileSync(`${path}.partial`, JSON.stringify(found));
  renameSync(`${path}.partial`, path);
  // A pause between requests, as the Overpass API asks of bulk users.
  await sleep(2_000);
  return found.roads.length + found.platforms.length;
}

/** Fetches the detailed area's transit roads and platforms into <dir>/osm (squares already there are kept). */
export async function downloadOsmTransitways(dir, log = console.log) {
  const out = join(dir, 'osm');
  mkdirSync(out, { recursive: true });
  let total = 0;
  for (let west = DETAIL.west; west < DETAIL.east; west += STEP) {
    for (let south = DETAIL.south; south < DETAIL.north; south += STEP) {
      const box = { west, south, east: Math.min(west + STEP, DETAIL.east), north: Math.min(south + STEP, DETAIL.north) };
      try {
        total += await fetchInto(out, box, 0);
      } catch (error) {
        log(`  transit roads: ${error.message}; skipped (run the download again to retry)`);
      }
    }
  }
  log(`  ${total} transit roads and platforms fetched`);
}

/** Adds the fetched transit roads (once each: squares overlap at their edges) and platforms. */
export function addOsmTransitways(store, osmDir, log) {
  if (!existsSync(osmDir)) return;
  const seen = new Set();
  let roads = 0;
  let platforms = 0;
  for (const file of readdirSync(osmDir).filter((name) => name.startsWith(PREFIX) && name.endsWith('.json'))) {
    const found = JSON.parse(readFileSync(join(osmDir, file), 'utf8'));
    for (const [id, name, brunnel, oneway, line] of found.roads) {
      if (seen.has(id)) continue;
      seen.add(id);
      // Drawn the way traffic runs, so the arrows point right.
      const points = oneway === -1 ? reversed(line) : line;
      const props = { kind: 'service', transit: 1, ...(oneway ? { oneway: 1 } : {}), ...(brunnel ? { brunnel } : {}), ...(name ? { name } : {}) };
      if (addLines(store, 'road', ROAD_MINZOOM, props, [points], DETAIL) >= 0) roads += 1;
    }
    for (const [id, name, ring] of found.platforms) {
      if (seen.has(id)) continue;
      seen.add(id);
      const polygons = clipPolygons([[ring]], DETAIL);
      if (polygons.length === 0) continue;
      if (addPolygons(store, 'landuse', PLATFORM_MINZOOM, { kind: 'platform' }, polygons) >= 0) platforms += 1;
      if (name) {
        const [x, y] = labelPoint(polygons[0]);
        addLabel(store, 'landuse', PLATFORM_LABEL_ZOOM, { kind: 'platform', name }, x, y);
      }
    }
  }
  log(`  transit roads and platforms (OpenStreetMap): ${roads} roads, ${platforms} platforms`);
}

function reversed(line) {
  const out = [];
  for (let i = line.length - 2; i >= 0; i -= 2) out.push(line[i], line[i + 1]);
  return out;
}
