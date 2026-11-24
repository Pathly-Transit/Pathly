// Streets from OpenStreetMap: every road the map draws, from motorways to driveways, read from
// <data-dir>/osm/roads1_pbf_<state>.ndjson (osmpbf.mjs, from Geofabrik's state extracts). They
// replace TIGER/Line's roads, which keep streets that were planned but never built (Staten
// Island's Warren Street running on down a hill to Osgood Avenue, say) and know nothing of which
// way a one-way street runs. Names are shortened the way street signs and other maps show them
// (West 42nd Street as W 42nd St); route numbers become the signs' I-495, US 9, Rte 25, CR 10.
//
// OpenStreetMap data is © OpenStreetMap contributors, under the Open Database License: the map
// credits it (mapStyle.ts's MAP_ATTRIBUTION, shown by MapCredit, and Settings → About).
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { DETAIL } from './bounds.mjs';
import { ROADS_PREFIX } from './osmpbf.mjs';
import { addLines, joinedLines } from './sources.mjs';

const roadFiles = (osmDir) => (existsSync(osmDir) ? readdirSync(osmDir).filter((name) => name.startsWith(ROADS_PREFIX) && name.endsWith('.ndjson')).sort() : []);

/** Whether OpenStreetMap's streets have been read out of the extracts (osmpbf.mjs). */
export function hasOsmRoads(osmDir) {
  return roadFiles(osmDir).length > 0;
}

const SUFFIXES = {
  Street: 'St', Avenue: 'Ave', Boulevard: 'Blvd', Road: 'Rd', Drive: 'Dr', Place: 'Pl', Lane: 'Ln', Court: 'Ct',
  Parkway: 'Pkwy', Expressway: 'Expy', Highway: 'Hwy', Turnpike: 'Tpke', Terrace: 'Ter', Circle: 'Cir',
};
const DIRECTIONS = { North: 'N', South: 'S', East: 'E', West: 'W' };

/**
 * A street's name as signs show it: its last word shortened (Street as St), and a direction before
 * a number too (East 14th Street as E 14th St, but East Houston St keeps its East).
 */
export function signName(name) {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2 && SUFFIXES[words[words.length - 1]]) words[words.length - 1] = SUFFIXES[words[words.length - 1]];
  if (words.length >= 3 && DIRECTIONS[words[0]] && /^\d/.test(words[1])) words[0] = DIRECTIONS[words[0]];
  return words.join(' ');
}

/** The first route number on a way as signs show it (OpenStreetMap's "I 495;NY 25" as I-495). */
export function signRef(ref) {
  for (const raw of ref.split(';')) {
    const value = raw.trim();
    let match = value.match(/^I[\s-]*(\d+\w*)$/);
    if (match) return `I-${match[1]}`;
    match = value.match(/^US[\s-]*(\d+\w*)$/);
    if (match) return `US ${match[1]}`;
    match = value.match(/^(?:NY|NJ|CT|PA|MA|RI|DE|MD|VT|NH|VA|DC|SR)[\s-]*(\d+\w*)$/);
    if (match) return `Rte ${match[1]}`;
    match = value.match(/^(?:\w+\s)?(?:CR|County Route|County Road)[\s-]*(\w+)$/);
    if (match) return `CR ${match[1]}`;
  }
  return undefined;
}

/** Driveways and the like, shown only up close (TIGER's parking-lot roads waited as long). */
const MINOR_SERVICE = /^(driveway|parking_aisle|drive-through|emergency_access)$/;

/** A street's road-layer kind and the zoom it shows from, by its OpenStreetMap class. */
function streetKind(highway, service) {
  switch (highway) {
    case 'motorway': return { kind: 'motorway', minzoom: 4 };
    // Ramps wait for street level, like Google's (further out they were scattered dashes).
    case 'motorway_link': return { kind: 'motorway', minzoom: 12, link: true };
    case 'trunk': return { kind: 'primary', minzoom: 7 };
    case 'primary': return { kind: 'primary', minzoom: 8 };
    case 'trunk_link':
    case 'primary_link': return { kind: 'primary', minzoom: 12, link: true };
    case 'secondary': return { kind: 'secondary', minzoom: 9 };
    case 'secondary_link': return { kind: 'secondary', minzoom: 12, link: true };
    case 'tertiary': return { kind: 'tertiary', minzoom: 10 };
    case 'tertiary_link': return { kind: 'tertiary', minzoom: 12, link: true };
    case 'service': return { kind: 'service', minzoom: MINOR_SERVICE.test(service) ? 14 : 13 };
    case 'track': return { kind: 'path', minzoom: 13, trail: true };
    default: return { kind: 'minor', minzoom: 11 };
  }
}

/** A street's road-layer properties and minzoom. */
function streetProps([, highway, name, ref, brunnel, , service]) {
  const { kind, minzoom, link, trail } = streetKind(highway, service);
  const props = { kind };
  if (link) props.link = 1;
  if (trail) props.trail = 1;
  if (brunnel && kind !== 'path') props.brunnel = brunnel;
  if (name && !link) props.name = signName(name);
  const sign = ref ? signRef(ref) : undefined;
  if (sign && (kind === 'motorway' || kind === 'primary' || kind === 'secondary')) props.ref = sign;
  return { props, minzoom };
}

function reversed(line) {
  const out = [];
  for (let i = line.length - 2; i >= 0; i -= 2) out.push(line[i], line[i + 1]);
  return out;
}

/**
 * Adds OpenStreetMap's streets to the road layer (each once: ways near a state line are in both
 * states' files). Two-way streets are joined end to end where they share a name and class, so a
 * street is one line to label; one-way streets stay drawn the way traffic runs, marked `oneway`
 * (the style's arrows follow the line), motorways aside (no arrows on a highway).
 */
export async function addOsmRoads(store, osmDir, log) {
  const seen = new Set();
  let count = 0;
  let oneways = 0;
  for (const file of roadFiles(osmDir)) {
    const records = [];
    const lines = createInterface({ input: createReadStream(join(osmDir, file)), crlfDelay: Infinity });
    for await (const text of lines) {
      if (!text) continue;
      const way = JSON.parse(text);
      if (seen.has(way[0])) continue;
      seen.add(way[0]);
      const { props, minzoom } = streetProps(way);
      const oneway = way[5];
      if (oneway && props.kind !== 'motorway') {
        if (addLines(store, 'road', minzoom, { ...props, oneway: 1 }, [oneway === -1 ? reversed(way[7]) : way[7]], DETAIL) >= 0) {
          count += 1;
          oneways += 1;
        }
        continue;
      }
      records.push({ parts: [way[7]], attrs: { props, minzoom } });
    }
    // Segments two ways share (rare in OpenStreetMap) take the first way's class.
    for (const { props, minzoom, line } of joinedLines(records, (list) => list[0], DETAIL)) if (addLines(store, 'road', minzoom, props, [line], DETAIL) >= 0) count += 1;
  }
  log(`  streets (OpenStreetMap): ${count} lines, ${oneways} one-way`);
}
