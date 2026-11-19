// Reads the map's sources into the feature store. Every source is public-domain government data or
// Pathly's own, so the map needs no credit line:
//   US Census Bureau TIGER/Line 2025: states, roads, rail, water, parks and landmarks, places
//   US Census Bureau population estimates (sub-est2024.csv): town sizes, for label priority
//   USGS Geographic Names Information System (GNIS): neighborhoods, bays, islands
//   NYC Open Data building footprints (City of New York)
//   Natural Earth: coastlines, lakes, highways, and cities around the detailed area (zoomed out)
//   The transit agencies' public GTFS feeds (the ones Pathly routes on): stations, ferry routes
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { DETAIL, MAX_ZOOM, OVERVIEW, OVERVIEW_STRIPS, tileBounds, tilesIn } from './bounds.mjs';
import { dissolve, sharedEdges } from './dissolve.mjs';
import { boxContainsBox, boxesOverlap, clipLine, clipPolygon, insideBox, labelPoint, orient, pointInRing, ringArea2, ringAreaMeters, ringBounds, zoomForArea } from './geometry.mjs';
import { nameKey, spellOut } from './schema.mjs';
import { readShapefileZip } from './shapefile.mjs';
import { Grow, LINE, POINT, POLYGON } from './store.mjs';
import { readZip } from './zip.mjs';

const Q = 1e7;
/** The states whose landmarks, places, and names the detailed area draws on. */
const STATES = ['36', '34', '09', '44', '25', '42'];
const GNIS_STATES = ['NY', 'NJ', 'CT', 'RI', 'MA', 'PA'];

// ── Geometry helpers ──────────────────────────────────────────────────────────

function boundsOf(parts) {
  return parts.map(ringBounds).reduce((a, b) => ({ west: Math.min(a.west, b.west), south: Math.min(a.south, b.south), east: Math.max(a.east, b.east), north: Math.max(a.north, b.north) }));
}

function dropClosing(ring) {
  const n = ring.length;
  return n >= 4 && ring[0] === ring[n - 2] && ring[1] === ring[n - 1] ? ring.slice(0, n - 2) : ring;
}

/** Rings whose owner is found by testing a couple of their points (a hole can touch its outer ring at one). */
function ringInside(outer, ring) {
  const n = ring.length / 2;
  return pointInRing(outer, ring[0], ring[1]) || pointInRing(outer, ring[2 * Math.floor(n / 2)], ring[2 * Math.floor(n / 2) + 1]);
}

/** A shapefile's polygon rings as polygons [outer, ...holes]: shapefile outer rings run clockwise. */
export function shapePolygons(parts) {
  const outers = [];
  const holes = [];
  for (const raw of parts) {
    const ring = dropClosing(raw);
    if (ring.length < 6) continue;
    if (ringArea2(ring) < 0) outers.push(orient(ring, true));
    else holes.push(orient(ring, false));
  }
  if (holes.length === 0) return outers.map((ring) => [ring]);
  const polygons = outers.map((ring) => ({ rings: [ring], box: ringBounds(ring), area: Math.abs(ringArea2(ring)) })).sort((a, b) => a.area - b.area);
  for (const hole of holes) {
    const owner = polygons.find((polygon) => insideBox(polygon.box, hole[0], hole[1]) && ringInside(polygon.rings[0], hole));
    if (owner) owner.rings.push(hole);
  }
  return polygons.map((polygon) => polygon.rings);
}

/** GeoJSON (Multi)Polygon coordinates as polygons [outer, ...holes]. */
function geojsonPolygons(geometry) {
  const list = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return list.map((rings) => rings.map((ring, i) => orient(dropClosing(ring.flat()), i === 0)).filter((ring) => ring.length >= 6)).filter((rings) => rings.length > 0);
}

function geojsonLines(geometry) {
  const list = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
  return list.map((line) => line.flat()).filter((line) => line.length >= 4);
}

function polygonsArea(polygons) {
  let area = 0;
  for (const polygon of polygons) {
    let polygonArea = ringAreaMeters(polygon[0]);
    for (let i = 1; i < polygon.length; i += 1) polygonArea -= ringAreaMeters(polygon[i]);
    area += Math.max(0, polygonArea);
  }
  return area;
}

function clipPolygons(polygons, box) {
  const out = [];
  for (const polygon of polygons) {
    const clipped = boxContainsBox(box, ringBounds(polygon[0])) ? polygon : clipPolygon(polygon, box);
    if (clipped) out.push(clipped);
  }
  return out;
}

/**
 * A polygon split along tile edges into pieces of at most ~4,000 points. One polygon spanning
 * several states, with thousands of lakes cut out of it, is more than a renderer can reliably fill
 * once it's simplified for a zoomed-out tile; neighboring pieces of one color show no seam.
 */
function splitLarge(polygon, z = 4) {
  const points = polygon.reduce((sum, ring) => sum + ring.length / 2, 0);
  if (points <= 4000 || z > 12) return [polygon];
  const box = ringBounds(polygon[0]);
  const range = tilesIn(box, z);
  const out = [];
  for (let x = range.minX; x <= range.maxX; x += 1) {
    for (let y = range.minY; y <= range.maxY; y += 1) {
      const clipped = clipPolygon(polygon, tileBounds(z, x, y));
      if (clipped) out.push(...splitLarge(clipped, z + 1));
    }
  }
  return out;
}

function addPolygons(store, layer, minzoom, props, polygons) {
  if (polygons.length === 0 || minzoom > MAX_ZOOM) return -1;
  const parts = [];
  const outer = [];
  for (const polygon of polygons) {
    polygon.forEach((ring, i) => {
      parts.push(ring);
      outer.push(i === 0);
    });
  }
  return store.add(layer, POLYGON, minzoom, props, parts, outer);
}

