// Plane geometry on longitude/latitude: rings are flat [x0, y0, x1, y1, ...] arrays, open (the first
// point isn't repeated at the end), lines are flat arrays too.

/** Twice the signed area (positive when counterclockwise on a north-up map). */
export function ringArea2(ring) {
  const n = ring.length / 2;
  if (n < 3) return 0;
  // Relative to the first point, so huge coordinates don't eat the sum's precision.
  const ox = ring[0];
  const oy = ring[1];
  let sum = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    sum += (ring[2 * j] - ox) * (ring[2 * i + 1] - oy) - (ring[2 * i] - ox) * (ring[2 * j + 1] - oy);
  }
  return sum;
}

/** A ring's area in square meters (rings in degrees). */
export function ringAreaMeters(ring) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < ring.length; i += 2) {
    if (ring[i] < minY) minY = ring[i];
    if (ring[i] > maxY) maxY = ring[i];
  }
  const kx = 111320 * Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
  return (Math.abs(ringArea2(ring)) / 2) * kx * 110574;
}

export function reverseRing(ring) {
  const out = new Array(ring.length);
  const n = ring.length / 2;
  for (let i = 0; i < n; i += 1) {
    out[2 * i] = ring[2 * (n - 1 - i)];
    out[2 * i + 1] = ring[2 * (n - 1 - i) + 1];
  }
  return out;
}

/** The ring turned to run counterclockwise (outer rings) or clockwise (holes). */
export function orient(ring, counterclockwise) {
  return ringArea2(ring) > 0 === counterclockwise ? ring : reverseRing(ring);
}

export function ringBounds(ring) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i];
    const y = ring[i + 1];
    if (x < west) west = x;
    if (x > east) east = x;
    if (y < south) south = y;
    if (y > north) north = y;
  }
  return { west, south, east, north };
}

export const insideBox = (box, x, y) => x >= box.west && x <= box.east && y >= box.south && y <= box.north;
export const boxContainsBox = (outer, inner) => inner.west >= outer.west && inner.east <= outer.east && inner.south >= outer.south && inner.north <= outer.north;
export const boxesOverlap = (a, b) => a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;

