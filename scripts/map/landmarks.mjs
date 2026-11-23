// Landmarks from Wikidata: the stadiums, malls, museums, zoos, and sights people find their way by,
// as named points in the `landmark` layer. Only places with an English Wikipedia article come along,
// which keeps it to the notable ones (a city's big museum, not every gallery), the way Google's map
// names landmarks long before it shows every shop; and only ones still standing and in use (not
// demolished, closed, or never built). Campuses, hospitals, cemeteries, parks, and stations are
// named from their own sources (sources.mjs), so a landmark with the same name nearby is left out.
//
// Wikidata's data is public domain (CC0): the map needs no credit for it (Settings → About lists it).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DETAIL } from './bounds.mjs';
import { insideBox } from './geometry.mjs';
import { nameKey } from './schema.mjs';
import { POINT } from './store.mjs';

const ENDPOINT = 'https://query.wikidata.org/sparql';
/** Squares this many degrees on a side; one the service can't answer in time is split in four. */
const STEP = 1;
const MAX_SPLITS = 2;
/** The fetched squares' file prefix; bumped when what's kept changes, so older fetches are ignored. */
const PREFIX = 'landmarks_wd1_';

/**
 * Kinds of landmark: the Wikidata classes each covers (their subclasses too), the zoom (MapLibre's)
 * each shows from, and its rank (lower wins a crowded spot). Big venues first; museums and sights at
 * street level. A place in several kinds takes the first.
 */
export const LANDMARK_KINDS = {
  stadium: { classes: ['Q483110', 'Q641226'], minzoom: 13, rank: 10 }, // stadium, arena
  zoo: { classes: ['Q43501'], minzoom: 13, rank: 12 },
  aquarium: { classes: ['Q2281788'], minzoom: 13, rank: 12 }, // public aquarium
  theme_park: { classes: ['Q2416723', 'Q194195'], minzoom: 13, rank: 12 }, // theme park, amusement park
  mall: { classes: ['Q11315'], minzoom: 13, rank: 14 }, // shopping mall
  museum: { classes: ['Q33506', 'Q1007870'], minzoom: 14, rank: 20 }, // museum, art gallery
  theatre: { classes: ['Q24354', 'Q153562', 'Q1060829'], minzoom: 14, rank: 24 }, // theater building, opera house, concert hall
  attraction: { classes: ['Q570116'], direct: true, minzoom: 14, rank: 26 }, // tourist attraction (itself, not every kind of one)
};
const KIND_ORDER = Object.keys(LANDMARK_KINDS);

/** Kinds of place that are gone or never were: not standing landmarks. */
const GONE = ['Q811683', 'Q1570262', 'Q105821051', 'Q74539696', 'Q15893266', 'Q19860854'];

function query({ west, south, east, north }) {
  const byClass = Object.entries(LANDMARK_KINDS).filter(([, kind]) => !kind.direct).flatMap(([name, kind]) => kind.classes.map((q) => `(wd:${q} "${name}")`)).join(' ');
  const direct = Object.entries(LANDMARK_KINDS).filter(([, kind]) => kind.direct)
    .map(([name, kind]) => `{ ?item wdt:P31 ?class . VALUES ?class { ${kind.classes.map((q) => `wd:${q}`).join(' ')} } BIND("${name}" AS ?kind) }`);
  return `SELECT DISTINCT ?item ?itemLabel ?coord ?kind WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${west} ${south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${east} ${north})"^^geo:wktLiteral .
  }
  { VALUES (?class ?kind) { ${byClass} } ?item wdt:P31/wdt:P279* ?class . }
  ${direct.map((branch) => `UNION ${branch}`).join('\n  ')}
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  FILTER NOT EXISTS { ?item wdt:P576 [] }
  FILTER NOT EXISTS { ?item wdt:P3999 [] }
  FILTER NOT EXISTS { ?item wdt:P5817 ?state . FILTER(?state != wd:Q55654238) }
  FILTER NOT EXISTS { ?item wdt:P31 ?gone . VALUES ?gone { ${GONE.map((q) => `wd:${q}`).join(' ')} } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One square's landmarks as [kind, name, lon, lat, Wikidata id]; null when the service ran out of time. */
async function fetchSquare(box) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${ENDPOINT}?format=json&query=${encodeURIComponent(query(box))}`, {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'PathlyMapBuild/1.0 (https://pathly.web.app)' },
    });
    if (response.status === 429 || response.status === 503) {
      await sleep(Number(response.headers.get('retry-after') ?? 0) * 1000 || 20_000 * (attempt + 1));
      continue;
    }
    // The gateway gave up waiting: usually a query that ran long. Once more, then smaller squares.
    if (response.status === 502 || response.status === 504) {
      if (attempt >= 1) return null;
      await sleep(15_000);
      continue;
    }
    // A query past the service's time limit comes back as a server error naming the timeout.
    if (response.status === 500) {
      const text = await response.text();
      if (/timeout|TimeoutException/i.test(text)) return null;
      throw new Error(`HTTP 500: ${text.slice(0, 120)}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    const byItem = new Map();
    for (const row of json.results.bindings) {
      const id = row.item.value.split('/').pop();
      const name = row.itemLabel?.value;
      const point = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(row.coord?.value ?? '');
      // Unlabeled items come back labeled with their own id.
      if (!point || !name || /^Q\d+$/.test(name)) continue;
      const kind = row.kind.value;
      const previous = byItem.get(id);
      if (previous && KIND_ORDER.indexOf(previous[0]) <= KIND_ORDER.indexOf(kind)) continue;
      byItem.set(id, [kind, name, Math.round(Number(point[1]) * 1e6) / 1e6, Math.round(Number(point[2]) * 1e6) / 1e6, id]);
    }
    return [...byItem.values()];
  }
  throw new Error('the service stayed busy');
}

async function fetchInto(dir, box, depth, log) {
  const path = join(dir, `${PREFIX}${box.west.toFixed(4)}_${box.south.toFixed(4)}_${box.east.toFixed(4)}_${box.north.toFixed(4)}.json`);
  if (existsSync(path)) return 0;
  const landmarks = await fetchSquare(box);
  // A pause between requests, as the query service asks of bulk users.
  await sleep(2_000);
  if (landmarks === null) {
    if (depth >= MAX_SPLITS) throw new Error(`the service couldn't answer for ${path} even split up`);
    const midX = (box.west + box.east) / 2;
    const midY = (box.south + box.north) / 2;
    let count = 0;
    for (const quarter of [
      { west: box.west, south: box.south, east: midX, north: midY },
      { west: midX, south: box.south, east: box.east, north: midY },
      { west: box.west, south: midY, east: midX, north: box.north },
      { west: midX, south: midY, east: box.east, north: box.north },
    ]) count += await fetchInto(dir, quarter, depth + 1, log);
    return count;
  }
  writeFileSync(`${path}.partial`, JSON.stringify(landmarks));
  renameSync(`${path}.partial`, path);
  return landmarks.length;
}

