// OpenStreetMap's footpaths, sports fields, transit roads, and platforms, read from Geofabrik's state
// extracts (<data-dir>/osm-pbf/*.osm.pbf, which `npm run map:download` fetches) rather than asked of
// the Overpass API square by square: the same ways, picked by the same rules as osm.mjs's and
// transitways.mjs's queries, written in the same form those modules read (one file per state in
// <data-dir>/osm), and the same snapshot the walking graph is built from. An extract is read twice:
// first the ways wanted (their tags and nodes), then those nodes' positions.
//
// OpenStreetMap data is © OpenStreetMap contributors, under the Open Database License: the map
// credits it (mapStyle.ts's MAP_ATTRIBUTION, shown by MapCredit, and Settings → About).
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { DETAIL } from './bounds.mjs';
import { isTrail } from './osm.mjs';

/** The file prefixes osm.mjs and transitways.mjs read (paths4_, transit1_), with the state after them. */
const PATHS_PREFIX = 'paths4_pbf_';
const TRANSIT_PREFIX = 'transit1_pbf_';
/** Nodes this far (degrees) outside the detailed area are kept too, so ways crossing its edge are clipped there, not cut short. */
const MARGIN = 0.05;
const round = (value) => Math.round(value * 1e6) / 1e6;

const TAGS = [
  'highway', 'footway', 'access', 'foot', 'indoor', 'area', 'leisure', 'bridge', 'tunnel', 'informal', 'surface',
  'bus', 'psv', 'service', 'public_transport', 'railway', 'name', 'oneway',
];

/** A footpath osm.mjs's query takes: footways (not crossings), paths, pedestrian streets, steps, and walkable bike paths, open to people on foot. */
function isFootpath(tags) {
  const open = tags.footway !== 'crossing' && !/^(private|no)$/.test(tags.access ?? '') && !/^(no|private)$/.test(tags.foot ?? '') && !tags.indoor && tags.area !== 'yes';
  if (!open) return false;
  if (/^(footway|path|pedestrian|steps)$/.test(tags.highway ?? '')) return true;
  return tags.highway === 'cycleway' && /^(yes|designated|permissive)$/.test(tags.foot ?? '');
}

const isField = (tags) => /^(pitch|stadium|track)$/.test(tags.leisure ?? '');

/** A transit road or platform transitways.mjs's query takes. */
function isTransitway(tags) {
  if (tags.highway === 'busway' || tags.highway === 'bus_guideway') return true;
  if (/^(service|unclassified)$/.test(tags.highway ?? '') && (/^(yes|designated)$/.test(tags.bus ?? '') || /^(yes|designated)$/.test(tags.psv ?? ''))) return true;
  if (tags.highway === 'service' && tags.service === 'bus') return true;
  if (tags.public_transport === 'platform' && tags.area === 'yes') return true;
  if (tags.railway === 'platform') return true;
  return tags.highway === 'platform' && tags.area === 'yes';
}

