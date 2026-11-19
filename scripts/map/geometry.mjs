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

/** Clips a polygon (outer ring, then holes) to a box; null when the outer ring is gone. */
export function clipPolygon(rings, box) {
  const outer = clipRing(rings[0], box);
  if (!outer) return null;
  const out = [outer];
  for (let i = 1; i < rings.length; i += 1) {
    const hole = clipRing(rings[i], box);
    if (hole) out.push(hole);
  }
  return out;
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
