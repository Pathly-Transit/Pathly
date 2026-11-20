export type LatLon = { lat: number; lon: number };

const METERS_PER_DEGREE = 111_320;

/** Approximate distance in meters; plenty accurate at a route's scale. */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const y = b.lat - a.lat;
  return Math.hypot(x, y) * METERS_PER_DEGREE;
}

/**
 * A rider this close to their stop (straight line) is framed with it on the route map; one farther
 * off isn't. About an hour's walk on streets, matching how far the walk there is drawn
 * (getWalkingPathToStop in firebase/functions/src/gtfsDiscovery.ts).
 */
const RIDER_NEAR_STOP_METERS = 4_000;

/** Whether the rider (real GPS) is close enough to `stop` that the map should show both. */
export function riderNearStop(rider: { latitude: number; longitude: number }, stop: LatLon): boolean {
  return distanceMeters({ lat: rider.latitude, lon: rider.longitude }, stop) <= RIDER_NEAR_STOP_METERS;
}

/**
 * The least span (degrees, ~1.3 km) the route map frames a stop with the rider or a vehicle at.
 * Closer than that, a fit would zoom to street level, where the line's shape (drawn between a
 * handful of points) visibly cuts across the streets it runs under.
 */
export const MIN_FIT_SPAN = 0.012;

/** `points`, plus two corners around their middle when they're closer together than MIN_FIT_SPAN. */
export function withMinimumFitSpan(points: readonly { lat: number; lng: number }[]): { lat: number; lng: number }[] {
  if (points.length === 0) return [];
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  if (maxLat - minLat >= MIN_FIT_SPAN || maxLng - minLng >= MIN_FIT_SPAN) return [...points];
  const [lat, lng, half] = [(minLat + maxLat) / 2, (minLng + maxLng) / 2, MIN_FIT_SPAN / 2];
  return [...points, { lat: lat - half, lng: lng - half }, { lat: lat + half, lng: lng + half }];
}

/** Compass bearing from `a` to `b`, in degrees clockwise from north (0–360). */
export function bearingDegrees(a: LatLon, b: LatLon): number {
  const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const y = b.lat - a.lat;
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

type Projection = { segment: number; t: number; point: LatLon; distance: number };

/** The point on `path` nearest `point`, searching segments `from`..`to` (segment i joins points i and i + 1). */
function projectOnPath(path: readonly LatLon[], point: LatLon, from = 0, to = path.length - 2): Projection {
  // Meters on a flat plane around `point`: exact enough at a route's scale.
  const xScale = METERS_PER_DEGREE * Math.cos(point.lat * (Math.PI / 180));
  const x = (p: LatLon) => (p.lon - point.lon) * xScale;
  const y = (p: LatLon) => (p.lat - point.lat) * METERS_PER_DEGREE;
  let best: Projection = { segment: from, t: 0, point: path[from]!, distance: Infinity };
  for (let segment = from; segment <= to; segment += 1) {
    const a = path[segment]!;
    const b = path[segment + 1]!;
    const dx = x(b) - x(a);
    const dy = y(b) - y(a);
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(x(a) * dx + y(a) * dy) / lengthSquared));
    const distance = Math.hypot(x(a) + t * dx, y(a) + t * dy);
    if (distance < best.distance) {
      best = { segment, t, point: { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) }, distance };
    }
  }
  return best;
}

/**
 * The live vehicle on its way to the rider's stop: of `vehicles` running along `behind` (the line
 * leading up to the stop, ending at it), the one with the least of it left to cover. Null when none
 * is on that stretch (within `maxOffMeters` of it: GPS and the drawn line don't match exactly).
 */
export function approachingVehicle<T extends LatLon>(behind: readonly LatLon[], vehicles: readonly T[], maxOffMeters = 250): T | null {
  if (behind.length < 2) return null;
  // Distance along `behind` to its end (the stop) from the start of each segment.
  const toEnd: number[] = new Array(behind.length).fill(0);
  for (let index = behind.length - 2; index >= 0; index -= 1) toEnd[index] = toEnd[index + 1]! + distanceMeters(behind[index]!, behind[index + 1]!);
  let best: { vehicle: T; left: number } | null = null;
  for (const vehicle of vehicles) {
    const projection = projectOnPath(behind, vehicle);
    if (projection.distance > maxOffMeters) continue;
    const left = toEnd[projection.segment + 1]! + distanceMeters(projection.point, behind[projection.segment + 1]!);
    if (!best || left < best.left) best = { vehicle, left };
  }
  return best?.vehicle ?? null;
}