/** A growable Float64Array. */
class Float64List {
  constructor() { this.data = new Float64Array(1 << 16); this.length = 0; }
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

/** One extract's wanted ways, written as <osmDir>/paths4_pbf_<state>.json and transit1_pbf_<state>.json. */
async function extractState(file, osmDir, log) {
  const { OSMTransform } = await import('osm-pbf-parser-node');
  const blocks = (options) => createReadStream(file).pipe(new OSMTransform(options));
  const state = basename(file).replace(/-latest\.osm\.pbf$/, '');
  // Pass 1: the wanted ways, their tags, and their nodes (wayStarts[i]..wayStarts[i + 1] in refs).
  const ways = [];
  const refs = new Float64List();
  for await (const block of blocks({ withTags: { way: TAGS, node: false, relation: false }, withInfo: false })) {
    for (const item of block) {
      if (item.type !== 'way' || !item.tags) continue;
      const tags = item.tags;
      const kind = isFootpath(tags) ? 'path' : isField(tags) && !tags.highway ? 'field' : isTransitway(tags) ? 'transit' : null;
      if (!kind) continue;
      ways.push({ id: item.id, kind, tags, start: refs.length, end: refs.length + item.refs.length });
      for (const ref of item.refs) refs.push(ref);
    }
  }
  const all = refs.view();
  const needed = Float64Array.from(all).sort();
  let distinct = 0;
  for (let i = 0; i < needed.length; i += 1) if (i === 0 || needed[i] !== needed[i - 1]) needed[distinct++] = needed[i];
  const ids = needed.subarray(0, distinct);
  const lon = new Float64Array(ids.length).fill(Number.NaN);
  const lat = new Float64Array(ids.length).fill(Number.NaN);
  const indexOf = (id) => {
    let low = 0;
    let high = ids.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (ids[mid] === id) return mid;
      if (ids[mid] < id) low = mid + 1;
      else high = mid - 1;
    }
    return -1;
  };
  // Pass 2: those nodes' positions, in and just around the detailed area.
  const [west, south, east, north] = [DETAIL.west - MARGIN, DETAIL.south - MARGIN, DETAIL.east + MARGIN, DETAIL.north + MARGIN];
  reading: for await (const block of blocks({ withTags: false, withInfo: false })) {
    for (const item of block) {
      if (item.type === 'way') break reading; // Nodes come first in a sorted extract.
      if (item.type !== 'node' || item.lon < west || item.lon > east || item.lat < south || item.lat > north) continue;
      const index = indexOf(item.id);
      if (index >= 0) {
        lon[index] = round(item.lon);
        lat[index] = round(item.lat);
      }
    }
  }
  // Each way's positioned nodes, in runs (a node outside the area cuts the way: each run is a piece).
  const runsOf = ({ start, end }) => {
    const runs = [];
    let line = [];
    for (let i = start; i < end; i += 1) {
      const index = indexOf(all[i]);
      if (index >= 0 && !Number.isNaN(lon[index])) {
        line.push(lon[index], lat[index]);
        continue;
      }
      if (line.length >= 4) runs.push(line);
      line = [];
    }
    if (line.length >= 4) runs.push(line);
    return runs;
  };
  const paths = [];
  const fields = [];
  const roads = [];
  const platforms = [];
  for (const way of ways) {
    const runs = runsOf(way);
    if (runs.length === 0) continue;
    const { tags } = way;
    const brunnel = tags.bridge && tags.bridge !== 'no' ? 'bridge' : tags.tunnel && tags.tunnel !== 'no' ? 'tunnel' : '';
    const whole = runs.length === 1 && runs[0].length === (way.end - way.start) * 2 ? runs[0] : null;
    const closed = (line) => line.length >= 8 && line[0] === line[line.length - 2] && line[1] === line[line.length - 1];
    if (way.kind === 'path') {
      // A way cut into pieces at the area's edge: each piece under its own id (ids only dedupe ways across files).
      runs.forEach((line, i) => paths.push([runs.length === 1 ? way.id : `${way.id}#${i}`, brunnel, line, isTrail(tags) ? 1 : 0, tags.footway === 'sidewalk' ? 1 : 0]));
    } else if (way.kind === 'field') {
      // A field drawn as a closed outline, whole (one cut by the area's edge is left out, as a running track drawn as a line is).
      if (whole && closed(whole)) fields.push([way.id, whole]);
    } else {
      const isPlatform = tags.public_transport === 'platform' || tags.railway === 'platform' || tags.highway === 'platform';
      if (isPlatform) {
        if (whole && closed(whole)) platforms.push([way.id, tags.name ?? '', whole]);
        continue;
      }
      if (tags.access === 'private' && !tags.bus && !tags.psv) continue;
      const oneway = tags.oneway === 'yes' || tags.oneway === '1' ? 1 : tags.oneway === '-1' ? -1 : 0;
      runs.forEach((line, i) => roads.push([runs.length === 1 ? way.id : `${way.id}#${i}`, tags.name ?? '', brunnel, oneway, line]));
    }
  }
  const write = (path, value) => {
    writeFileSync(`${path}.partial`, JSON.stringify(value));
    renameSync(`${path}.partial`, path);
  };
  write(join(osmDir, `${TRANSIT_PREFIX}${state}.json`), { roads, platforms });
  // The paths file last: osm.mjs's hasOsmPaths looks for it, so a state half done is redone next time.
  write(join(osmDir, `${PATHS_PREFIX}${state}.json`), { paths, fields });
  log(`  ${state}: ${paths.length} footpaths, ${fields.length} fields, ${roads.length} transit roads, ${platforms.length} platforms`);
}

/**
 * Reads OpenStreetMap's footpaths, fields, transit roads, and platforms out of every extract in
 * <dir>/osm-pbf into <dir>/osm. A state already read from the same extract (its files newer than
 * the extract) is kept.
 */
export async function extractOsmFromPbf(dir, log = console.log) {
  const pbfDir = join(dir, 'osm-pbf');
  const files = existsSync(pbfDir) ? readdirSync(pbfDir).filter((name) => name.endsWith('.osm.pbf')).sort() : [];
  if (files.length === 0) {
    log(`No OpenStreetMap extracts in ${pbfDir}; skipped (npm run map:download fetches them)`);
    return;
  }
  const osmDir = join(dir, 'osm');
  mkdirSync(osmDir, { recursive: true });
  log(`Reading OpenStreetMap's footpaths and transit ways from ${files.length} extracts...`);
  for (const name of files) {
    const file = join(pbfDir, name);
    const state = name.replace(/-latest\.osm\.pbf$/, '');
    const out = join(osmDir, `${PATHS_PREFIX}${state}.json`);
    if (existsSync(out) && statSync(out).mtimeMs > statSync(file).mtimeMs) continue;
    await extractState(file, osmDir, log);
  }
}
