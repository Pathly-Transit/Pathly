// Merges polygons that share edges into one surface, optionally taking other polygons out of it.
// TIGER's polygons are cut from one shared network of edges, so neighbors share exactly the same
// points along a common edge. For each edge, count how many polygons cover each side of it (areas
// taken away count against); the merged outline is the edges with cover on exactly one side, turned
// to keep it on their left. (Left unmerged, the seams between neighbors show as hairlines.)
import { Grow } from './store.mjs';
import { insideBox, orient, pointInRing, ringArea2, ringBounds, ringIndex } from './geometry.mjs';

const Q = 1e7;

/**
 * The polygons' edges sorted out: `outline` (each edge once, covered side on its left) and `shared`
 * (edges two kept polygons both run along, with the two polygons).
 */
function sortEdges(polygons, negatives = []) {
  const ax = new Grow(Int32Array);
  const ay = new Grow(Int32Array);
  const bx = new Grow(Int32Array);
  const by = new Grow(Int32Array);
  const owner = new Grow(Uint32Array);
  const all = negatives.length ? [...polygons, ...negatives] : polygons;
  all.forEach((polygon, p) => {
    polygon.forEach((ring, r) => {
      // Inside on the left: outer rings counterclockwise, holes clockwise.
      const oriented = orient(ring, r === 0);
      const n = oriented.length / 2;
      for (let k = 0; k < n; k += 1) {
        const x1 = Math.round(oriented[2 * k] * Q);
        const y1 = Math.round(oriented[2 * k + 1] * Q);
        const k2 = (k + 1) % n;
        const x2 = Math.round(oriented[2 * k2] * Q);
        const y2 = Math.round(oriented[2 * k2 + 1] * Q);
        if (x1 === x2 && y1 === y2) continue;
        ax.push(x1);
        ay.push(y1);
        bx.push(x2);
        by.push(y2);
        owner.push(p);
      }
    });
  });
  const count = ax.length;
  const AX = ax.array;
  const AY = ay.array;
  const BX = bx.array;
  const BY = by.array;
  // Each edge keyed low point first, so the same edge in either direction sorts together.
  const forward = new Uint8Array(count);
  const loX = new Int32Array(count);
  const loY = new Int32Array(count);
  const hiX = new Int32Array(count);
  const hiY = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    const aFirst = AX[i] < BX[i] || (AX[i] === BX[i] && AY[i] < BY[i]);
    forward[i] = aFirst ? 1 : 0;
    loX[i] = aFirst ? AX[i] : BX[i];
    loY[i] = aFirst ? AY[i] : BY[i];
    hiX[i] = aFirst ? BX[i] : AX[i];
    hiY[i] = aFirst ? BY[i] : AY[i];
  }
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) order[i] = i;
  order.sort((i, j) => loX[i] - loX[j] || loY[i] - loY[j] || hiX[i] - hiX[j] || hiY[i] - hiY[j]);

  const positives = polygons.length;
  const out = { x1: new Grow(Int32Array), y1: new Grow(Int32Array), x2: new Grow(Int32Array), y2: new Grow(Int32Array), owner: new Grow(Uint32Array) };
  const shared = [];
  // Polygons that overlap another of the same sign (TIGER stores a bay with two names twice).
  const overlapping = new Set();
  for (let start = 0; start < count; ) {
    let end = start + 1;
    const first = order[start];
    while (end < count && loX[order[end]] === loX[first] && loY[order[end]] === loY[first] && hiX[order[end]] === hiX[first] && hiY[order[end]] === hiY[first]) end += 1;
    // Cover on the left and right of the edge run low → high.
    let left = 0;
    let right = 0;
    let keptForward = -1;
    let keptBackward = -1;
    let positiveForward = -1;
    let positiveBackward = -1;
    const sameSide = new Map();
    for (let k = start; k < end; k += 1) {
      const i = order[k];
      const p = owner.array[i];
      const sign = p < positives ? 1 : -1;
      if (forward[i]) left += sign;
      else right += sign;
      if (forward[i]) keptForward = i;
      else keptBackward = i;
      if (sign > 0 && forward[i]) positiveForward = i;
      if (sign > 0 && !forward[i]) positiveBackward = i;
      const side = `${sign}${forward[i]}`;
      if (sameSide.has(side)) {
        overlapping.add(p);
        overlapping.add(sameSide.get(side));
      } else sameSide.set(side, p);
    }
    if (positiveForward >= 0 && positiveBackward >= 0) shared.push({ segment: positiveForward, owners: [owner.array[positiveForward], owner.array[positiveBackward]] });
    // An edge only areas taken away run along (a shore, say) lies inside a kept polygon, which
    // covers both its sides without an edge of its own there.
    if (negatives.length && positiveForward < 0 && positiveBackward < 0) {
      left += 1;
      right += 1;
    }
    if (left > 0 !== right > 0) {
      // Covered side on the left: low → high when the left is covered, else high → low.
      const coveredLeft = left > 0;
      const i = coveredLeft ? (keptForward >= 0 ? keptForward : keptBackward) : keptBackward >= 0 ? keptBackward : keptForward;
      out.x1.push(coveredLeft ? loX[i] : hiX[i]);
      out.y1.push(coveredLeft ? loY[i] : hiY[i]);
      out.x2.push(coveredLeft ? hiX[i] : loX[i]);
      out.y2.push(coveredLeft ? hiY[i] : loY[i]);
      out.owner.push(owner.array[i]);
    }
    start = end;
  }
  const outline = { x1: out.x1.array, y1: out.y1.array, x2: out.x2.array, y2: out.y2.array, owner: out.owner.array, count: out.x1.length, kept: new Uint8Array(out.x1.length).fill(1) };
  if (overlapping.size) dropCoveredEdges(all, positives, overlapping, outline);
  return { outline, shared, ax: AX, ay: AY, bx: BX, by: BY };
}