/** Fetches the detailed area's landmarks into <dir>/wikidata (squares already there are kept). */
export async function downloadWikidataLandmarks(dir, log = console.log) {
  const out = join(dir, 'wikidata');
  mkdirSync(out, { recursive: true });
  log('Fetching landmarks from Wikidata...');
  let total = 0;
  for (let west = DETAIL.west; west < DETAIL.east; west += STEP) {
    for (let south = DETAIL.south; south < DETAIL.north; south += STEP) {
      const box = { west, south, east: Math.min(west + STEP, DETAIL.east), north: Math.min(south + STEP, DETAIL.north) };
      try {
        total += await fetchInto(out, box, 0, log);
      } catch (error) {
        log(`  landmarks: ${error.message}; skipped (run the download again to retry)`);
      }
    }
  }
  log(`  ${total} landmarks fetched`);
}

/**
 * Adds the fetched landmarks to the `landmark` layer: once each (squares overlap at their edges),
 * and not where the map already names the same place nearby (a park, a campus, a station).
 */
export function addWikidataLandmarks(store, wikidataDir, log) {
  const files = existsSync(wikidataDir) ? readdirSync(wikidataDir).filter((name) => name.startsWith(PREFIX) && name.endsWith('.json')) : [];
  if (files.length === 0) {
    log(`  landmarks (Wikidata): none in ${wikidataDir}; skipped (npm run map:download fetches them)`);
    return;
  }
  const named = new Map();
  const remember = (key, x, y) => {
    const list = named.get(key) ?? [];
    list.push({ x, y });
    named.set(key, list);
  };
  for (let index = 0; index < store.count; index += 1) {
    if (store.deleted.array[index] || store.type.array[index] !== POINT) continue;
    const name = store.propsOf(index).name;
    if (!name) continue;
    const { west, south } = store.boundsOf(index);
    remember(nameKey(name), west, south);
  }
  const near = (key, x, y) => (named.get(key) ?? []).some((p) => Math.abs(p.x - x) < 0.015 && Math.abs(p.y - y) < 0.012);
  const seen = new Set();
  let count = 0;
  let alreadyNamed = 0;
  for (const file of files) {
    for (const [kind, name, x, y, id] of JSON.parse(readFileSync(join(wikidataDir, file), 'utf8'))) {
      if (seen.has(id) || !insideBox(DETAIL, x, y) || !LANDMARK_KINDS[kind]) continue;
      seen.add(id);
      const key = nameKey(name);
      if (near(key, x, y)) {
        alreadyNamed += 1;
        continue;
      }
      remember(key, x, y);
      const { minzoom, rank } = LANDMARK_KINDS[kind];
      store.add('landmark', POINT, minzoom, { kind, name, rank }, [[x, y]]);
      count += 1;
    }
  }
  log(`  landmarks (Wikidata): ${count} (${alreadyNamed} already named on the map left out)`);
}