function addLines(store, layer, minzoom, props, lines, box) {
  const parts = [];
  for (const line of lines) {
    if (boxContainsBox(box, ringBounds(line))) parts.push(line);
    else parts.push(...clipLine(line, box));
  }
  return parts.length && minzoom <= MAX_ZOOM ? store.add(layer, LINE, minzoom, props, parts) : -1;
}

/** A label point; past the last zoom it carries the zoom it shows from (`lz`). */
function addLabel(store, layer, labelZoom, props, x, y) {
  if (!insideBox(OVERVIEW, x, y)) return -1;
  return store.add(layer, POINT, Math.min(labelZoom, MAX_ZOOM), labelZoom > MAX_ZOOM ? { ...props, lz: labelZoom } : props, [[x, y]]);
}

const distanceKm = (x1, y1, x2, y2) => Math.hypot((x2 - x1) * 111.32 * Math.cos((y1 * Math.PI) / 180), (y2 - y1) * 110.57);

// ── Lines from TIGER linear features ─────────────────────────────────────────

/**
 * Joins segments end to end where exactly two of the same group meet, into long lines (so street
 * names fit along them). Returns [{ group, line (degrees) }].
 */
function chainSegments(x1, y1, x2, y2, group, count) {
  const ends = new Uint32Array(2 * count);
  for (let k = 0; k < ends.length; k += 1) ends[k] = k;
  const ex = (k) => (k & 1 ? x2[k >> 1] : x1[k >> 1]);
  const ey = (k) => (k & 1 ? y2[k >> 1] : y1[k >> 1]);
  ends.sort((a, b) => ex(a) - ex(b) || ey(a) - ey(b) || group[a >> 1] - group[b >> 1]);
  const link = new Int32Array(2 * count).fill(-1);
  for (let start = 0; start < ends.length; ) {
    let end = start + 1;
    const first = ends[start];
    while (end < ends.length && ex(ends[end]) === ex(first) && ey(ends[end]) === ey(first) && group[ends[end] >> 1] === group[first >> 1]) end += 1;
    if (end - start === 2) {
      link[ends[start]] = ends[start + 1];
      link[ends[start + 1]] = ends[start];
    }
    start = end;
  }
  const visited = new Uint8Array(count);
  const lines = [];
  const walk = (segment, enter) => {
    const line = [ex(2 * segment + enter) / Q, ey(2 * segment + enter) / Q];
    let current = segment;
    let entered = enter;
    for (;;) {
      visited[current] = 1;
      const exit = entered ^ 1;
      line.push(ex(2 * current + exit) / Q, ey(2 * current + exit) / Q);
      const next = link[2 * current + exit];
      if (next < 0 || visited[next >> 1]) break;
      current = next >> 1;
      entered = next & 1;
    }
    lines.push({ group: group[segment], line });
  };
  for (let s = 0; s < count; s += 1) {
    if (visited[s]) continue;
    if (link[2 * s] < 0) walk(s, 0);
    else if (link[2 * s + 1] < 0) walk(s, 1);
  }
  for (let s = 0; s < count; s += 1) if (!visited[s]) walk(s, 0);
  return lines;
}

/**
 * TIGER's linear features (one per name, so a stretch with two names appears twice) as each
 * stretch once, with attributes merged from every feature on it (`merge(list) → { props, minzoom }`
 * or null to leave it out), joined into long lines. Only stretches touching `box` are kept.
 */
function joinedLines(records, merge, box) {
  const x1 = new Grow(Int32Array);
  const y1 = new Grow(Int32Array);
  const x2 = new Grow(Int32Array);
  const y2 = new Grow(Int32Array);
  const owner = new Grow(Uint32Array);
  records.forEach((record, r) => {
    for (const part of record.parts) {
      for (let i = 0; i + 3 < part.length; i += 2) {
        if (!insideBox(box, part[i], part[i + 1]) && !insideBox(box, part[i + 2], part[i + 3])) continue;
        const ax = Math.round(part[i] * Q);
        const ay = Math.round(part[i + 1] * Q);
        const bx = Math.round(part[i + 2] * Q);
        const by = Math.round(part[i + 3] * Q);
        if (ax === bx && ay === by) continue;
        // Stored low point first, so a stretch drawn in either direction matches itself.
        const swap = bx < ax || (bx === ax && by < ay);
        x1.push(swap ? bx : ax);
        y1.push(swap ? by : ay);
        x2.push(swap ? ax : bx);
        y2.push(swap ? ay : by);
        owner.push(r);
      }
    }
  });
  const count = x1.length;
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) order[i] = i;
  const X1 = x1.array;
  const Y1 = y1.array;
  const X2 = x2.array;
  const Y2 = y2.array;
  order.sort((i, j) => X1[i] - X1[j] || Y1[i] - Y1[j] || X2[i] - X2[j] || Y2[i] - Y2[j]);
  const groups = new Map();
  const groupInfo = [];
  const single = new Map();
  const kx1 = new Grow(Int32Array);
  const ky1 = new Grow(Int32Array);
  const kx2 = new Grow(Int32Array);
  const ky2 = new Grow(Int32Array);
  const kgroup = new Grow(Uint32Array);
  for (let start = 0; start < count; ) {
    let end = start + 1;
    const first = order[start];
    while (end < count && X1[order[end]] === X1[first] && Y1[order[end]] === Y1[first] && X2[order[end]] === X2[first] && Y2[order[end]] === Y2[first]) end += 1;
    const owners = new Set();
    for (let k = start; k < end; k += 1) owners.add(owner.array[order[k]]);
    let merged;
    if (owners.size === 1) {
      const only = owners.values().next().value;
      if (!single.has(only)) single.set(only, merge([records[only].attrs]));
      merged = single.get(only);
    } else {
      merged = merge([...owners].map((r) => records[r].attrs));
    }
    start = end;
    if (!merged) continue;
    const key = JSON.stringify(merged);
    let id = groups.get(key);
    if (id === undefined) {
      id = groupInfo.length;
      groups.set(key, id);
      groupInfo.push(merged);
    }
    kx1.push(X1[first]);
    ky1.push(Y1[first]);
    kx2.push(X2[first]);
    ky2.push(Y2[first]);
    kgroup.push(id);
  }
  return chainSegments(kx1.array, ky1.array, kx2.array, ky2.array, kgroup.array, kx1.length).map(({ group, line }) => ({ ...groupInfo[group], line }));
}

