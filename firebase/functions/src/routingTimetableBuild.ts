import { parse } from 'csv-parse';
import { createReadStream, existsSync } from 'fs';
import { join } from 'path';

import type { AgencyId } from './gtfsAgencies';
import { readCsv, readShapes, type AgencyStaticData, type ShapePoint, type StopTimeRow } from './gtfsFeed';
import { simplifyPath } from './gtfsGeometry';
import {
  encodeRoutingTimetable,
  NO_DROP_OFF,
  NO_PICKUP,
  type RoutingPattern,
  type RoutingRoute,
  type RoutingService,
  type RoutingTimetable,
} from './routingTimetable';

/**
 * Builds an agency's routing timetable (routingTimetable.ts) one route at a time, as
 * gtfsDerivedBuild.ts finishes each route's spilled stop times, so memory holds one route's rows
 * plus the compact output: a city bus feed has millions of stop times.
 */

/** One stop_times.txt row as the derived build spills it: pickup/drop-off rules in `flags`. */
export type RoutingStopTimeRow = [tripId: string, stopId: string, arrival: string, departure: string, sequence: number, flags: number];

/** A row's pickup/drop-off flags from stop_times.txt's pickup_type and drop_off_type (1: none). */
export function stopTimeFlags(pickupType: string | undefined, dropOffType: string | undefined): number {
  return (pickupType?.trim() === '1' ? NO_PICKUP : 0) | (dropOffType?.trim() === '1' ? NO_DROP_OFF : 0);
}

// Track geometry: simplified like route geometry, and a stop farther than this from its line's
// shape means the shape doesn't fit the pattern, so the pattern is drawn stop to stop instead.
const PATH_SIMPLIFY_METERS = 4;
const MAX_STOP_FROM_SHAPE_METERS = 400;

type RouteRow = { route_id: string; agency_id?: string; route_short_name?: string; route_long_name?: string; route_type?: string; route_color?: string; route_text_color?: string };
type AgencyRow = { agency_id?: string; agency_name?: string; agency_url?: string };
type StopRow = { stop_id: string; location_type?: string; parent_station?: string };
type TransferRow = { from_stop_id?: string; to_stop_id?: string; from_trip_id?: string; to_trip_id?: string; transfer_type?: string; min_transfer_time?: string };

/** "HH:MM:SS" (hours may pass 24) as seconds, or NaN when the feed leaves it blank. */
function timeSeconds(value: string): number {
  const text = value.trim();
  if (!text) return Number.NaN;
  const [hours, minutes, seconds] = text.split(':').map(Number);
  return (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
}

/** A growable typed list. */
class NumberList<T extends Int32Array | Uint32Array | Uint8Array> {
  private data: T;
  length = 0;
  constructor(private readonly Type: { new (length: number): T }) {
    this.data = new Type(1024);
  }
  push(value: number): void {
    if (this.length === this.data.length) {
      const next = new this.Type(this.data.length * 2);
      next.set(this.data as never);
      this.data = next;
    }
    this.data[this.length++] = value;
  }
  toArray(): T {
    return this.data.slice(0, this.length) as T;
  }
}

type BuiltTrip = { tripId: string; serviceId: string; headsign: string; shapeKey: string | null; arr: number[]; dep: number[] };

/** Fills times the feed leaves blank: arrival from departure and back, others spread evenly between known ones. */
function completeTimes(arr: number[], dep: number[]): boolean {
  const count = arr.length;
  for (let index = 0; index < count; index += 1) {
    if (Number.isNaN(arr[index]!)) arr[index] = dep[index]!;
    if (Number.isNaN(dep[index]!)) dep[index] = arr[index]!;
  }
  if (Number.isNaN(dep[0]!) || Number.isNaN(arr[count - 1]!)) return false;
  for (let index = 1; index < count; index += 1) {
    if (!Number.isNaN(arr[index]!)) continue;
    let next = index + 1;
    while (next < count && Number.isNaN(arr[next]!)) next += 1;
    const before = dep[index - 1]!;
    const after = arr[next]!;
    for (let fill = index; fill < next; fill += 1) {
      arr[fill] = dep[fill] = Math.round(before + ((after - before) * (fill - index + 1)) / (next - index + 1));
    }
  }
  // A time earlier than the stop before it (a feed typo) would let a trip run backward in time.
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && arr[index]! < dep[index - 1]!) arr[index] = dep[index - 1]!;
    if (dep[index]! < arr[index]!) dep[index] = arr[index]!;
  }
  return true;
}

