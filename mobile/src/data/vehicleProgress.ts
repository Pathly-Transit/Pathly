import { distanceMeters } from './routeDirection';

type LatLon = { lat: number; lon: number };
type ProgressStop = LatLon & { name: string; offsetMinutes?: number };

/** Where a live vehicle is along its line, as far as its position and the line's stops tell. */
export type VehicleProgress = {
  /** The stop it's standing at, when it's right by one. */
  atStop: string | null;
  /** The stop it's headed for next, when it's between stops. */
  nextStop: string | null;
  /** Stops until the rider's stop (1 when that's the next one, 0 when it's there); null when passed or unknown. */
  stopsAway: number | null;
  /** Scheduled minutes from here to the rider's stop; null when the stops have no times, or it's passed. */
  minutes: number | null;
};

const NOTHING: VehicleProgress = { atStop: null, nextStop: null, stopsAway: null, minutes: null };
/** Farther off the line than this, its position says nothing about which stop is next. */
const MAX_OFF_LINE_METERS = 400;

/** How far along `path` (meters) the point nearest `point` is, and how far off the line it sits. */
function alongPath(path: readonly LatLon[], point: LatLon): { along: number; off: number } {
  // Flat meters around the point: plenty for a few kilometers of line.
  const kx = 111_320 * Math.cos((point.lat * Math.PI) / 180);
  const ky = 111_320;
  let travelled = 0;
  let best = { along: 0, off: Number.POSITIVE_INFINITY };
  for (let index = 0; index < path.length - 1; index += 1) {
    const a = path[index]!;
    const b = path[index + 1]!;
    const ax = (a.lon - point.lon) * kx;
    const ay = (a.lat - point.lat) * ky;
    const dx = (b.lon - a.lon) * kx;
    const dy = (b.lat - a.lat) * ky;
    const length = Math.hypot(dx, dy);
    const t = length > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (length * length))) : 0;
    const off = Math.hypot(ax + dx * t, ay + dy * t);
    if (off < best.off) best = { along: travelled + length * t, off };
    travelled += length;
  }
  if (path.length === 1) best = { along: 0, off: distanceMeters(path[0]!, point) };
  return best;
}

/**
 * Where `vehicle` is on its line: the stop it's at or the next one ahead, how many stops it is
 * from the rider's stop (`focusIndex` in `stops`, which run in the vehicle's direction), and the
 * scheduled minutes left to get there. Anything its position can't tell is null.
 */
export function vehicleProgress(
  stops: readonly ProgressStop[],
  vehicle: LatLon,
  focusIndex: number,
  path?: readonly LatLon[],
  atStopMeters = 100,
): VehicleProgress {
  if (stops.length === 0) return NOTHING;
  const line = path && path.length > 1 ? path : stops;
  const here = alongPath(line, vehicle);
  if (here.off > MAX_OFF_LINE_METERS) return NOTHING;
  const stopAlong = stops.map((stop) => alongPath(line, stop).along);
  const focus = focusIndex >= 0 && focusIndex < stops.length ? focusIndex : -1;
  const minutesFrom = (offset: number | null) => {
    const target = focus >= 0 ? stops[focus]!.offsetMinutes : undefined;
    return offset == null || target == null ? null : Math.max(0, Math.round(target - offset));
  };

  const nearest = stops.reduce((best, stop, index) => (distanceMeters(stop, vehicle) < distanceMeters(stops[best]!, vehicle) ? index : best), 0);
  if (distanceMeters(stops[nearest]!, vehicle) <= atStopMeters) {
    const ahead = focus >= 0 && nearest <= focus;
    return {
      atStop: stops[nearest]!.name,
      nextStop: null,
      stopsAway: ahead ? focus - nearest : null,
      minutes: ahead ? minutesFrom(stops[nearest]!.offsetMinutes ?? null) : null,
    };
  }

  const next = stopAlong.findIndex((along) => along > here.along);
  if (next < 0) return NOTHING;
  const ahead = focus >= 0 && next <= focus;
  let offset: number | null = null;
  const nextOffset = stops[next]!.offsetMinutes;
  const previousOffset = next > 0 ? stops[next - 1]!.offsetMinutes : undefined;
  if (nextOffset != null && previousOffset != null) {
    const span = stopAlong[next]! - stopAlong[next - 1]!;
    const share = span > 0 ? Math.max(0, Math.min(1, (here.along - stopAlong[next - 1]!) / span)) : 1;
    offset = previousOffset + (nextOffset - previousOffset) * share;
  } else if (nextOffset != null) {
    offset = nextOffset;
  }
  return {
    atStop: null,
    nextStop: stops[next]!.name,
    stopsAway: ahead ? focus - next + 1 : null,
    minutes: ahead ? minutesFrom(offset) : null,
  };
}

/** "1 stop away", "3 stops away"; null when there's nothing to say (unknown, or it's there). */
export function stopsAwayLabel(stopsAway: number | null): string | null {
  if (stopsAway == null || stopsAway <= 0) return null;
  return `${stopsAway} ${stopsAway === 1 ? 'stop' : 'stops'} away`;
}

/**
 * The rider's-stop arrival to show for a vehicle: the live prediction nearest the schedule's guess
 * from its position, when one is close enough to be this vehicle, else that guess.
 */
export function vehicleArrival(
  estimate: number | null,
  predictions: readonly { minutes: number; live: boolean }[],
  positionLive: boolean,
): { minutes: number; live: boolean } | null {
  if (estimate == null) return null;
  const tolerance = Math.max(3, estimate * 0.35);
  const match = predictions
    .filter((prediction) => Math.abs(prediction.minutes - estimate) <= tolerance)
    .sort((a, b) => Math.abs(a.minutes - estimate) - Math.abs(b.minutes - estimate))[0];
  return match ? { minutes: match.minutes, live: match.live } : { minutes: estimate, live: positionLive };
}