function countyFiles(countyDir, kind) {
  return readdirSync(countyDir).filter((name) => name.endsWith(`_${kind}.zip`)).map((name) => join(countyDir, name));
}

// ── Land and state lines ─────────────────────────────────────────────────────

/**
 * The land: the states' outlines merged, less their water (states reach three miles out to sea;
 * the water's outlines share those edges, so taking it out leaves the shore), plus state lines and
 * names. The sea is the map's background.
 */
export function addLandAndStates(store, tigerDir, water, log) {
  const states = readShapefileZip(join(tigerDir, 'tl_2025_us_state.zip')).filter(({ shape }) => shape && boxesOverlap(boundsOf(shape.parts), OVERVIEW));
  const all = states.map(({ shape }) => shapePolygons(shape.parts));
  const detailed = all.filter((polygons) => polygons.some((polygon) => boxesOverlap(ringBounds(polygon[0]), DETAIL))).flat();
  const land = dissolve(detailed, water.pieces);
  let pieces = 0;
  for (const polygon of clipPolygons(land.polygons, DETAIL)) {
    const minzoom = Math.min(zoomForArea(polygonsArea([polygon]), 2), MAX_ZOOM + 1);
    for (const piece of splitLarge(polygon)) if (addPolygons(store, 'land', minzoom, {}, [piece]) >= 0) pieces += 1;
  }
  log(`  land: ${states.length} states, ${pieces} pieces${land.open ? `, ${land.open} open rings` : ''}`);

  // State lines: the edges two states share (one copy each), joined into lines.
  const owned = [];
  all.forEach((polygons) => owned.push(polygons));
  const flat = [];
  const stateOf = [];
  owned.forEach((polygons, s) => polygons.forEach((polygon) => {
    flat.push(polygon);
    stateOf.push(s);
  }));
  const shared = sharedEdges(flat).filter(({ owners }) => stateOf[owners[0]] !== stateOf[owners[1]]);
  const x1 = new Int32Array(shared.length);
  const y1 = new Int32Array(shared.length);
  const x2 = new Int32Array(shared.length);
  const y2 = new Int32Array(shared.length);
  shared.forEach(({ coords }, i) => {
    x1[i] = Math.round(coords[0] * Q);
    y1[i] = Math.round(coords[1] * Q);
    x2[i] = Math.round(coords[2] * Q);
    y2[i] = Math.round(coords[3] * Q);
  });
  const lines = chainSegments(x1, y1, x2, y2, new Uint32Array(shared.length), shared.length).map(({ line }) => line);
  addLines(store, 'boundary', 0, { level: 4 }, lines, OVERVIEW);
  for (const { props } of states) {
    const x = Number(props.INTPTLON);
    const y = Number(props.INTPTLAT);
    if (insideBox(OVERVIEW, x, y)) addLabel(store, 'place', 3, { kind: 'state', name: props.NAME, rank: 0 }, x, y);
  }
  log(`  state lines: ${lines.length} lines`);
}

// ── Water ─────────────────────────────────────────────────────────────────────

const WATER_LABELS = {
  H2053: { kind: 'ocean', lo: 5, px: 100 * 100 },
  H2051: { kind: 'bay', lo: 8, px: 80 * 80 },
  H2030: { kind: 'lake', lo: 10, px: 60 * 60 },
  H2040: { kind: 'lake', lo: 10, px: 60 * 60 },
  H2041: { kind: 'lake', lo: 12, px: 60 * 60 },
  H3010: { kind: 'river', lo: 11, px: 120 * 120 },
  H3013: { kind: 'river', lo: 11, px: 120 * 120 },
  H3020: { kind: 'river', lo: 12, px: 120 * 120 },
};

/**
 * One label per named place (pieces of the same name within `gapKm` of each other count as one),
 * at the middle of its largest piece, shown once the whole covers the spec's pixel area.
 */