/** Local meters around a reference latitude, for projecting stops onto a shape. */
function projector(lat0: number) {
  const metersPerLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return (point: { lat: number; lon: number }): [number, number] => [point.lon * metersPerLon, point.lat * 110_540];
}

/**
 * The pattern's line along its shape: each stop projected onto the shape in travel order, the
 * shape's points between, simplified one stop-to-stop piece at a time so every stop keeps its
 * exact place. Null when the shape doesn't fit (a stop far off it).
 */
export function pathAlongShape(stops: readonly { lat: number; lon: number }[], shape: readonly ShapePoint[]): { points: ShapePoint[]; stopIndex: number[] } | null {
  if (shape.length < 2 || stops.length < 2) return null;
  const toXY = projector(shape[0]!.lat);
  const xy = shape.map(toXY);
  const cumulative = [0];
  for (let index = 1; index < xy.length; index += 1) {
    cumulative.push(cumulative[index - 1]! + Math.hypot(xy[index]![0] - xy[index - 1]![0], xy[index]![1] - xy[index - 1]![1]));
  }
  type Projection = { segment: number; t: number; along: number; point: ShapePoint };
  const projections: Projection[] = [];
  let fromSegment = 0;
  let fromAlong = 0;
  for (let stopIndex = 0; stopIndex < stops.length; stopIndex += 1) {
    const stop = stops[stopIndex]!;
    const [sx, sy] = toXY(stop);
    // How far along the shape this stop can be: generous for the hop from the previous stop, so a
    // loop's far side (where the shape passes this stop again) isn't taken for it.
    const previous = stopIndex > 0 ? stops[stopIndex - 1]! : null;
    const hop = previous ? Math.hypot(sx - toXY(previous)[0], sy - toXY(previous)[1]) : Infinity;
    const window = previous ? hop * 4 + 1500 : Infinity;
    let best: (Projection & { cost: number; distance: number }) | null = null;
    for (let segment = fromSegment; segment < xy.length - 1; segment += 1) {
      if (cumulative[segment]! - fromAlong > window) break;
      const [ax, ay] = xy[segment]!;
      const [bx, by] = xy[segment + 1]!;
      const length2 = (bx - ax) ** 2 + (by - ay) ** 2;
      let t = length2 > 0 ? ((sx - ax) * (bx - ax) + (sy - ay) * (by - ay)) / length2 : 0;
      t = Math.min(1, Math.max(0, t));
      // Never behind the previous stop on the same segment.
      if (segment === fromSegment && projections.length > 0) t = Math.max(t, projections.at(-1)!.t);
      const px = ax + t * (bx - ax);
      const py = ay + t * (by - ay);
      const distance = Math.hypot(sx - px, sy - py);
      const along = cumulative[segment]! + t * Math.sqrt(length2);
      // Slightly prefer the nearer stretch along the shape, so a stop the line passes twice takes the first.
      const cost = distance + (along - fromAlong) * 0.002;
      if (!best || cost < best.cost) {
        const a = shape[segment]!;
        const b = shape[segment + 1]!;
        best = { segment, t, along, cost, distance, point: { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) } };
      }
    }
    if (!best || best.distance > MAX_STOP_FROM_SHAPE_METERS) return null;
    projections.push(best);
    fromSegment = best.segment;
    fromAlong = best.along;
  }

  const points: ShapePoint[] = [];
  const stopIndex: number[] = [];
  for (let index = 0; index < projections.length; index += 1) {
    const current = projections[index]!;
    if (index === 0) {
      stopIndex.push(0);
      points.push(current.point);
      continue;
    }
    const previous = projections[index - 1]!;
    const piece: ShapePoint[] = [previous.point];
    for (let vertex = previous.segment + 1; vertex <= current.segment; vertex += 1) piece.push(shape[vertex]!);
    piece.push(current.point);
    const simplified = simplifyPath(piece, PATH_SIMPLIFY_METERS);
    points.push(...simplified.slice(1));
    stopIndex.push(points.length - 1);
  }
  return { points, stopIndex };
}