/** Whether `point` is on `path`: within `maxOffMeters` of it, since GPS and the drawn line don't match exactly. */
export function onPath(path: readonly LatLon[], point: LatLon, maxOffMeters = 250): boolean {
  return path.length >= 2 && projectOnPath(path, point).distance <= maxOffMeters;
}

/**
 * `path` cut at the stop `stops[stopIndex]`: the part behind the rider and the part ahead, both
 * ending exactly at the spot on the line nearest the stop. Paths can have points kilometers apart
 * (the 1 train's shape runs 7 km without one), so cutting at the nearest point instead moved the
 * faint/full change far down the line. `path` and `stops` are both in travel order; the search
 * stays between the neighboring stops, so a line that passes the same stop twice (a loop) still
 * cuts at the right pass.
 */
export function splitPathAtStop(path: readonly LatLon[], stops: readonly LatLon[], stopIndex: number): { behind: LatLon[]; ahead: LatLon[] } {
  const stop = stops[stopIndex];
  if (path.length < 2 || !stop) return { behind: [], ahead: [...path] };
  const lastSegment = path.length - 2;
  const previous = stops[stopIndex - 1];
  const next = stops[stopIndex + 1];
  const from = previous ? projectOnPath(path, previous).segment : 0;
  const to = next ? projectOnPath(path, next, from).segment : lastSegment;
  const cut = projectOnPath(path, stop, from, Math.max(from, to));
  // A stop right on a path point cuts there, without repeating the point.
  const before = path.slice(0, cut.segment + 1);
  const after = path.slice(cut.segment + 1);
  if (cut.t === 0) return { behind: before, ahead: [cut.point, ...after] };
  if (cut.t === 1) return { behind: [...before, cut.point], ahead: after };
  return { behind: [...before, cut.point], ahead: [cut.point, ...after] };
}

// The arrow is drawn at a fixed size on screen (DirectionArrow.tsx), so where it can go is worked
// out in screen pixels and converted to meters for the map's current zoom. In meters alone, zooming
// out would let a bend in the line curl into it.
/** How far either side of the arrow's spot (px) the line must run straight: the arrow's length plus room. */
const ARROW_HALF_SPAN_PX = 24;
/** The arrow's drawing (DirectionArrow.tsx): its shaft runs this far (px) beside the line... */
export const ARROW_SIDE_OFFSET_PX = 22;
/** ...this long either side of its middle (px)... */
export const ARROW_HALF_LENGTH_PX = 15;
/** ...with a head this wide either side of the shaft (px). */
export const ARROW_HEAD_PX = 6;
/**
 * How close (px) any part of the drawn line may come to the arrow's shaft: the head, half the
 * 8 px line, and a little air. Checked against the whole line, so a curve, a loop, or the line
 * coming back the other way never runs through the arrow.
 */
const ARROW_CLEARANCE_PX = ARROW_HEAD_PX + 4 + 4;
/** The most the line may stray (px) toward the arrow across that span and still clear it. */
const ARROW_MAX_STRAY_PX = 6;
/** Where to look along the line ahead (px from the rider's stop), and how far apart to try. */
const ARROW_FROM_PX = 30;
const ARROW_TO_PX = 160;
const ARROW_STEP_PX = 6;

/**
 * How far (zoom levels) the map may zoom out from where the arrow was placed before it's hidden.
 * The arrow is placed for that most zoomed-out view, where the line's bends come closest to it.
 */
export const ARROW_ZOOM_SLACK = 0.5;

