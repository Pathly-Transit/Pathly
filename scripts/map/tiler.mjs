// Cuts the feature store into vector tiles. Features are projected to Web Mercator once, given a
// simplification rank per point (Douglas–Peucker: how far the point sits from the line its
// neighbors would make without it), then clipped down the tile pyramid quadrant by quadrant, so
// each level only clips what its parent kept. At each tile, points too close to matter at that zoom
// are dropped and the rest are rounded to the tile's 4096-unit grid.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHUNK_ZOOM, MAX_ZOOM, hasTile, tileRangesAt } from './bounds.mjs';
import { GEOM_LINE, GEOM_POINT, GEOM_POLYGON, encodeTile, geometryCommands } from './mvt.mjs';
import { LAYERS } from './schema.mjs';
import { LINE, POINT, POLYGON, SCALE } from './store.mjs';

export const EXTENT = 4096;
/** How far past its edges a tile carries geometry, so lines and outlines join seamlessly. */
const BUFFER = 64;
/** Simplification tolerance, in tile units (1/8 of a pixel per unit on a 512-pixel tile). */
const TOLERANCE = 3;
/** World size in projected units: one unit per tile unit at the last zoom. */
const WORLD = EXTENT * 2 ** MAX_ZOOM;

const mercatorX = (lon) => ((lon + 180) / 360) * WORLD;
function mercatorY(lat) {
  const sin = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * WORLD;
}

function boxOf(parts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 3) {
      if (part[i] < minX) minX = part[i];
      if (part[i] > maxX) maxX = part[i];
      if (part[i + 1] < minY) minY = part[i + 1];
      if (part[i + 1] > maxY) maxY = part[i + 1];
    }
  }
  return { minX, minY, maxX, maxY };
}

/** A store feature in projected form: parts as [x, y, rank] triples. */
function project(store, id) {
  const first = store.firstPart.array[id];
  const count = store.partCount.array[id];
  const coords = store.coords.array;
  const parts = [];
  const outer = [];
  for (let p = first; p < first + count; p += 1) {
    const start = store.partStart.array[p];
    const stop = p + 1 < store.partStart.length ? store.partStart.array[p + 1] : store.coords.length / 2;
    const part = new Float64Array((stop - start) * 3);
    for (let i = start, j = 0; i < stop; i += 1, j += 3) {
      part[j] = mercatorX(coords[2 * i] / SCALE);
      part[j + 1] = mercatorY(coords[2 * i + 1] / SCALE);
    }
    parts.push(part);
    outer.push(store.partOuter.array[p] === 1);
  }
  return { id, type: store.type.array[id], parts, outer, box: boxOf(parts) };
}

function squareSegmentDistance(px, py, ax, ay, bx, by) {
  let dx = bx - ax;
  let dy = by - ay;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      ax = bx;
      ay = by;
    } else if (t > 0) {
      ax += dx * t;
      ay += dy * t;
    }
  }
  dx = px - ax;
  dy = py - ay;
  return dx * dx + dy * dy;
}

/** Douglas–Peucker ranks: each point's squared distance from the simplified line around it. */
function rank(feature) {
  for (const part of feature.parts) {
    const n = part.length / 3;
    if (feature.type === POINT) {
      part[2] = Infinity;
      continue;
    }
    part[2] = Infinity;
    part[3 * (n - 1) + 2] = Infinity;
    const stack = [0, n - 1];
    while (stack.length) {
      const last = stack.pop();
      const first = stack.pop();
      let max = 0;
      let index = -1;
      const ax = part[3 * first];
      const ay = part[3 * first + 1];
      const bx = part[3 * last];
      const by = part[3 * last + 1];
      for (let i = first + 1; i < last; i += 1) {
        const d = squareSegmentDistance(part[3 * i], part[3 * i + 1], ax, ay, bx, by);
        if (d > max) {
          max = d;
          index = i;
        }
      }
      if (index >= 0) {
        part[3 * index + 2] = max;
        stack.push(first, index, index, last);
      }
    }
  }
  return feature;
}