export class RoutingTimetableBuilder {
  private readonly routeRows: RouteRow[];
  private readonly agencies: { id: string; name: string; url?: string }[];
  private readonly routes: RoutingRoute[] = [];
  private readonly routeIndex = new Map<string, number>();
  private readonly stopIndex = new Map<string, number>();
  private readonly stopIds: string[] = [];
  private readonly serviceIndex = new Map<string, number>();
  private readonly headsignIndex = new Map<string, number>();
  private readonly headsigns: string[] = [];
  private readonly tripIds: string[] = [];
  private readonly patterns: RoutingPattern[] = [];
  private readonly patternStops = new NumberList(Int32Array);
  private readonly patternFlags = new NumberList(Uint8Array);
  private readonly patternPathIndex = new NumberList(Uint32Array);
  private readonly pathLat = new NumberList(Int32Array);
  private readonly pathLon = new NumberList(Int32Array);
  private readonly tripStart = new NumberList(Int32Array);
  private readonly tripProfile = new NumberList(Uint32Array);
  private readonly tripService = new NumberList(Uint32Array);
  private readonly tripHeadsign = new NumberList(Int32Array);
  private readonly profileArr = new NumberList(Int32Array);
  private readonly profileDep = new NumberList(Int32Array);

  constructor(
    private readonly agencyId: AgencyId,
    private readonly dataDir: string,
    private readonly staticData: AgencyStaticData,
    private readonly shapes: () => ReadonlyMap<string, ShapePoint[]>,
  ) {
    this.routeRows = readCsv<RouteRow>(dataDir, 'routes.txt');
    this.agencies = readCsv<AgencyRow>(dataDir, 'agency.txt').map((row) => ({
      id: row.agency_id ?? '',
      name: (row.agency_name ?? '').replace(/\s+/g, ' ').trim(),
      ...(row.agency_url?.trim() ? { url: row.agency_url.trim() } : {}),
    }));
    if (this.agencies.length === 0) this.agencies.push({ id: '', name: agencyId });
  }

  private stop(stopId: string): number {
    let index = this.stopIndex.get(stopId);
    if (index === undefined) {
      index = this.stopIds.length;
      this.stopIndex.set(stopId, index);
      this.stopIds.push(stopId);
    }
    return index;
  }

  private headsign(text: string): number {
    let index = this.headsignIndex.get(text);
    if (index === undefined) {
      index = this.headsigns.length;
      this.headsignIndex.set(text, index);
      this.headsigns.push(text);
    }
    return index;
  }

  private service(serviceId: string): number {
    let index = this.serviceIndex.get(serviceId);
    if (index === undefined) {
      index = this.serviceIndex.size;
      this.serviceIndex.set(serviceId, index);
    }
    return index;
  }