/** Whether a point is inside a ring (even-odd). */
export function pointInRing(ring, x, y) {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i];
    const yi = ring[2 * i + 1];
    const xj = ring[2 * j];
    const yj = ring[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A ring prepared for many point-in-ring tests: its edges sorted into horizontal bands, so a test
 * only looks at the edges at its own height.
 */
export function ringIndex(ring) {
  const box = ringBounds(ring);
  const n = ring.length / 2;
  const bandCount = Math.max(1, Math.min(8192, Math.floor(n / 8)));
  const bandHeight = (box.north - box.south) / bandCount || 1;
  const bands = Array.from({ length: bandCount }, () => []);
  const bandOf = (y) => Math.max(0, Math.min(bandCount - 1, Math.floor((y - box.south) / bandHeight)));
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = bandOf(ring[2 * i + 1]);
    const b = bandOf(ring[2 * j + 1]);
    for (let band = Math.min(a, b); band <= Math.max(a, b); band += 1) bands[band].push(j);
  }
  return {
    box,
    contains(x, y) {
      if (!insideBox(box, x, y)) return false;
      let inside = false;
      for (const j of bands[bandOf(y)]) {
        const i = (j + 1) % n;
        const xi = ring[2 * i];
        const yi = ring[2 * i + 1];
        const xj = ring[2 * j];
        const yj = ring[2 * j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },
  };
}

/** Clips a ring to a box (Sutherland–Hodgman); null when nothing is left. */
export function clipRing(ring, box) {
  let points = ring;
  points = clipRingAxis(points, 0, box.west, true);
  points = clipRingAxis(points, 0, box.east, false);
  points = clipRingAxis(points, 1, box.south, true);
  points = clipRingAxis(points, 1, box.north, false);
  return points.length >= 6 ? points : null;
}

function clipRingAxis(points, axis, value, keepAbove) {
  const n = points.length / 2;
  if (n === 0) return points;
  const out = [];
  const inside = (i) => (keepAbove ? points[2 * i + axis] >= value : points[2 * i + axis] <= value);
  let previous = n - 1;
  let previousInside = inside(previous);
  for (let i = 0; i < n; i += 1) {
    const currentInside = inside(i);
    if (currentInside !== previousInside) {
      const ax = points[2 * previous];
      const ay = points[2 * previous + 1];
      const bx = points[2 * i];
      const by = points[2 * i + 1];
      const t = axis === 0 ? (value - ax) / (bx - ax) : (value - ay) / (by - ay);
      if (axis === 0) out.push(value, ay + (by - ay) * t);
      else out.push(ax + (bx - ax) * t, value);
    }
    if (currentInside) out.push(points[2 * i], points[2 * i + 1]);
    previous = i;
    previousInside = currentInside;
  }
  return out;
}

/** Clips a line to a box (Liang–Barsky per segment); the pieces left inside, each 2+ points. */
export function clipLine(line, box) {
  const parts = [];
  let current = null;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i];
    const ay = line[i + 1];
    const bx = line[i + 2];
    const by = line[i + 3];
    const dx = bx - ax;
    const dy = by - ay;
    let t0 = 0;
    let t1 = 1;
    let visible = true;
    for (const [p, q] of [[-dx, ax - box.west], [dx, box.east - ax], [-dy, ay - box.south], [dy, box.north - ay]]) {
      if (p === 0) {
        if (q < 0) { visible = false; break; }
      } else {
        const r = q / p;
        if (p < 0) { if (r > t1) { visible = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { visible = false; break; } if (r < t1) t1 = r; }
      }
    }
    if (!visible) {
      if (current) parts.push(current);
      current = null;
      continue;
    }
    if (!current || t0 > 0) {
      if (current) parts.push(current);
      current = [ax + dx * t0, ay + dy * t0];
    }
    current.push(ax + dx * t1, ay + dy * t1);
    if (t1 < 1) {
      parts.push(current);
      current = null;
    }
  }
  if (current) parts.push(current);
  return parts.filter((part) => part.length >= 4);
}

/** A point on the box's edge snapped exactly onto the nearest side. */
function snapToEdge(x, y, box) {
  const distances = [Math.abs(y - box.south), Math.abs(x - box.east), Math.abs(y - box.north), Math.abs(x - box.west)];
  const side = distances.indexOf(Math.min(...distances));
  if (side === 0) return [x, box.south];
  if (side === 1) return [box.east, y];
  if (side === 2) return [x, box.north];
  return [box.west, y];
}

/** A point on the box's edge as a distance around it, counterclockwise from the southwest corner (0–4). */
function aroundEdge(x, y, box) {
  if (y === box.south && x !== box.east) return (x - box.west) / (box.east - box.west);
  if (x === box.east && y !== box.north) return 1 + (y - box.south) / (box.north - box.south);
  if (y === box.north && x !== box.west) return 2 + (box.east - x) / (box.east - box.west);
  return 3 + (box.north - y) / (box.north - box.south);
}

/** The stretches of a closed ring inside the box, each from where it comes in to where it goes out. */
function ringPiecesInside(ring, box) {
  const n = ring.length / 2;
  let start = 0;
  while (start < n && insideBox(box, ring[2 * start], ring[2 * start + 1])) start += 1;
  if (start === n) return null; // all inside (the caller keeps it whole)
  const pieces = [];
  let current = null;
  for (let k = 0; k < n; k += 1) {
    const i = (start + k) % n;
    const j = (i + 1) % n;
    const ax = ring[2 * i];
    const ay = ring[2 * i + 1];
    const dx = ring[2 * j] - ax;
    const dy = ring[2 * j + 1] - ay;
    let t0 = 0;
    let t1 = 1;
    let visible = true;
    for (const [p, q] of [[-dx, ax - box.west], [dx, box.east - ax], [-dy, ay - box.south], [dy, box.north - ay]]) {
      if (p === 0) {
        if (q < 0) { visible = false; break; }
      } else {
        const r = q / p;
        if (p < 0) { if (r > t1) { visible = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { visible = false; break; } if (r < t1) t1 = r; }
      }
    }
    if (!visible) continue;
    if (!current) current = snapToEdge(ax + dx * t0, ay + dy * t0, box);
    if (t1 < 1) {
      current.push(...snapToEdge(ax + dx * t1, ay + dy * t1, box));
      if (current.length >= 4 && (current[0] !== current[current.length - 2] || current[1] !== current[current.length - 1] || current.length > 4)) pieces.push(current);
      current = null;
    } else {
      current.push(ax + dx, ay + dy);
    }
  }
  return pieces;
}

/**
 * Clips a polygon (outer ring counterclockwise, then holes clockwise) to a box. Rather than
 * clipping ring by ring (which leaves zero-width slivers running along the box's edge, and a map
 * outlines every edge, so each sliver shows as a hairline), the stretches of all the rings inside
 * the box are joined by walking the box's edge the way the rings' own insides lie. Returns the
 * polygons left ([outer, ...holes] each; none when the box misses it).
 */
export function clipPolygon(rings, box) {
  const whole = [];
  const pieces = [];
  for (const ring of rings) {
    const bounds = ringBounds(ring);
    if (!boxesOverlap(box, bounds)) continue;
    const inside = boxContainsBox(box, bounds) ? null : ringPiecesInside(ring, box);
    if (inside === null) whole.push(ring);
    else pieces.push(...inside);
  }
  const corners = [[box.west, box.south], [box.east, box.south], [box.east, box.north], [box.west, box.north]];
  const joined = [];
  if (pieces.length) {
    const ends = pieces.map((piece) => ({ piece, enter: aroundEdge(piece[0], piece[1], box), leave: aroundEdge(piece[piece.length - 2], piece[piece.length - 1], box) }));
    const unused = new Set(ends.keys());
    while (unused.size) {
      const first = unused.values().next().value;
      unused.delete(first);
      const ring = [...ends[first].piece];
      let current = first;
      for (let guard = 0; guard <= ends.length; guard += 1) {
        const leave = ends[current].leave;
        let best = first;
        let bestGap = Infinity;
        for (const candidate of [...unused, first]) {
          let gap = ends[candidate].enter - leave;
          if (gap < -1e-12) gap += 4;
          if (gap < bestGap) {
            bestGap = gap;
            best = candidate;
          }
        }
        // The box's corners passed on the way, counterclockwise.
        for (let k = Math.floor(leave) + 1; k < leave + bestGap; k += 1) ring.push(...corners[k % 4]);
        if (best === first) break;
        for (const value of ends[best].piece) ring.push(value);
        unused.delete(best);
        current = best;
      }
      // Repeated points where a stretch meets the edge walk.
      const clean = [];
      for (let i = 0; i < ring.length; i += 2) {
        if (clean.length && clean[clean.length - 2] === ring[i] && clean[clean.length - 1] === ring[i + 1]) continue;
        clean.push(ring[i], ring[i + 1]);
      }
      if (clean.length >= 4 && clean[0] === clean[clean.length - 2] && clean[1] === clean[clean.length - 1]) clean.length -= 2;
      if (clean.length >= 6 && ringArea2(clean) !== 0) joined.push(clean);
    }
  } else if (pointInRing(rings[0], box.west, box.south) && !rings.slice(1).some((hole) => pointInRing(hole, box.west, box.south))) {
    // No ring crosses the box's edge, and the edge is inside the polygon: the whole box is.
    joined.push([box.west, box.south, box.east, box.south, box.east, box.north, box.west, box.north]);
  }
  const all = [...joined, ...whole];
  const outers = all.filter((ring) => ringArea2(ring) > 0).map((ring) => ({ rings: [ring], box: ringBounds(ring), area: ringArea2(ring) })).sort((a, b) => a.area - b.area);
  for (const hole of all.filter((ring) => ringArea2(ring) < 0)) {
    const owner = outers.find((outer) => insideBox(outer.box, hole[0], hole[1]) && pointInRing(outer.rings[0], hole[0], hole[1]));
    if (owner) owner.rings.push(hole);
  }
  return outers.map((outer) => outer.rings);
}

/**
 * Where to put a polygon's label: its centroid when that's inside it, or else the middle of its
 * widest stretch across the centroid's latitude.
 */
export function labelPoint(rings) {
  const outer = rings[0];
  const n = outer.length / 2;
  const ox = outer[0];
  const oy = outer[1];
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xj = outer[2 * j] - ox;
    const yj = outer[2 * j + 1] - oy;
    const xi = outer[2 * i] - ox;
    const yi = outer[2 * i + 1] - oy;
    const f = xj * yi - xi * yj;
    area += f;
    cx += (xj + xi) * f;
    cy += (yj + yi) * f;
  }
  let x;
  let y;
  if (area === 0) {
    const box = ringBounds(outer);
    x = (box.west + box.east) / 2;
    y = (box.south + box.north) / 2;
  } else {
    x = ox + cx / (3 * area);
    y = oy + cy / (3 * area);
  }
  const inPolygon = (px, py) => pointInRing(outer, px, py) && !rings.slice(1).some((hole) => pointInRing(hole, px, py));
  if (inPolygon(x, y)) return [x, y];
  const crossings = [];
  for (const ring of rings) {
    const m = ring.length / 2;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const yi = ring[2 * i + 1];
      const yj = ring[2 * j + 1];
      if (yi > y !== yj > y) crossings.push(((ring[2 * j] - ring[2 * i]) * (y - yi)) / (yj - yi) + ring[2 * i]);
    }
  }
  crossings.sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    if (!best || crossings[i + 1] - crossings[i] > best[1] - best[0]) best = [crossings[i], crossings[i + 1]];
  }
  return best ? [(best[0] + best[1]) / 2, y] : [ox, oy];
}

const METERS_PER_PIXEL_Z0 = (40075016.686 * Math.cos((41 * Math.PI) / 180)) / 512;

/**
 * The first zoom at which an area covers `pixels` square pixels (MapLibre zooms, at this region's
 * latitude): how features too small to see are kept off the zoomed-out maps.
 */
export function zoomForArea(squareMeters, pixels) {
  if (squareMeters <= 0) return Infinity;
  return Math.max(0, Math.ceil(Math.log2(METERS_PER_PIXEL_Z0 * Math.sqrt(pixels / squareMeters))));
}