/** Clips a ring of triples to a box (Sutherland–Hodgman); cut points always survive simplification. */
function clipRing(part, box) {
  let points = part;
  for (const [axis, value, keepAbove] of [[0, box.minX, true], [0, box.maxX, false], [1, box.minY, true], [1, box.maxY, false]]) {
    const n = points.length / 3;
    if (n === 0) break;
    const out = [];
    const inside = (i) => (keepAbove ? points[3 * i + axis] >= value : points[3 * i + axis] <= value);
    let previous = n - 1;
    let previousInside = inside(previous);
    for (let i = 0; i < n; i += 1) {
      const currentInside = inside(i);
      if (currentInside !== previousInside) {
        const ax = points[3 * previous];
        const ay = points[3 * previous + 1];
        const bx = points[3 * i];
        const by = points[3 * i + 1];
        const t = axis === 0 ? (value - ax) / (bx - ax) : (value - ay) / (by - ay);
        if (axis === 0) out.push(value, ay + (by - ay) * t, Infinity);
        else out.push(ax + (bx - ax) * t, value, Infinity);
      }
      if (currentInside) out.push(points[3 * i], points[3 * i + 1], points[3 * i + 2]);
      previous = i;
      previousInside = currentInside;
    }
    points = out;
  }
  return points.length >= 9 ? Float64Array.from(points) : null;
}