  private route(routeId: string): number {
    let index = this.routeIndex.get(routeId);
    if (index !== undefined) return index;
    const row = this.routeRows.find((candidate) => candidate.route_id === routeId);
    const agency = Math.max(0, this.agencies.findIndex((candidate) => candidate.id === (row?.agency_id ?? '').trim()));
    const shortName = (row?.route_short_name ?? '').trim();
    index = this.routes.length;
    this.routes.push({
      id: routeId,
      shortName,
      longName: (row?.route_long_name ?? '').trim(),
      type: Number(row?.route_type ?? 3),
      color: (row?.route_color ?? '').trim().replace(/^#/, ''),
      textColor: (row?.route_text_color ?? '').trim().replace(/^#/, ''),
      agency,
    });
    this.routeIndex.set(routeId, index);
    return index;
  }

  /** The shape a trip follows: its shape_id, or (subway) the shape named by its trip_id's tail. */
  private shapeKeyFor(tripId: string, shapeId: string | null): string | null {
    const shapes = this.shapes();
    if (shapeId && shapes.has(shapeId)) return shapeId;
    const suffix = tripId.slice(tripId.lastIndexOf('_') + 1);
    return shapes.has(suffix) ? suffix : null;
  }

  /** Adds one route's trips (all its stop_times rows, any order). */
  addRoute(routeId: string, rows: readonly RoutingStopTimeRow[]): void {
    const byTrip = new Map<string, RoutingStopTimeRow[]>();
    for (const row of rows) {
      const list = byTrip.get(row[0]);
      if (list) list.push(row);
      else byTrip.set(row[0], [row]);
    }
    const groups = new Map<string, { direction: number; stops: string[]; flags: number[]; trips: BuiltTrip[] }>();
    for (const [tripId, tripRows] of byTrip) {
      const trip = this.staticData.tripsById.get(tripId);
      if (!trip) continue;
      tripRows.sort((a, b) => a[4] - b[4]);
      // A stop listed twice in a row (a timing point repeated) is one stop.
      const kept = tripRows.filter((row, index) => index === 0 || row[1] !== tripRows[index - 1]![1]);
      if (kept.length < 2) continue;
      const arr = kept.map((row) => timeSeconds(row[2]));
      const dep = kept.map((row) => timeSeconds(row[3]));
      if (!completeTimes(arr, dep)) continue;
      const stops = kept.map((row) => row[1]);
      const flags = kept.map((row) => row[5]);
      // Nobody boards at the last stop or gets off at the first.
      flags[0] = flags[0]! | NO_DROP_OFF;
      flags[flags.length - 1] = flags[flags.length - 1]! | NO_PICKUP;
      const direction = Number.isInteger(trip.directionId) ? trip.directionId : -1;
      const key = `${direction}|${stops.join(',')}|${flags.join('')}`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { direction, stops, flags, trips: [] }));
      const lastStop = this.staticData.stopsById.get(stops.at(-1)!);
      const lastName = (lastStop?.parentStation ? this.staticData.stopsById.get(lastStop.parentStation)?.name : undefined) ?? lastStop?.name ?? '';
      group.trips.push({ tripId, serviceId: trip.serviceId, headsign: trip.headsign || lastName, shapeKey: this.shapeKeyFor(tripId, trip.shapeId), arr, dep });
    }

    const route = this.route(routeId);
    for (const group of groups.values()) {
      // Overtaking-free runs: each trip joins the first run whose last trip it never passes.
      group.trips.sort((a, b) => a.dep[0]! - b.dep[0]! || a.arr.at(-1)! - b.arr.at(-1)!);
      const runs: BuiltTrip[][] = [];
      for (const trip of group.trips) {
        const run = runs.find((candidate) => {
          const last = candidate.at(-1)!;
          return trip.dep.every((time, index) => time >= last.dep[index]! && trip.arr[index]! >= last.arr[index]!);
        });
        if (run) run.push(trip);
        else runs.push([trip]);
      }
      for (const run of runs) this.addPattern(route, group.direction, group.stops, group.flags, run);
    }
  }