function addClusteredLabels(store, items, gapKm) {
  const byName = new Map();
  for (const item of items) {
    const key = `${item.layer}|${nameKey(item.name)}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(item);
  }
  const gap = gapKm / 100;
  const placed = [];
  for (const group of byName.values()) {
    const parent = group.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i].box;
        const b = group[j].box;
        if (a.west - gap <= b.east && b.west - gap <= a.east && a.south - gap <= b.north && b.south - gap <= a.north) parent[find(i)] = find(j);
      }
    }
    const clusters = new Map();
    group.forEach((item, i) => {
      const root = find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(item);
    });
    for (const cluster of clusters.values()) {
      const area = cluster.reduce((sum, item) => sum + item.area, 0);
      // TIGER names a few pieces of Long Island Sound after ponds along its shore.
      if (/\b(Pond|Creek|Brook|Cove|Pool|Kill)\b/.test(cluster[0].name) && area > 5e6) continue;
      const largest = cluster.reduce((a, b) => (b.area > a.area ? b : a));
      const spec = largest.spec;
      const labelZoom = Math.max(spec.lo, zoomForArea(area, spec.px));
      if (labelZoom > (spec.max ?? 16)) continue;
      const polygon = largest.polygons.reduce((a, b) => (ringAreaMeters(b[0]) > ringAreaMeters(a[0]) ? b : a));
      const [x, y] = labelPoint(polygon);
      if (addLabel(store, largest.layer, labelZoom, { kind: spec.kind, name: largest.name, ...(spec.rank !== undefined ? { rank: spec.rank } : {}) }, x, y) >= 0) {
        placed.push({ layer: largest.layer, key: nameKey(largest.name), x, y });
      }
    }
  }
  return placed;
}

/** Every county's water areas (lakes, rivers, bays, the sea out to the state line), with their names. */
export function readWater(countyDir) {
  const pieces = [];
  const named = [];
  for (const file of countyFiles(countyDir, 'areawater')) {
    for (const { shape, props } of readShapefileZip(file)) {
      if (!shape || shape.type !== 'polygon') continue;
      const polygons = shapePolygons(shape.parts);
      if (polygons.length === 0) continue;
      pieces.push(...polygons);
      const spec = WATER_LABELS[props.MTFCC];
      const name = props.FULLNAME && !/\b(Pk|Park)\b/.test(props.FULLNAME) ? spellOut(props.FULLNAME) : '';
      if (spec && name) named.push({ layer: 'water_name', name, spec, polygons, box: boundsOf(polygons.map((p) => p[0])), area: polygonsArea(polygons) });
    }
  }
  return { pieces, named };
}

/**
 * The water as one surface, drawn over parks and the like (whose outlines often run out over a
 * bay), with names as labels.
 */
export function addWater(store, { pieces, named }, log) {
  const merged = dissolve(pieces);
  let surfaces = 0;
  for (const polygon of clipPolygons(merged.polygons, DETAIL)) {
    const minzoom = zoomForArea(polygonsArea([polygon]), 2);
    for (const piece of splitLarge(polygon)) if (addPolygons(store, 'water', minzoom, {}, [piece]) >= 0) surfaces += 1;
  }
  const labels = addClusteredLabels(store, named.filter((item) => insideBox(DETAIL, ...labelPoint(item.polygons[0]))), 3);
  log(`  water: ${pieces.length} pieces merged into ${surfaces} surfaces${merged.open ? ` (${merged.open} open rings)` : ''}, ${labels.length} names`);
  return labels;
}

/** Rivers, streams, and canals as lines (big rivers are also water surfaces). */
export function addWaterways(store, countyDir, log) {
  let count = 0;
  for (const file of countyFiles(countyDir, 'linearwater')) {
    const records = readShapefileZip(file)
      .filter(({ shape }) => shape && shape.type === 'line')
      .map(({ shape, props }) => ({ parts: shape.parts, attrs: { mtfcc: props.MTFCC, name: props.FULLNAME } }));
    const lines = joinedLines(records, (list) => {
      const usable = list.filter((a) => a.mtfcc === 'H3010' || a.mtfcc === 'H3013' || a.mtfcc === 'H3020');
      if (usable.length === 0) return null;
      const namedOne = usable.find((a) => a.name) ?? usable[0];
      const name = namedOne.name ? spellOut(namedOne.name) : undefined;
      const kind = /\bRiver\b/.test(name ?? '') ? 'river' : namedOne.mtfcc === 'H3020' || /\bCanal\b/.test(name ?? '') ? 'canal' : 'stream';
      return { props: { kind, ...(name ? { name } : {}) }, minzoom: kind === 'river' ? 10 : kind === 'canal' ? 11 : 13 };
    }, DETAIL);
    for (const { props, minzoom, line } of lines) if (addLines(store, 'waterway', minzoom, props, [line], DETAIL) >= 0) count += 1;
  }
  log(`  waterways: ${count} lines`);
}

// ── Roads and rail ────────────────────────────────────────────────────────────

const ROAD_RANK = { S1100: 9, S1200: 8, S1630: 7, S1400: 6, S1640: 5, S1730: 4, S1740: 3, S1780: 2, S1500: 1, S1710: 0, S1720: 0, S1820: 0, S1830: 0 };
const ROUTE_ORDER = { I: 0, U: 1, S: 2, C: 3 };

/** A route's number as signs show it: I-495, US 9, Rte 25, CR 10. */
function routeRef(name) {
  const patterns = [[/^I-\s*(\w+)/, 'I-'], [/^US Hwy\s+(\w+)/, 'US '], [/^State (?:Rte|Hwy|Route|Rd)\s+(\w+)/, 'Rte '], [/^Co(?:unty)? (?:Rd|Rte|Hwy)\s+(\w+)/, 'CR ']];
  for (const [pattern, prefix] of patterns) {
    const match = name.match(pattern);
    if (match) return prefix + match[1];
  }
  return undefined;
}

const cleanRoadName = (name) => spellOut(name.replace(/\s*\([^)]*\)/g, '').trim(), { roads: true });

function roadProps(list) {
  const usable = list.filter((a) => ROAD_RANK[a.mtfcc] !== undefined);
  if (usable.length === 0) return null;
  const best = usable.reduce((a, b) => (ROAD_RANK[b.mtfcc] > ROAD_RANK[a.mtfcc] ? b : a));
  const routes = usable.filter((a) => a.name && ROUTE_ORDER[a.rttyp] !== undefined).sort((a, b) => ROUTE_ORDER[a.rttyp] - ROUTE_ORDER[b.rttyp]);
  const common = usable.find((a) => a.name && a.rttyp === 'M') ?? usable.find((a) => a.name && ROUTE_ORDER[a.rttyp] === undefined);
  const rawName = common?.name ?? routes[0]?.name;
  const name = rawName ? cleanRoadName(rawName) : undefined;
  const ref = routes.map((a) => routeRef(a.name)).find(Boolean);
  let kind;
  let minzoom;
  let link = false;
  switch (best.mtfcc) {
    case 'S1100': kind = 'motorway'; minzoom = 4; break;
    case 'S1630': kind = 'motorway'; minzoom = 10; link = true; break;
    case 'S1200':
      if (routes.some((a) => a.rttyp === 'I' || a.rttyp === 'U' || a.rttyp === 'S')) { kind = 'primary'; minzoom = 7; } else { kind = 'secondary'; minzoom = 9; }
      break;
    case 'S1400':
    case 'S1640':
      if (/\b(Ave|Blvd|Pkwy|Hwy|Tpke|Expy|Broadway|Concourse)\b/.test(name ?? '')) { kind = 'tertiary'; minzoom = 10; } else { kind = 'minor'; minzoom = 12; }
      break;
    case 'S1730':
    case 'S1740': kind = 'service'; minzoom = 13; break;
    case 'S1780': kind = 'service'; minzoom = 14; break;
    default: kind = 'path'; minzoom = best.mtfcc === 'S1500' ? 13 : 14;
  }
  const props = { kind };
  if (link) props.link = 1;
  if (kind !== 'path' && usable.some((a) => /\b(Brg|Bridge|Viaduct)\b/.test(a.name))) props.brunnel = 'bridge';
  else if (kind !== 'path' && usable.some((a) => /\b(Tunl|Tunnel)\b/.test(a.name) && !/Entrance|Exit|Approach|Plaza/.test(a.name))) props.brunnel = 'tunnel';
  if (name && !link) props.name = name;
  if (ref && (kind === 'motorway' || kind === 'primary' || kind === 'secondary')) props.ref = ref;
  return { props, minzoom };
}

export function addRoads(store, countyDir, log) {
  let count = 0;
  for (const file of countyFiles(countyDir, 'roads')) {
    const records = readShapefileZip(file)
      .filter(({ shape }) => shape && shape.type === 'line')
      .map(({ shape, props }) => ({ parts: shape.parts, attrs: { mtfcc: props.MTFCC, rttyp: props.RTTYP, name: props.FULLNAME } }));
    for (const { props, minzoom, line } of joinedLines(records, roadProps, DETAIL)) if (addLines(store, 'road', minzoom, props, [line], DETAIL) >= 0) count += 1;
  }
  log(`  roads: ${count} lines`);
}

export function addRail(store, tigerDir, log) {
  const records = readShapefileZip(join(tigerDir, 'tl_2025_us_rails.zip'))
    .filter(({ shape }) => shape && boxesOverlap(boundsOf(shape.parts), DETAIL))
    .map(({ shape }) => ({ parts: shape.parts, attrs: {} }));
  let count = 0;
  for (const { props, minzoom, line } of joinedLines(records, () => ({ props: { kind: 'rail' }, minzoom: 10 }), DETAIL)) if (addLines(store, 'rail', minzoom, props, [line], DETAIL) >= 0) count += 1;
  log(`  rail: ${count} lines`);
}

// ── Parks and landmarks ──────────────────────────────────────────────────────

const PARK = { lo: 7, px: 4 };
const LANDMARKS = {
  K2180: ['park', 'park', PARK], K2183: ['park', 'park', PARK], K2184: ['park', 'park', PARK], K2185: ['park', 'park', PARK],
  K2186: ['park', 'park', PARK], K2187: ['park', 'park', PARK], K2188: ['park', 'park', PARK], K2189: ['park', 'park', PARK], K2190: ['park', 'park', PARK],
  K2181: ['park', 'national_park', { lo: 6, px: 4 }], K2182: ['park', 'national_park', { lo: 6, px: 4 }],
  K2561: ['park', 'golf_course', { lo: 10, px: 4 }],
  K2582: ['landuse', 'cemetery', { lo: 11, px: 4 }],
  K2540: ['landuse', 'university', { lo: 11, px: 4 }],
  K2543: ['landuse', 'school', { lo: 12, px: 4 }],
  K1231: ['landuse', 'hospital', { lo: 11, px: 4 }],
  K2457: ['landuse', 'airport', { lo: 8, px: 1 }],
  K2110: ['landuse', 'military', { lo: 10, px: 4 }],
  K2564: ['landuse', 'theme_park', { lo: 11, px: 4 }],
  K2586: ['landuse', 'zoo', { lo: 11, px: 4 }],
  K2361: ['landuse', 'commercial', { lo: 11, px: 16 }],
  K2363: ['landuse', 'commercial', { lo: 11, px: 16 }],
  K2362: ['landuse', 'industrial', { lo: 11, px: 16 }],
};

/** Parks, cemeteries, campuses, airports, and the like, with park, airport, and island names. */
export function addLandmarks(store, tigerDir, log) {
  const labels = [];
  let count = 0;
  for (const state of STATES) {
    for (const { shape, props } of readShapefileZip(join(tigerDir, `tl_2025_${state}_arealm.zip`))) {
      if (!shape || shape.type !== 'polygon') continue;
      const polygons = clipPolygons(shapePolygons(shape.parts), DETAIL);
      if (polygons.length === 0) continue;
      const area = polygonsArea(polygons);
      const box = boundsOf(polygons.map((p) => p[0]));
      const name = props.FULLNAME && props.FULLNAME !== 'Private Park' ? spellOut(props.FULLNAME) : '';
      if (props.MTFCC === 'C3023') {
        if (name) labels.push({ layer: 'place', name, spec: { kind: 'island', lo: 10, px: 80 * 80, rank: 60 }, polygons, box, area });
        continue;
      }
      const landmark = LANDMARKS[props.MTFCC];
      if (!landmark) continue;
      const [layer, kind, { lo, px }] = landmark;
      if (addPolygons(store, layer, Math.max(lo, zoomForArea(area, px)), { kind }, polygons) >= 0) count += 1;
      if (!name) continue;
      if (layer === 'park') labels.push({ layer: 'park', name, spec: { kind: 'park', lo: 10, px: 90 * 90 }, polygons, box, area });
      if (kind === 'airport') labels.push({ layer: 'landuse', name, spec: { kind: 'airport', lo: 9, px: 40 * 40, max: 14 }, polygons, box, area });
    }
  }
  const placed = addClusteredLabels(store, labels, 1);
  log(`  landmarks: ${count} areas, ${placed.length} names`);
  return placed;
}

// ── Places and names ─────────────────────────────────────────────────────────

function parseCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
}

/** Census population estimates (2024) by place (state + place code) and county subdivision (state + county + code). */
function populations(tigerDir) {
  const lines = readFileSync(join(tigerDir, 'sub-est2024.csv'), 'latin1').split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const at = (name) => header.indexOf(name);
  const [sumlev, state, county, place, cousub, pop] = ['SUMLEV', 'STATE', 'COUNTY', 'PLACE', 'COUSUB', 'POPESTIMATE2024'].map(at);
  const out = new Map();
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const row = parseCsvLine(line);
    if (row[sumlev] === '162') out.set(`P${row[state]}${row[place]}`, Number(row[pop]));
    else if (row[sumlev] === '061') out.set(`C${row[state]}${row[county]}${row[cousub]}`, Number(row[pop]));
  }
  return out;
}

/** GNIS names: { name, cls, x, y } for every feature with a position. */
function gnisNames(gnisDir) {
  const out = [];
  for (const state of GNIS_STATES) {
    const files = readZip(join(gnisDir, `DomesticNames_${state}_Text.zip`));
    const name = [...files.keys()].find((n) => n.endsWith('.txt'));
    const lines = files.get(name)().toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
    const header = lines[0].split('|');
    const [nameAt, classAt, latAt, lonAt] = ['feature_name', 'feature_class', 'prim_lat_dec', 'prim_long_dec'].map((n) => header.indexOf(n));
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const row = line.split('|');
      const x = Number(row[lonAt]);
      const y = Number(row[latAt]);
      if (!x || !y) continue;
      out.push({ name: row[nameAt], cls: row[classAt], x, y });
    }
  }
  return out;
}

function placeSize(kind, population) {
  // [kind shown, zoom], by how many people live there.
  if (population >= 1e6) return ['city', 4];
  if (kind === 'city' && population >= 1e5) return ['city', 7];
  if (population >= 5e4) return ['town', 9];
  if (population >= 1.5e4) return ['town', 10];
  if (population >= 4e3) return ['village', 11];
  return ['hamlet', 12];
}

/**
 * Cities, towns, villages, and hamlets (Census places and, where towns are county subdivisions,
 * those), New York City's boroughs, and neighborhoods (GNIS populated places), each at its GNIS
 * position when there is one (a town's center rather than the middle of its outline).
 */
export function addPlaces(store, tigerDir, gnisDir, log) {
  const pops = populations(tigerDir);
  const gnis = gnisNames(gnisDir);
  const populated = gnis.filter((g) => g.cls === 'Populated Place' && insideBox(DETAIL, g.x, g.y) && !/\(historical\)/.test(g.name));
  const byName = new Map();
  for (const g of populated) {
    const key = nameKey(g.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(g);
  }
  const placed = [];
  const usedGnis = new Set();
  const add = (name, kind, minzoom, rank, x, y) => {
    if (placed.some((p) => p.key === nameKey(name) && distanceKm(p.x, p.y, x, y) < 5)) return;
    addLabel(store, 'place', minzoom, { kind, name, rank }, x, y);
    placed.push({ key: nameKey(name), x, y });
  };
  // A named place's GNIS point inside its outline, nearest its middle.
  const centerOf = (name, polygons, x, y) => {
    const candidates = (byName.get(nameKey(name)) ?? []).filter((g) => polygons.some((polygon) => pointInRing(polygon[0], g.x, g.y)));
    if (candidates.length === 0) return [x, y];
    const best = candidates.reduce((a, b) => (distanceKm(a.x, a.y, x, y) <= distanceKm(b.x, b.y, x, y) ? a : b));
    usedGnis.add(best);
    return [best.x, best.y];
  };
  const rankOf = (base, population) => Math.round((base - Math.min(9, Math.log10(population + 1))) * 10) / 10;
  const BASE = { city: 10, town: 20, village: 25, hamlet: 30 };

  // Boroughs first (New York City's five), then places by size, then townships.
  for (const { shape, props } of readShapefileZip(join(tigerDir, 'tl_2025_36_cousub.zip'))) {
    if (!shape || props.LSAD !== '21' || !['005', '047', '061', '081', '085'].includes(props.COUNTYFP)) continue;
    const name = props.NAME === 'Bronx' ? 'The Bronx' : props.NAME;
    add(name, 'borough', 10, 12, Number(props.INTPTLON), Number(props.INTPTLAT));
  }
  const towns = [];
  for (const state of STATES) {
    for (const { shape, props } of readShapefileZip(join(tigerDir, `tl_2025_${state}_place.zip`))) {
      const x = Number(props.INTPTLON);
      const y = Number(props.INTPTLAT);
      if (!shape || !insideBox(DETAIL, x, y)) continue;
      const known = pops.get(`P${props.STATEFP}${props.PLACEFP}`);
      // Census-designated places (hamlets) have no estimate: sized by land area instead.
      const population = known ?? (Number(props.ALAND) / 1e6) * 1200;
      towns.push({ name: props.NAME, kind: props.LSAD === '25' ? 'city' : 'town', population, polygons: shapePolygons(shape.parts), x, y });
    }
  }
  for (const state of ['34', '09', '25', '44', '42']) {
    for (const { shape, props } of readShapefileZip(join(tigerDir, `tl_2025_${state}_cousub.zip`))) {
      const x = Number(props.INTPTLON);
      const y = Number(props.INTPTLAT);
      if (!shape || !insideBox(DETAIL, x, y) || props.FUNCSTAT !== 'A' || /not defined|Unorganized/i.test(props.NAMELSAD)) continue;
      const population = pops.get(`C${props.STATEFP}${props.COUNTYFP}${props.COUSUBFP}`) ?? 0;
      towns.push({ name: props.NAME, kind: props.LSAD === '25' ? 'city' : 'town', population, polygons: shapePolygons(shape.parts), x, y });
    }
  }
  towns.sort((a, b) => b.population - a.population);
  for (const town of towns) {
    const [kind, minzoom] = placeSize(town.kind, town.population);
    const [x, y] = centerOf(town.name, town.polygons, town.x, town.y);
    add(town.name, kind, minzoom, rankOf(BASE[kind], town.population), x, y);
  }
  // Neighborhoods: populated places that aren't one of the places above.
  let neighborhoods = 0;
  for (const g of populated) {
    if (usedGnis.has(g)) continue;
    const before = placed.length;
    add(g.name, 'neighbourhood', 13, 40, g.x, g.y);
    if (placed.length > before) neighborhoods += 1;
  }
  log(`  places: ${placed.length - neighborhoods} towns and boroughs, ${neighborhoods} neighborhoods`);
  return gnis;
}

/** Bays, channels, and islands GNIS names that the water and island outlines didn't already name. */
export function addGnisWaterNames(store, gnis, already, log) {
  // Named points inside bigger water (coves, channels): shown only up close, as the familiar maps do.
  const kinds = { Bay: ['water_name', 'bay', 13], Channel: ['water_name', 'channel', 14], Gut: ['water_name', 'channel', 14], Sea: ['water_name', 'ocean', 6], Island: ['place', 'island', 13] };
  let count = 0;
  for (const g of gnis) {
    const spec = kinds[g.cls];
    if (!spec || !insideBox(DETAIL, g.x, g.y) || /\(historical\)/.test(g.name)) continue;
    const [layer, kind, minzoom] = spec;
    const key = nameKey(g.name);
    if (already.some((p) => p.key === key && distanceKm(p.x, p.y, g.x, g.y) < 20)) continue;
    addLabel(store, layer, minzoom, { kind, name: g.name, ...(layer === 'place' ? { rank: 60 } : {}) }, g.x, g.y);
    already.push({ layer, key, x: g.x, y: g.y });
    count += 1;
  }
  log(`  GNIS water and island names: ${count}`);
}

// ── Buildings ─────────────────────────────────────────────────────────────────

/** "MULTIPOLYGON (((x y, ...), (...)), ((...)))" as polygons [outer, ...holes]. */
function parseMultiPolygon(wkt) {
  const body = wkt.slice(wkt.indexOf('(((') + 3, wkt.lastIndexOf(')))'));
  return body.split(/\)\)\s*,\s*\(\(/).map((polygon) => polygon.split(/\)\s*,\s*\(/).map((ring, i) => {
    const flat = [];
    for (const pair of ring.split(',')) {
      const space = pair.trim().indexOf(' ');
      const trimmed = pair.trim();
      flat.push(Number(trimmed.slice(0, space)), Number(trimmed.slice(space + 1)));
    }
    return orient(dropClosing(flat), i === 0);
  }).filter((ring) => ring.length >= 6)).filter((rings) => rings.length > 0);
}

/** New York City's building footprints (NYC Open Data). */
export async function addBuildings(store, csvPath, log) {
  if (!existsSync(csvPath)) {
    log('  buildings: no NYC footprint file; skipped');
    return;
  }
  const lines = createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
  let header = null;
  let geomAt = 0;
  let codeAt = -1;
  let count = 0;
  for await (const line of lines) {
    if (!header) {
      header = parseCsvLine(line);
      geomAt = header.indexOf('the_geom');
      codeAt = header.indexOf('Feature Code');
      continue;
    }
    const row = parseCsvLine(line);
    const code = row[codeAt];
    // Buildings, garages, and buildings under construction (not canopies, tanks, or skybridges).
    if (code && !['2100', '5100', '5110', '1006'].includes(code)) continue;
    const wkt = row[geomAt];
    if (!wkt || !wkt.startsWith('MULTIPOLYGON')) continue;
    const polygons = parseMultiPolygon(wkt);
    if (addPolygons(store, 'building', 14, {}, polygons) >= 0) count += 1;
  }
  log(`  buildings: ${count}`);
}

// ── Pathly's transit data ────────────────────────────────────────────────────

/** The transit agencies whose feeds the map takes station names and ferry routes from (the feeds Pathly routes on). */
export const TRANSIT_FEEDS = {
  subway: { url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip', kind: 'subway' },
  lirr: { url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip', kind: 'rail' },
  metronorth: { url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip', kind: 'rail' },
  nycferry: { url: 'https://nycferry.connexionz.net/rtt/public/resource/gtfs.zip', kind: 'ferry' },
  siferry: { url: 'https://www.nyc.gov/html/dot/downloads/misc/siferry-gtfs.zip', kind: 'ferry' },
};

/** A GTFS file's rows as objects. */
function gtfsRows(files, name) {
  const file = [...files.keys()].find((key) => key.split('/').pop() === name);
  if (!file) return [];
  const lines = files.get(file)().toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]).map((field) => field.trim());
  return lines.slice(1).map((line) => {
    const row = parseCsvLine(line);
    return Object.fromEntries(header.map((key, i) => [key, row[i]?.trim() ?? '']));
  });
}

/** Station names (subway, LIRR, Metro-North, ferry landings) and ferry routes, from the agencies' GTFS feeds. */
export function addTransit(store, gtfsDir, log) {
  let stations = 0;
  let ferries = 0;
  const seenPaths = new Set();
  for (const [agency, { kind }] of Object.entries(TRANSIT_FEEDS)) {
    const path = join(gtfsDir, `${agency}.zip`);
    if (!existsSync(path)) {
      log(`  ${agency}: no feed in ${gtfsDir}; skipped`);
      continue;
    }
    const files = readZip(path);
    const stops = gtfsRows(files, 'stops.txt');
    // Stations: a feed's parent stations when it has them, otherwise every stop without a parent.
    const hasStations = stops.some((stop) => stop.location_type === '1');
    const placed = [];
    for (const stop of stops) {
      if (hasStations ? stop.location_type !== '1' : stop.parent_station || (stop.location_type && stop.location_type !== '0')) continue;
      const x = Number(stop.stop_lon);
      const y = Number(stop.stop_lat);
      const name = stop.stop_name;
      if (!name || !insideBox(DETAIL, x, y) || placed.some((p) => p.name === name && distanceKm(p.x, p.y, x, y) < 0.15)) continue;
      placed.push({ name, x, y });
      store.add('poi', POINT, kind === 'ferry' ? 13 : 12, { kind, name }, [[x, y]]);
      stations += 1;
    }
    if (kind !== 'ferry') continue;
    const shapes = new Map();
    for (const point of gtfsRows(files, 'shapes.txt')) {
      if (!shapes.has(point.shape_id)) shapes.set(point.shape_id, []);
      shapes.get(point.shape_id).push([Number(point.shape_pt_sequence), Number(point.shape_pt_lon), Number(point.shape_pt_lat)]);
    }
    for (const points of shapes.values()) {
      points.sort((a, b) => a[0] - b[0]);
      const line = points.flatMap(([, x, y]) => [x, y]);
      if (line.length < 4) continue;
      // A route's two directions usually trace the same water: drawn once.
      const ends = [line.slice(0, 2), line.slice(-2)].map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).sort().join('|');
      if (seenPaths.has(ends)) continue;
      seenPaths.add(ends);
      if (addLines(store, 'ferry', 10, {}, [line], DETAIL) >= 0) ferries += 1;
    }
  }
  log(`  transit: ${stations} stations, ${ferries} ferry routes`);
}

// ── Around the detailed area (Natural Earth) ─────────────────────────────────

/**
 * Coastlines, lakes, highways, and cities around the detailed area, for zoomed-out maps. Land and
 * lakes reach 0.01° into the detailed area under its own (same color), so no seam shows at its edge.
 */
export function addOverview(store, neDir, log) {
  const read = (name) => JSON.parse(readFileSync(join(neDir, `${name}.geojson`), 'utf8')).features;
  const overlap = 0.01;
  const areaStrips = [
    { ...OVERVIEW_STRIPS[0], east: DETAIL.west + overlap },
    { ...OVERVIEW_STRIPS[1], west: DETAIL.east - overlap },
    { ...OVERVIEW_STRIPS[2], south: DETAIL.north - overlap },
    { ...OVERVIEW_STRIPS[3], north: DETAIL.south + overlap },
  ];
  let counts = { land: 0, lakes: 0, roads: 0, places: 0 };
  for (const feature of read('ne_10m_land')) {
    for (const polygon of geojsonPolygons(feature.geometry)) {
      if (!boxesOverlap(ringBounds(polygon[0]), OVERVIEW)) continue;
      for (const strip of areaStrips) {
        for (const clipped of clipPolygons([polygon], strip)) for (const piece of splitLarge(clipped)) if (addPolygons(store, 'land', 0, {}, [piece]) >= 0) counts.land += 1;
      }
    }
  }
  for (const feature of read('ne_10m_lakes')) {
    for (const polygon of geojsonPolygons(feature.geometry)) {
      if (!boxesOverlap(ringBounds(polygon[0]), OVERVIEW)) continue;
      const minzoom = Math.max(4, zoomForArea(polygonsArea([polygon]), 2));
      for (const strip of areaStrips) if (addPolygons(store, 'water', minzoom, {}, clipPolygons([polygon], strip)) >= 0) counts.lakes += 1;
    }
  }
  for (const feature of read('ne_10m_roads')) {
    const p = feature.properties;
    const kind = p.expressway === 1 ? 'motorway' : p.type === 'Major Highway' ? 'primary' : p.type === 'Secondary Highway' ? 'secondary' : null;
    if (!kind || !feature.geometry) continue;
    const lines = geojsonLines(feature.geometry).filter((line) => boxesOverlap(ringBounds(line), OVERVIEW));
    if (lines.length === 0) continue;
    const minzoom = kind === 'motorway' ? 4 : kind === 'primary' ? 6 : 8;
    for (const strip of OVERVIEW_STRIPS) if (addLines(store, 'road', minzoom, { kind }, lines, strip) >= 0) counts.roads += 1;
  }
  for (const feature of read('ne_10m_populated_places_simple')) {
    const p = feature.properties;
    const [x, y] = feature.geometry.coordinates;
    if (!OVERVIEW_STRIPS.some((strip) => insideBox(strip, x, y))) continue;
    const population = p.pop_max ?? 0;
    const kind = population >= 1e5 ? 'city' : 'town';
    const minzoom = population >= 1e6 ? 4 : population >= 2.5e5 ? 6 : population >= 5e4 ? 8 : 9;
    addLabel(store, 'place', minzoom, { kind, name: p.name, rank: Math.round((10 - Math.min(9, Math.log10(population + 1))) * 10) / 10 }, x, y);
    counts.places += 1;
  }
  log(`  overview: ${counts.land} land pieces, ${counts.lakes} lakes, ${counts.roads} highways, ${counts.places} cities`);
}