/**
 * Where polygons overlap without sharing edges (one bay lying inside a bigger one of another
 * name), the inner one's edges aren't on the merged outline. An outline edge (cover on its left)
 * is dropped when the point just right of it is inside an overlapping kept polygon, or the point
 * just left of it is inside an overlapping area taken away.
 */
function dropCoveredEdges(all, positives, overlapping, outline) {
  const shapes = [];
  for (const p of overlapping) {
    const rings = all[p];
    shapes.push({ p, negative: p >= positives, box: ringBounds(rings[0]), outer: ringIndex(rings[0]), holes: rings.slice(1).map((ring) => ringIndex(ring)) });
  }
  const inside = (shape, x, y) => insideBox(shape.box, x, y) && shape.outer.contains(x, y) && !shape.holes.some((hole) => hole.contains(x, y));
  const offset = 2e-6; // degrees: ~20 cm, past rounding but inside any real feature
  for (let i = 0; i < outline.count; i += 1) {
    if (!overlapping.has(outline.owner[i])) continue;
    const x1 = outline.x1[i] / Q;
    const y1 = outline.y1[i] / Q;
    const dx = outline.x2[i] / Q - x1;
    const dy = outline.y2[i] / Q - y1;
    const length = Math.hypot(dx, dy) || 1;
    const mx = x1 + dx / 2;
    const my = y1 + dy / 2;
    const nx = (dy * offset) / length;
    const ny = (-dx * offset) / length;
    for (const shape of shapes) {
      if (shape.p === outline.owner[i]) continue;
      const covered = shape.negative ? inside(shape, mx - nx, my - ny) : inside(shape, mx + nx, my + ny);
      if (covered) {
        outline.kept[i] = 0;
        break;
      }
    }
  }
}

/** Joins directed edges end to start into closed rings (in degrees). */
function ringsFrom(outline) {
  const { x1, y1, x2, y2, kept } = outline;
  const indices = [];
  for (let i = 0; i < outline.count; i += 1) if (kept[i]) indices.push(i);
  const order = Uint32Array.from(indices);
  order.sort((i, j) => x1[i] - x1[j] || y1[i] - y1[j]);
  const used = new Uint8Array(order.length);
  const startAt = (x, y) => {
    let low = 0;
    let high = order.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const i = order[mid];
      if (x1[i] < x || (x1[i] === x && y1[i] < y)) low = mid + 1;
      else high = mid;
    }
    for (let k = low; k < order.length && x1[order[k]] === x && y1[order[k]] === y; k += 1) if (!used[k]) return k;
    return -1;
  };
  const rings = [];
  let open = 0;
  for (let s = 0; s < order.length; s += 1) {
    if (used[s]) continue;
    used[s] = 1;
    const first = order[s];
    const ring = [x1[first] / Q, y1[first] / Q];
    let current = first;
    for (;;) {
      const x = x2[current];
      const y = y2[current];
      if (x === x1[first] && y === y1[first]) break;
      ring.push(x / Q, y / Q);
      const next = startAt(x, y);
      if (next < 0) {
        open += 1;
        break;
      }
      used[next] = 1;
      current = order[next];
    }
    if (ring.length >= 6) rings.push(ring);
  }
  return { rings, open };
}

/** Rings sorted into polygons: counterclockwise rings are outer, clockwise ones holes in the smallest outer around them. */
function polygonsFrom(rings) {
  const outers = [];
  const holes = [];
  for (const ring of rings) (ringArea2(ring) > 0 ? outers : holes).push(ring);
  const polygons = outers.map((ring) => ({ rings: [ring], box: ringBounds(ring), area: ringArea2(ring) })).sort((a, b) => a.area - b.area);
  for (const hole of holes) {
    const n = hole.length / 2;
    const probes = [[hole[0], hole[1]], [hole[2 * Math.floor(n / 2)], hole[2 * Math.floor(n / 2) + 1]]];
    for (const polygon of polygons) {
      if (!insideBox(polygon.box, hole[0], hole[1])) continue;
      if (polygon.rings[0].length > 2000) polygon.index ??= ringIndex(polygon.rings[0]);
      const contains = (x, y) => (polygon.index ? polygon.index.contains(x, y) : pointInRing(polygon.rings[0], x, y));
      if (probes.some(([x, y]) => contains(x, y))) {
        polygon.rings.push(hole);
        break;
      }
    }
  }
  return polygons.map((polygon) => polygon.rings);
}

/**
 * Polygons ([outer, ...holes], degrees) merged where they share edges, less `negatives`: areas
 * inside them, cut from the same edges (water taken out of the land, for instance).
 */
export function dissolve(polygons, negatives = []) {
  const { outline } = sortEdges(polygons, negatives);
  const { rings, open } = ringsFrom(outline);
  return { polygons: polygonsFrom(rings), open };
}

/** The edges neighbors share, as [x1, y1, x2, y2] in degrees with the two polygons' indexes. */
export function sharedEdges(polygons) {
  const { ax, ay, bx, by, shared } = sortEdges(polygons);
  return shared.map(({ segment, owners }) => ({ coords: [ax[segment] / Q, ay[segment] / Q, bx[segment] / Q, by[segment] / Q], owners }));
}