  private addPattern(route: number, direction: number, stopIds: readonly string[], flags: readonly number[], trips: readonly BuiltTrip[]): void {
    const stopIndexes = stopIds.map((stopId) => this.stop(stopId));
    // The headsign most of its trips show; trips showing another keep their own.
    const headsignCounts = new Map<string, number>();
    for (const trip of trips) headsignCounts.set(trip.headsign, (headsignCounts.get(trip.headsign) ?? 0) + 1);
    const patternHeadsign = [...headsignCounts].sort((a, b) => b[1] - a[1])[0]![0];

    const profiles = new Map<string, number>();
    for (const trip of trips) {
      const start = trip.dep[0]!;
      const arrOffsets = trip.arr.map((time) => time - start);
      const depOffsets = trip.dep.map((time) => time - start);
      const key = `${arrOffsets.join(',')}|${depOffsets.join(',')}`;
      let profile = profiles.get(key);
      if (profile === undefined) {
        profile = profiles.size;
        profiles.set(key, profile);
        for (const offset of arrOffsets) this.profileArr.push(offset);
        for (const offset of depOffsets) this.profileDep.push(offset);
      }
      this.tripIds.push(trip.tripId);
      this.tripStart.push(start);
      this.tripProfile.push(profile);
      this.tripService.push(this.service(trip.serviceId));
      this.tripHeadsign.push(trip.headsign === patternHeadsign ? -1 : this.headsign(trip.headsign));
    }

    // Drawn along the shape most of its trips follow, else straight from stop to stop.
    const shapeCounts = new Map<string, number>();
    for (const trip of trips) if (trip.shapeKey) shapeCounts.set(trip.shapeKey, (shapeCounts.get(trip.shapeKey) ?? 0) + 1);
    const shapeKey = [...shapeCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
    const stopPoints = stopIds.map((stopId) => {
      const stop = this.staticData.stopsById.get(stopId);
      return { lat: stop?.lat ?? 0, lon: stop?.lon ?? 0 };
    });
    const shape = shapeKey ? this.shapes().get(shapeKey) : undefined;
    const path = (shape ? pathAlongShape(stopPoints, shape) : null) ?? { points: stopPoints, stopIndex: stopPoints.map((_, index) => index) };
    for (const point of path.points) {
      this.pathLat.push(Math.round(point.lat * 1e6));
      this.pathLon.push(Math.round(point.lon * 1e6));
    }

    for (let index = 0; index < stopIndexes.length; index += 1) {
      this.patternStops.push(stopIndexes[index]!);
      this.patternFlags.push(flags[index]!);
      this.patternPathIndex.push(path.stopIndex[index]!);
    }
    this.patterns.push({
      route,
      direction,
      headsign: this.headsign(patternHeadsign),
      stopCount: stopIndexes.length,
      tripCount: trips.length,
      profileCount: profiles.size,
      pathPoints: path.points.length,
    });
  }

  /** The finished file. */
  finish(): Buffer {
    const { stopsById, calendarByService, calendarExceptionsByService } = this.staticData;
    // Stations of the stops in use, for their names and so their platforms are known to be one place.
    for (const stopId of [...this.stopIds]) {
      const parent = stopsById.get(stopId)?.parentStation;
      if (parent && stopsById.has(parent)) this.stop(parent);
    }

    const tripIndex = new Map(this.tripIds.map((tripId, index) => [tripId, index]));
    const childrenOf = new Map<string, string[]>();
    for (const row of readCsv<StopRow>(this.dataDir, 'stops.txt')) {
      const parent = row.parent_station?.trim();
      if (!parent) continue;
      const list = childrenOf.get(parent);
      if (list) list.push(row.stop_id);
      else childrenOf.set(parent, [row.stop_id]);
    }
    // A station in transfers.txt means each of its platforms in use.
    const platforms = (stopId: string) => [stopId, ...(childrenOf.get(stopId) ?? [])].filter((id) => this.stopIndex.has(id));
    const stopTransfers = new Map<string, [number, number, number]>();
    const tripTransfers: [number, number, number][] = [];
    for (const row of readCsv<TransferRow>(this.dataDir, 'transfers.txt')) {
      const from = row.from_stop_id?.trim();
      const to = row.to_stop_id?.trim();
      if (!from || !to) continue;
      const type = row.transfer_type?.trim() || '0';
      const fromTrip = row.from_trip_id?.trim();
      const toTrip = row.to_trip_id?.trim();
      if (fromTrip && toTrip) {
        const a = tripIndex.get(fromTrip);
        const b = tripIndex.get(toTrip);
        const stop = this.stopIndex.get(from);
        if (type === '1' && a !== undefined && b !== undefined && stop !== undefined) tripTransfers.push([a, b, stop]);
        continue;
      }
      const seconds = type === '3' ? -1 : type === '2' ? Number(row.min_transfer_time) : Number.NaN;
      if (!Number.isFinite(seconds)) continue;
      for (const fromStop of platforms(from)) {
        for (const toStop of platforms(to)) {
          const a = this.stopIndex.get(fromStop)!;
          const b = this.stopIndex.get(toStop)!;
          const key = `${a},${b}`;
          const known = stopTransfers.get(key);
          if (!known || (known[2] !== -1 && (seconds === -1 || seconds < known[2]))) stopTransfers.set(key, [a, b, seconds]);
        }
      }
    }

    const services: RoutingService[] = [];
    for (const [serviceId, index] of this.serviceIndex) {
      const calendar = calendarByService.get(serviceId);
      const exceptions = calendarExceptionsByService.get(serviceId) ?? new Map<string, '1' | '2'>();
      services[index] = {
        id: serviceId,
        days: calendar ? calendar.daysOfWeek.reduce((bits, runs, day) => (runs ? bits | (1 << day) : bits), 0) : 0,
        start: calendar ? Number(calendar.startDate) : 0,
        end: calendar ? Number(calendar.endDate) : 0,
        added: [...exceptions].filter(([, type]) => type === '1').map(([date]) => Number(date)).sort((a, b) => a - b),
        removed: [...exceptions].filter(([, type]) => type === '2').map(([date]) => Number(date)).sort((a, b) => a - b),
      };
    }

    const stopLat = new Int32Array(this.stopIds.length);
    const stopLon = new Int32Array(this.stopIds.length);
    const stopParent = new Int32Array(this.stopIds.length).fill(-1);
    const stopNames: string[] = [];
    this.stopIds.forEach((stopId, index) => {
      const stop = stopsById.get(stopId);
      stopLat[index] = Math.round((stop?.lat ?? 0) * 1e6);
      stopLon[index] = Math.round((stop?.lon ?? 0) * 1e6);
      const parent = stop?.parentStation ? this.stopIndex.get(stop.parentStation) : undefined;
      if (parent !== undefined) stopParent[index] = parent;
      stopNames.push(stop?.name ?? stopId);
    });

    const timetable: RoutingTimetable = {
      format: 1,
      agencyId: this.agencyId,
      agencies: this.agencies.map(({ name, url }) => ({ name, ...(url ? { url } : {}) })),
      stopIds: this.stopIds,
      stopNames,
      routes: this.routes,
      services,
      headsigns: this.headsigns,
      tripIds: this.tripIds,
      patterns: this.patterns,
      stopTransfers: [...stopTransfers.values()],
      tripTransfers,
      arrays: [],
      stopLat,
      stopLon,
      stopParent,
      patternStops: this.patternStops.toArray(),
      patternFlags: this.patternFlags.toArray(),
      patternPathIndex: this.patternPathIndex.toArray(),
      pathLat: this.pathLat.toArray(),
      pathLon: this.pathLon.toArray(),
      tripStart: this.tripStart.toArray(),
      tripProfile: this.tripProfile.toArray(),
      tripService: this.tripService.toArray(),
      tripHeadsign: this.tripHeadsign.toArray(),
      profileArr: this.profileArr.toArray(),
      profileDep: this.profileDep.toArray(),
    };
    return encodeRoutingTimetable(timetable);
  }
}

/**
 * A routing timetable straight from a feed's files, holding its stop times in memory grouped by
 * route: the fallback for an instance without prepared files, sized for the feeds bundled with a
 * deploy (not the city buses, which always come prepared).
 */
export async function buildRoutingTimetableFromFeed(agencyId: AgencyId, dataDir: string, staticData: AgencyStaticData): Promise<Buffer> {
  const byRoute = new Map<string, RoutingStopTimeRow[]>();
  const path = join(dataDir, 'stop_times.txt');
  if (existsSync(path)) {
    const parser = createReadStream(path).pipe(parse({ bom: true, columns: true }));
    for await (const row of parser as AsyncIterable<StopTimeRow & { pickup_type?: string; drop_off_type?: string }>) {
      const trip = staticData.tripsById.get(row.trip_id);
      if (!trip) continue;
      const entry: RoutingStopTimeRow = [row.trip_id, row.stop_id, row.arrival_time, row.departure_time, Number(row.stop_sequence), stopTimeFlags(row.pickup_type, row.drop_off_type)];
      const list = byRoute.get(trip.routeId);
      if (list) list.push(entry);
      else byRoute.set(trip.routeId, [entry]);
    }
  }
  let shapes: Map<string, ShapePoint[]> | undefined;
  const builder = new RoutingTimetableBuilder(agencyId, dataDir, staticData, () => (shapes ??= readShapes(dataDir)));
  for (const [routeId, rows] of byRoute) builder.addRoute(routeId, rows);
  return builder.finish();
}