/** Meters per screen pixel at a web-map zoom level and latitude. */
export function metersPerPixel(zoom: number, lat: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * Where to draw the direction arrow beside a line at the map's current scale: the straightest
 * stretch of `ahead` (the line from the rider's stop onward) a little way past the stop, preferring
 * spots near it. Drawn beside a bend, the line would curl into the arrow, so null when no stretch is
 * straight enough at this zoom (and when there's no line ahead to point along).
 */
export function directionArrowAt(ahead: readonly LatLon[], metersPerPx = 3, alsoDrawn: readonly (readonly LatLon[])[] = []): DirectionArrowSpot | null {
  const line = measureLine(ahead);
  const halfSpan = ARROW_HALF_SPAN_PX * metersPerPx;
  // A line too short on screen for the arrow beside it: nothing to point along.
  if (!line || line.total < 2 * halfSpan) return null;
  const first = Math.min(ARROW_FROM_PX * metersPerPx, line.total / 2);
  const last = Math.min(ARROW_TO_PX * metersPerPx, line.total - halfSpan);
  return straightestSpot(line, metersPerPx, Math.max(first, halfSpan), last, first, [ahead, ...alsoDrawn]);
}

/** Where the arrow goes: its spot on the line, the line's bearing there, and which side of the line it's drawn on. */
export type DirectionArrowSpot = { point: LatLon; bearing: number; side: 'right' | 'left' };

/**
 * Where to draw the direction arrow on a whole line, with no rider's stop to start from (a line
 * looked up by name): the straightest stretch near the middle of the line, so it shows which way
 * this direction runs wherever the rider is. Null when the line is too short or bendy at this zoom.
 */
export function middleDirectionArrowAt(points: readonly LatLon[], metersPerPx = 3): DirectionArrowSpot | null {
  const line = measureLine(points);
  const halfSpan = ARROW_HALF_SPAN_PX * metersPerPx;
  if (!line || line.total < 2 * halfSpan) return null;
  return straightestSpot(line, metersPerPx, halfSpan, line.total - halfSpan, line.total / 2, [points]);
}

type MeasuredLine = { total: number; along: (meters: number) => LatLon };

/** A line with the distance along it to each point, for finding the spot any distance along it. */
function measureLine(points: readonly LatLon[]): MeasuredLine | null {
  if (points.length < 2) return null;
  const at: number[] = [0];
  for (let index = 1; index < points.length; index += 1) at.push(at[index - 1]! + distanceMeters(points[index - 1]!, points[index]!));
  const total = at[at.length - 1]!;
  if (total < 1) return null;
  const along = (meters: number): LatLon => {
    const target = Math.max(0, Math.min(meters, total));
    // The last point at or before `target` (lines can have thousands of points).
    let low = 0;
    let high = at.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (at[mid]! <= target) low = mid;
      else high = mid;
    }
    const a = points[low]!;
    const b = points[high]!;
    const length = at[high]! - at[low]!;
    const t = length > 0 ? (target - at[low]!) / length : 0;
    return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
  };
  return { total, along };
}

/**
 * The straightest spot for the arrow between `from` and `to` meters along, preferring ones near
 * `prefer`, where every line in `drawn` stays clear of it (on the right of the line, else the left).
 */
function straightestSpot(line: MeasuredLine, metersPerPx: number, from: number, to: number, prefer: number, drawn: readonly (readonly LatLon[])[]): DirectionArrowSpot | null {
  const halfSpan = ARROW_HALF_SPAN_PX * metersPerPx;
  const candidates: { point: LatLon; bearing: number; cost: number }[] = [];
  for (let at = from; at <= to; at += ARROW_STEP_PX * metersPerPx) {
    const start = line.along(at - halfSpan);
    const end = line.along(at + halfSpan);
    // How far the line strays from the straight chord across the arrow's span.
    let stray = 0;
    for (let step = -4; step <= 4; step += 1) {
      stray = Math.max(stray, distanceToChordMeters(line.along(at + (step / 4) * halfSpan), start, end));
    }
    if (stray > ARROW_MAX_STRAY_PX * metersPerPx) continue;
    // A little stray is worth a spot nearer the preferred one.
    const cost = stray / metersPerPx + (Math.abs(at - prefer) / metersPerPx) * 0.02;
    candidates.push({ point: line.along(at), bearing: bearingDegrees(start, end), cost });
  }
  // Best first; the (costlier) clearance check runs only until one passes.
  candidates.sort((a, b) => a.cost - b.cost);
  for (const candidate of candidates) {
    for (const side of ['right', 'left'] as const) {
      if (arrowIsClear(candidate.point, candidate.bearing, side, metersPerPx, drawn)) return { point: candidate.point, bearing: candidate.bearing, side };
    }
  }
  return null;
}

/** Whether the arrow drawn at `point` (turned to `bearing`, on `side`) is at least ARROW_CLEARANCE_PX from every drawn line. */
function arrowIsClear(point: LatLon, bearing: number, side: 'right' | 'left', metersPerPx: number, drawn: readonly (readonly LatLon[])[]): boolean {
  // Flat meters around the arrow's spot: x east, y north.
  const xScale = METERS_PER_DEGREE * Math.cos(point.lat * (Math.PI / 180));
  const toXY = (p: LatLon): [number, number] => [(p.lon - point.lon) * xScale, (p.lat - point.lat) * METERS_PER_DEGREE];
  const radians = (bearing * Math.PI) / 180;
  const along: [number, number] = [Math.sin(radians), Math.cos(radians)];
  // Facing the way the line runs, right is clockwise.
  const sign = side === 'right' ? 1 : -1;
  const across: [number, number] = [along[1] * sign, -along[0] * sign];
  const offset = ARROW_SIDE_OFFSET_PX * metersPerPx;
  const half = ARROW_HALF_LENGTH_PX * metersPerPx;
  const tail: [number, number] = [across[0] * offset - along[0] * half, across[1] * offset - along[1] * half];
  const tip: [number, number] = [across[0] * offset + along[0] * half, across[1] * offset + along[1] * half];
  const clearance = ARROW_CLEARANCE_PX * metersPerPx;
  // Only segments that come anywhere near need the exact check.
  const reach = offset + half + clearance;
  for (const path of drawn) {
    let previous: [number, number] | null = null;
    for (const spot of path) {
      const current = toXY(spot);
      if (previous) {
        const near = Math.min(Math.hypot(...previous), Math.hypot(...current)) <= reach + Math.hypot(current[0] - previous[0], current[1] - previous[1]);
        if (near && segmentDistance(previous, current, tail, tip) < clearance) return false;
      }
      previous = current;
    }
  }
  return true;
}

type XY = [number, number];

function pointToSegment(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** The shortest distance between segments ab and cd (0 when they cross). */
function segmentDistance(a: XY, b: XY, c: XY, d: XY): number {
  const cross = (o: XY, p: XY, q: XY) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pointToSegment(a, c, d), pointToSegment(b, c, d), pointToSegment(c, a, b), pointToSegment(d, a, b));
}

/** A point's distance from the straight line through `a` and `b`, in meters (flat-earth, fine at this scale). */
function distanceToChordMeters(point: LatLon, a: LatLon, b: LatLon): number {
  const cos = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const bx = (b.lon - a.lon) * cos;
  const by = b.lat - a.lat;
  const px = (point.lon - a.lon) * cos;
  const py = point.lat - a.lat;
  const length = Math.hypot(bx, by);
  if (length === 0) return Math.hypot(px, py) * 111_320;
  return (Math.abs(bx * py - by * px) / length) * 111_320;
}

/** `#RRGGBB` with an alpha channel (0–1); other color formats are returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase()}`;
}

/**
 * Where the rider's stop sits in a route's stop list. The nearest-stop lookup names a platform
 * (subway "127N"), while route geometry lists stations ("127"), so an exact id match alone misses
 * every subway stop and the map fell back to the whole line. Tries the exact id, then the station
 * the platform belongs to, then the stop's name. -1 when none match.
 */
export function focusStopIndex(stops: readonly { stopId?: string; name: string }[], stopId: string | undefined, stopName?: string): number {
  if (stopId) {
    const exact = stops.findIndex((stop) => stop.stopId === stopId);
    if (exact >= 0) return exact;
    const station = stopId.replace(/[NS]$/, '');
    const parent = station !== stopId ? stops.findIndex((stop) => stop.stopId === station) : -1;
    if (parent >= 0) return parent;
  }
  return stopName ? stops.findIndex((stop) => stop.name === stopName) : -1;
}