/** Clips a line of triples to a box; the pieces inside. */
function clipLine(part, box) {
  const pieces = [];
  let current = null;
  const finish = () => {
    if (current && current.length >= 6) {
      current[2] = Infinity;
      current[current.length - 1] = Infinity;
      pieces.push(Float64Array.from(current));
    }
    current = null;
  };
  for (let i = 0; i + 5 < part.length; i += 3) {
    const ax = part[i];
    const ay = part[i + 1];
    const dx = part[i + 3] - ax;
    const dy = part[i + 4] - ay;
    let t0 = 0;
    let t1 = 1;
    let visible = true;
    for (const [p, q] of [[-dx, ax - box.minX], [dx, box.maxX - ax], [-dy, ay - box.minY], [dy, box.maxY - ay]]) {
      if (p === 0) {
        if (q < 0) { visible = false; break; }
      } else {
        const r = q / p;
        if (p < 0) { if (r > t1) { visible = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { visible = false; break; } if (r < t1) t1 = r; }
      }
    }
    if (!visible) {
      finish();
      continue;
    }
    if (!current || t0 > 0) {
      finish();
      current = t0 > 0 ? [ax + dx * t0, ay + dy * t0, Infinity] : [ax, ay, part[i + 2]];
    }
    if (t1 < 1) {
      current.push(ax + dx * t1, ay + dy * t1, Infinity);
      finish();
    } else {
      current.push(part[i + 3], part[i + 4], part[i + 5]);
    }
  }
  finish();
  return pieces;
}

function clipFeature(feature, box) {
  const b = feature.box;
  if (b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY) return null;
  if (b.minX >= box.minX && b.maxX <= box.maxX && b.minY >= box.minY && b.maxY <= box.maxY) return feature;
  const parts = [];
  const outer = [];
  if (feature.type === POINT) {
    for (const part of feature.parts) {
      if (part[0] >= box.minX && part[0] <= box.maxX && part[1] >= box.minY && part[1] <= box.maxY) {
        parts.push(part);
        outer.push(true);
      }
    }
  } else if (feature.type === LINE) {
    for (const part of feature.parts) {
      for (const piece of clipLine(part, box)) {
        parts.push(piece);
        outer.push(true);
      }
    }
  } else {
    let keepHoles = false;
    feature.parts.forEach((part, i) => {
      if (feature.outer[i]) {
        const ring = clipRing(part, box);
        keepHoles = ring !== null;
        if (ring) {
          parts.push(ring);
          outer.push(true);
        }
      } else if (keepHoles) {
        const ring = clipRing(part, box);
        if (ring) {
          parts.push(ring);
          outer.push(false);
        }
      }
    });
  }
  if (parts.length === 0) return null;
  return { id: feature.id, type: feature.type, parts, outer, box: boxOf(parts) };
}

/** A tile's box in projected units, with its buffer. */
function tileBox(z, x, y) {
  const size = EXTENT * 2 ** (MAX_ZOOM - z);
  const buffer = (BUFFER / EXTENT) * size;
  return { minX: x * size - buffer, minY: y * size - buffer, maxX: (x + 1) * size + buffer, maxY: (y + 1) * size + buffer };
}

/** A part's points kept at this tile's zoom, rounded to the tile grid (repeats dropped). */
function quantize(part, minRank, ox, oy, k, ring) {
  const out = [];
  const n = part.length / 3;
  let px = Number.NaN;
  let py = Number.NaN;
  for (let i = 0; i < n; i += 1) {
    if (part[3 * i + 2] <= minRank && i !== 0 && i !== n - 1) continue;
    const x = Math.round((part[3 * i] - ox) * k);
    const y = Math.round((part[3 * i + 1] - oy) * k);
    if (x === px && y === py) continue;
    out.push(x, y);
    px = x;
    py = y;
  }
  if (ring && out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out;
}

function area2(ring) {
  let sum = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) sum += ring[2 * j] * ring[2 * i + 1] - ring[2 * i] * ring[2 * j + 1];
  return sum;
}

/** Wound as the tile spec asks: outer rings positive in tile coordinates, holes negative. */
function wind(ring, outer) {
  if (area2(ring) > 0 === outer) return ring;
  const out = new Array(ring.length);
  const n = ring.length / 2;
  for (let i = 0; i < n; i += 1) {
    out[2 * i] = ring[2 * (n - 1 - i)];
    out[2 * i + 1] = ring[2 * (n - 1 - i) + 1];
  }
  return out;
}

function encodeAt(store, features, z, x, y) {
  const size = EXTENT * 2 ** (MAX_ZOOM - z);
  const k = EXTENT / size;
  const ox = x * size;
  const oy = y * size;
  // Ranks are squared projected distances; at the last zoom every point stays.
  const minRank = z === MAX_ZOOM ? -1 : (TOLERANCE / k) ** 2;
  const minArea = z === MAX_ZOOM ? 0 : 2 * TOLERANCE * TOLERANCE;
  const layers = LAYERS.map((name) => ({ name, features: [] }));
  for (const feature of features) {
    if (store.minzoom.array[feature.id] > z || store.maxzoom.array[feature.id] < z) continue;
    let type;
    let geometry = null;
    if (feature.type === POINT) {
      const points = [];
      for (const part of feature.parts) {
        const px = Math.round((part[0] - ox) * k);
        const py = Math.round((part[1] - oy) * k);
        if (px >= -BUFFER && px <= EXTENT + BUFFER && py >= -BUFFER && py <= EXTENT + BUFFER) points.push(px, py);
      }
      if (points.length) {
        type = GEOM_POINT;
        geometry = geometryCommands(GEOM_POINT, points);
      }
    } else if (feature.type === LINE) {
      const lines = [];
      for (const part of feature.parts) {
        const line = quantize(part, minRank, ox, oy, k, false);
        if (line.length >= 4) lines.push(line);
      }
      if (lines.length) {
        type = GEOM_LINE;
        geometry = geometryCommands(GEOM_LINE, lines);
      }
    } else {
      const rings = [];
      let keepHoles = false;
      feature.parts.forEach((part, i) => {
        if (!feature.outer[i] && !keepHoles) return;
        const ring = quantize(part, minRank, ox, oy, k, true);
        const big = ring.length >= 6 && Math.abs(area2(ring)) / 2 > minArea;
        if (feature.outer[i]) keepHoles = big;
        if (big) rings.push(wind(ring, feature.outer[i]));
      });
      if (rings.length) {
        type = GEOM_POLYGON;
        geometry = geometryCommands(GEOM_POLYGON, rings);
      }
    }
    if (geometry) layers[store.layer.array[feature.id]].features.push({ type, geometry, props: store.propsOf(feature.id) });
  }
  return encodeTile(layers, EXTENT);
}

/**
 * Writes every tile the map needs (bounds.mjs) to `outDir/{z}/{x}/{y}.pbf`: zooms 0–9 from the
 * features shown that far out, then zooms 10–14 one zoom-10 tile at a time.
 */
export function writeTiles(store, outDir, log = console.log) {
  const stats = { tiles: 0, bytes: 0, empty: 0, largest: 0, largestTile: '' };
  const madeDirs = new Set();
  const write = (z, x, y, bytes) => {
    const dir = join(outDir, String(z), String(x));
    if (!madeDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    }
    writeFileSync(join(dir, `${y}.pbf`), bytes);
    stats.tiles += 1;
    stats.bytes += bytes.length;
    if (bytes.length === 0) stats.empty += 1;
    if (bytes.length > stats.largest) {
      stats.largest = bytes.length;
      stats.largestTile = `${z}/${x}/${y}`;
    }
  };
  const descend = (features, z, x, y, lastZoom) => {
    if (!hasTile(z, x, y)) return;
    write(z, x, y, encodeAt(store, features, z, x, y));
    if (z >= lastZoom) return;
    for (const [cx, cy] of [[2 * x, 2 * y], [2 * x + 1, 2 * y], [2 * x, 2 * y + 1], [2 * x + 1, 2 * y + 1]]) {
      if (!hasTile(z + 1, cx, cy)) continue;
      const box = tileBox(z + 1, cx, cy);
      const inside = [];
      for (const feature of features) {
        const clipped = clipFeature(feature, box);
        if (clipped) inside.push(clipped);
      }
      descend(inside, z + 1, cx, cy, lastZoom);
    }
  };

  const live = [];
  for (let id = 0; id < store.count; id += 1) if (!store.deleted.array[id]) live.push(id);

  log(`Tiling zooms 0–${CHUNK_ZOOM - 1}...`);
  const overview = live.filter((id) => store.minzoom.array[id] < CHUNK_ZOOM).map((id) => rank(project(store, id)));
  descend(overview, 0, 0, 0, CHUNK_ZOOM - 1);
  overview.length = 0;

  // Which zoom-10 tiles each feature touches (by its bounds plus the tile buffer).
  const chunks = new Map();
  const n = 2 ** CHUNK_ZOOM;
  const margin = BUFFER / EXTENT;
  for (const id of live) {
    if (store.maxzoom.array[id] < CHUNK_ZOOM) continue;
    const b = store.bounds.array;
    const west = b[4 * id] / SCALE;
    const south = b[4 * id + 1] / SCALE;
    const east = b[4 * id + 2] / SCALE;
    const north = b[4 * id + 3] / SCALE;
    const minX = Math.max(0, Math.floor(mercatorX(west) / WORLD * n - margin));
    const maxX = Math.min(n - 1, Math.floor(mercatorX(east) / WORLD * n + margin));
    const minY = Math.max(0, Math.floor(mercatorY(north) / WORLD * n - margin));
    const maxY = Math.min(n - 1, Math.floor(mercatorY(south) / WORLD * n + margin));
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        if (!hasTile(CHUNK_ZOOM, x, y)) continue;
        const key = x * n + y;
        let list = chunks.get(key);
        if (!list) chunks.set(key, (list = []));
        list.push(id);
      }
    }
  }
  const ranges = tileRangesAt(CHUNK_ZOOM);
  const chunkTiles = new Set();
  for (const r of ranges) for (let x = r.minX; x <= r.maxX; x += 1) for (let y = r.minY; y <= r.maxY; y += 1) chunkTiles.add(x * n + y);
  let done = 0;
  for (const key of chunkTiles) {
    const x = Math.floor(key / n);
    const y = key % n;
    const box = tileBox(CHUNK_ZOOM, x, y);
    const features = [];
    for (const id of chunks.get(key) ?? []) {
      const clipped = clipFeature(project(store, id), box);
      if (clipped) features.push(rank(clipped));
    }
    descend(features, CHUNK_ZOOM, x, y, MAX_ZOOM);
    done += 1;
    if (done % 10 === 0 || done === chunkTiles.size) log(`  ${done}/${chunkTiles.size} zoom-${CHUNK_ZOOM} areas, ${stats.tiles} tiles, ${(stats.bytes / 1e6).toFixed(0)} MB`);
  }
  return stats;
}
