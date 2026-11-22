import type { AgencyId } from './gtfsAgencies';
import { haversineMeters } from './geo';
import { displayRouteColor } from './routeColors';
import { NO_DROP_OFF, NO_PICKUP, serviceRunsOn, type RoutingService, type RoutingTimetable } from './routingTimetable';
import { displayTransitName } from './transitNames';
import { LIRR_AGENCY, METRO_NORTH_AGENCY, MTA_BUS_COMPANY_AGENCY, NICE_AGENCY, NYC_FERRY_AGENCY, NYCT_AGENCY } from './tripAgencies';

/**
 * Every agency's routing timetable (routingTimetable.ts) merged into one network for the trip
 * planner (transitRouter.ts): flat arrays indexed by network-wide stop, pattern and trip numbers,
 * plus what the timetables leave to the planner — the walks between nearby stops, the time to
 * change vehicles at a stop, and a grid for finding the stops near a point.
 */

export type TransitMode = 'subway' | 'bus' | 'rail' | 'ferry' | 'other';

/** Walking pace for every planned walk: about 3 mph, as the app's other walking estimates. */
export const WALK_METERS_PER_SECOND = 1.3;
/**
 * Walks between stops are estimated from straight-line distance stretched by this much (streets
 * rarely run straight to the next stop); the planner checks the walks a trip really uses against
 * the street graph before offering it (tripPlanner.ts).
 */
export const TRANSFER_DETOUR = 1.3;
/** The farthest apart (straight line) two stops can be for a planned walk between them. */
export const MAX_TRANSFER_METERS = 450;
/** Time to spare after a walk to another stop, before the next vehicle leaves. */
export const WALK_TRANSFER_SLACK_SECONDS = 30;
/** Down to or up from a subway platform, on top of the walk at street level. */
export const STATION_ACCESS_SECONDS = 60;
/** Changing vehicles at the same stop, when the feed doesn't say how long it takes. */
const DEFAULT_CHANGE_SECONDS: Record<TransitMode, number> = { bus: 60, subway: 120, rail: 180, ferry: 120, other: 90 };

const GRID_DEGREES = 0.005;

/**
 * Each agency's name for a timetable that has none: the MTA's bus feeds, NYC Ferry's, the Staten
 * Island Ferry's and PATH's are built without agency.txt. Without these their rides would be named
 * by Pathly's id ("bk"), which the fares (tripFares.ts) and agency matching (tripAgencies.ts) don't
 * know, so every trip on them showed "Fare N/A". The names are the ones tripAgencies.ts expects.
 */
const FALLBACK_AGENCY_NAMES: Record<AgencyId, string> = {
  lirr: LIRR_AGENCY,
  metronorth: METRO_NORTH_AGENCY,
  subway: NYCT_AGENCY,
  nice: NICE_AGENCY,
  suffolk: 'Suffolk County Transit',
  bx: NYCT_AGENCY,
  bk: NYCT_AGENCY,
  mn: NYCT_AGENCY,
  qn: NYCT_AGENCY,
  si: NYCT_AGENCY,
  busco: MTA_BUS_COMPANY_AGENCY,
  nycferry: NYC_FERRY_AGENCY,
  siferry: 'New York City Department of Transportation',
  path: 'PATH',
};

export type NetworkRoute = {
  agencyId: AgencyId;
  routeId: string;
  shortName: string;
  longName: string;
  mode: TransitMode;
  /** Pathly's color for the line ("#RRGGBB", routeColors.ts) and its text color. */
  color: string;
  textColor?: string;
  vehicleName: string;
  agencyName: string;
  agencyUrl?: string;
};

type AgencyPart = {
  agencyId: AgencyId;
  version: string;
  timetable: RoutingTimetable;
  stopOffset: number;
  patternOffset: number;
  tripOffset: number;
  serviceOffset: number;
  routeOffset: number;
};

export function modeForRouteType(type: number): TransitMode {
  if (type === 0 || type === 1 || type === 5 || type === 7 || type === 12 || (type >= 900 && type < 1000) || (type >= 400 && type < 500)) return 'subway';
  if (type === 2 || (type >= 100 && type < 200)) return 'rail';
  if (type === 3 || type === 11 || (type >= 700 && type < 800)) return 'bus';
  if (type === 4 || (type >= 1000 && type < 1100) || type === 1200) return 'ferry';
  return 'other';
}

/** A route's mode: its GTFS route type's, except PATH, which its feed calls rail but rides as rapid transit, like the subway. */
export function modeForRoute(agencyId: AgencyId, type: number): TransitMode {
  return agencyId === 'path' ? 'subway' : modeForRouteType(type);
}

const VEHICLE_NAMES: Record<TransitMode, string> = { subway: 'Subway', rail: 'Train', bus: 'Bus', ferry: 'Ferry', other: 'Transit' };
const BUS_AGENCIES = new Set<AgencyId>(['bx', 'bk', 'mn', 'qn', 'si', 'busco', 'nice', 'suffolk']);

/** Calendar date parts for one service day around the plan. */
export type ServiceDay = { date: number; dayOfWeek: number; /** Seconds from the plan's base day's GTFS midnight to this day's. */ offset: number };

export class TransitNetwork {
  readonly parts: AgencyPart[];
  readonly versionKey: string;

  readonly stopCount: number;
  readonly stopLat: Float64Array;
  readonly stopLon: Float64Array;
  readonly stopPart: Uint8Array;
  readonly stopParent: Int32Array;
  /** Mode of the vehicles calling at each stop (the first pattern's), for station access and change times. */
  readonly stopMode: TransitMode[];
  readonly stopChangeSeconds: Int32Array;

  readonly patternCount: number;
  readonly patternRoute: Int32Array;
  readonly patternDirection: Int8Array;
  readonly patternHeadsign: string[];
  readonly patternStopStart: Uint32Array;
  readonly patternStops: Int32Array;
  readonly patternFlags: Uint8Array;
  readonly patternPathIndex: Uint32Array;
  readonly patternPathStart: Uint32Array;
  readonly pathLat: Int32Array;
  readonly pathLon: Int32Array;
  readonly patternTripStart: Uint32Array;

  readonly tripCount: number;
  readonly tripStart: Int32Array;
  /** Where the trip's profile begins in profileArr/profileDep. */
  readonly tripProfileOffset: Uint32Array;
  readonly tripService: Uint32Array;
  readonly tripPattern: Int32Array;
  readonly tripHeadsignText: (trip: number) => string;
  readonly profileArr: Int32Array;
  readonly profileDep: Int32Array;

  readonly routes: NetworkRoute[];
  readonly services: { part: number; service: RoutingService }[];

  /** Patterns calling at each stop, with the stop's position in the pattern. */
  readonly stopPatternStart: Uint32Array;
  readonly stopPatternPattern: Int32Array;
  readonly stopPatternPosition: Int32Array;

  /** Walks (and station changes) from each stop: target stop and seconds (-1: not allowed). */
  readonly transferStart: Uint32Array;
  readonly transferTo: Int32Array;
  readonly transferSeconds: Int32Array;
  /** Timed transfers held for a connection: from trip -> [to trip, stop]. */
  readonly timedTransfers: Map<number, [number, number][]>;

  private readonly grid = new Map<number, number[]>();

  constructor(timetables: readonly { agencyId: AgencyId; version: string; timetable: RoutingTimetable }[]) {
    this.versionKey = timetables.map((entry) => `${entry.agencyId}@${entry.version}`).join(',');
    let stops = 0;
    let patterns = 0;
    let trips = 0;
    let services = 0;
    let routes = 0;
    let stopEntries = 0;
    let pathPoints = 0;
    let profileInts = 0;
    this.parts = timetables.map(({ agencyId, version, timetable }) => {
      const part = { agencyId, version, timetable, stopOffset: stops, patternOffset: patterns, tripOffset: trips, serviceOffset: services, routeOffset: routes };
      stops += timetable.stopIds.length;
      patterns += timetable.patterns.length;
      trips += timetable.tripIds.length;
      services += timetable.services.length;
      routes += timetable.routes.length;
      stopEntries += timetable.patternStops.length;
      pathPoints += timetable.pathLat.length;
      profileInts += timetable.profileArr.length;
      return part;
    });

    this.stopCount = stops;
    this.stopLat = new Float64Array(stops);
    this.stopLon = new Float64Array(stops);
    this.stopPart = new Uint8Array(stops);
    this.stopParent = new Int32Array(stops).fill(-1);
    this.stopMode = new Array<TransitMode>(stops).fill('other');
    this.stopChangeSeconds = new Int32Array(stops).fill(-1);

    this.patternCount = patterns;
    this.patternRoute = new Int32Array(patterns);
    this.patternDirection = new Int8Array(patterns);
    this.patternHeadsign = new Array<string>(patterns);
    this.patternStopStart = new Uint32Array(patterns + 1);
    this.patternStops = new Int32Array(stopEntries);
    this.patternFlags = new Uint8Array(stopEntries);
    this.patternPathIndex = new Uint32Array(stopEntries);
    this.patternPathStart = new Uint32Array(patterns + 1);
    this.pathLat = new Int32Array(pathPoints);
    this.pathLon = new Int32Array(pathPoints);
    this.patternTripStart = new Uint32Array(patterns + 1);

    this.tripCount = trips;
    this.tripStart = new Int32Array(trips);
    this.tripProfileOffset = new Uint32Array(trips);
    this.tripService = new Uint32Array(trips);
    this.tripPattern = new Int32Array(trips);
    this.profileArr = new Int32Array(profileInts);
    this.profileDep = new Int32Array(profileInts);
    const tripHeadsign = new Int32Array(trips);

    this.routes = [];
    this.services = [];
    this.timedTransfers = new Map();

    let stopEntry = 0;
    let pathPoint = 0;
    let profileInt = 0;
    const stationTransfers: [number, number, number][] = [];
    this.parts.forEach((part, partIndex) => {
      const { timetable, stopOffset, patternOffset, tripOffset, serviceOffset, routeOffset, agencyId } = part;
      for (let stop = 0; stop < timetable.stopIds.length; stop += 1) {
        const global = stopOffset + stop;
        this.stopLat[global] = timetable.stopLat[stop]! / 1e6;
        this.stopLon[global] = timetable.stopLon[stop]! / 1e6;
        this.stopPart[global] = partIndex;
        const parent = timetable.stopParent[stop]!;
        if (parent >= 0) this.stopParent[global] = stopOffset + parent;
      }
      for (const route of timetable.routes) {
        const mode = modeForRoute(agencyId, route.type);
        const agency = timetable.agencies[route.agency] ?? timetable.agencies[0];
        const textColor = BUS_AGENCIES.has(agencyId) ? '#FFFFFF' : /^[0-9a-f]{6}$/i.test(route.textColor) ? `#${route.textColor.toUpperCase()}` : undefined;
        this.routes.push({
          agencyId,
          routeId: route.id,
          shortName: route.shortName,
          longName: route.longName,
          mode,
          color: displayRouteColor(agencyId, { routeId: route.id, shortName: route.shortName, name: route.longName, color: route.color }),
          ...(textColor ? { textColor } : {}),
          vehicleName: VEHICLE_NAMES[mode],
          // Feeds pad some names ("Suffolk County Transit  - Central").
          agencyName: (agency?.name && agency.name !== agencyId ? agency.name : FALLBACK_AGENCY_NAMES[agencyId]).replace(/\s+/g, ' ').trim(),
          ...(agency?.url ? { agencyUrl: agency.url } : {}),
        });
      }
      for (const service of timetable.services) this.services.push({ part: partIndex, service });

      let localStopEntry = 0;
      let localPathPoint = 0;
      let localTrip = 0;
      let localProfileInt = 0;
      timetable.patterns.forEach((pattern, localPattern) => {
        const global = patternOffset + localPattern;
        this.patternRoute[global] = routeOffset + pattern.route;
        this.patternDirection[global] = pattern.direction;
        this.patternHeadsign[global] = displayTransitName(timetable.headsigns[pattern.headsign] ?? '');
        this.patternStopStart[global] = stopEntry;
        this.patternPathStart[global] = pathPoint;
        this.patternTripStart[global] = tripOffset + localTrip;
        const mode = this.routes[routeOffset + pattern.route]!.mode;
        for (let index = 0; index < pattern.stopCount; index += 1) {
          const stop = stopOffset + timetable.patternStops[localStopEntry + index]!;
          this.patternStops[stopEntry + index] = stop;
          this.patternFlags[stopEntry + index] = timetable.patternFlags[localStopEntry + index]!;
          this.patternPathIndex[stopEntry + index] = timetable.patternPathIndex[localStopEntry + index]!;
          if (this.stopMode[stop] === 'other') this.stopMode[stop] = mode;
        }
        this.pathLat.set(timetable.pathLat.subarray(localPathPoint, localPathPoint + pattern.pathPoints), pathPoint);
        this.pathLon.set(timetable.pathLon.subarray(localPathPoint, localPathPoint + pattern.pathPoints), pathPoint);
        const profileSize = pattern.profileCount * pattern.stopCount;
        this.profileArr.set(timetable.profileArr.subarray(localProfileInt, localProfileInt + profileSize), profileInt);
        this.profileDep.set(timetable.profileDep.subarray(localProfileInt, localProfileInt + profileSize), profileInt);
        for (let trip = 0; trip < pattern.tripCount; trip += 1) {
          const globalTrip = tripOffset + localTrip + trip;
          this.tripStart[globalTrip] = timetable.tripStart[localTrip + trip]!;
          this.tripProfileOffset[globalTrip] = profileInt + timetable.tripProfile[localTrip + trip]! * pattern.stopCount;
          this.tripService[globalTrip] = serviceOffset + timetable.tripService[localTrip + trip]!;
          this.tripPattern[globalTrip] = global;
          tripHeadsign[globalTrip] = timetable.tripHeadsign[localTrip + trip]!;
        }
        stopEntry += pattern.stopCount;
        localStopEntry += pattern.stopCount;
        pathPoint += pattern.pathPoints;
        localPathPoint += pattern.pathPoints;
        localTrip += pattern.tripCount;
        profileInt += profileSize;
        localProfileInt += profileSize;
      });
      for (const [from, to, seconds] of timetable.stopTransfers) stationTransfers.push([stopOffset + from, stopOffset + to, seconds]);
      for (const [fromTrip, toTrip, stop] of timetable.tripTransfers) {
        const key = tripOffset + fromTrip;
        const list = this.timedTransfers.get(key);
        const entry: [number, number] = [tripOffset + toTrip, stopOffset + stop];
        if (list) list.push(entry);
        else this.timedTransfers.set(key, [entry]);
      }
    });
    this.patternStopStart[patterns] = stopEntry;
    this.patternPathStart[patterns] = pathPoint;
    this.patternTripStart[patterns] = trips;
    this.tripHeadsignText = (trip: number) => {
      const own = tripHeadsign[trip]!;
      if (own < 0) return this.patternHeadsign[this.tripPattern[trip]!]!;
      const part = this.parts[this.stopPart[this.patternStops[this.patternStopStart[this.tripPattern[trip]!]!]!]!]!;
      return displayTransitName(part.timetable.headsigns[own] ?? '');
    };

    // Patterns at each stop.
    const counts = new Uint32Array(stops + 1);
    for (let entry = 0; entry < stopEntry; entry += 1) counts[this.patternStops[entry]! + 1]! += 1;
    for (let stop = 0; stop < stops; stop += 1) counts[stop + 1]! += counts[stop]!;
    this.stopPatternStart = counts.slice();
    this.stopPatternPattern = new Int32Array(stopEntry);
    this.stopPatternPosition = new Int32Array(stopEntry);
    const fill = counts.slice(0, stops);
    for (let pattern = 0; pattern < patterns; pattern += 1) {
      for (let entry = this.patternStopStart[pattern]!; entry < this.patternStopStart[pattern + 1]!; entry += 1) {
        const stop = this.patternStops[entry]!;
        const slot = fill[stop]!;
        fill[stop] = slot + 1;
        this.stopPatternPattern[slot] = pattern;
        this.stopPatternPosition[slot] = entry - this.patternStopStart[pattern]!;
      }
    }

    // The grid, of stops vehicles call at.
    for (let stop = 0; stop < stops; stop += 1) {
      if (this.stopPatternStart[stop + 1] === this.stopPatternStart[stop]) continue;
      const key = this.cellKey(Math.floor(this.stopLat[stop]! / GRID_DEGREES), Math.floor(this.stopLon[stop]! / GRID_DEGREES));
      const cell = this.grid.get(key);
      if (cell) cell.push(stop);
      else this.grid.set(key, [stop]);
    }

    // Change times at a stop: the feed's own (transfers.txt from a stop to itself), else the mode's default.
    for (const [from, to, seconds] of stationTransfers) {
      if (from === to && seconds >= 0) this.stopChangeSeconds[from] = Math.max(this.stopChangeSeconds[from]!, seconds);
    }
    for (let stop = 0; stop < stops; stop += 1) {
      if (this.stopChangeSeconds[stop]! < 0) this.stopChangeSeconds[stop] = DEFAULT_CHANGE_SECONDS[this.stopMode[stop]!];
    }

    // Walks between stops: the feed's station transfers, and any stop within MAX_TRANSFER_METERS.
    const lists: Map<number, number>[] = Array.from({ length: stops }, () => new Map<number, number>());
    for (const [from, to, seconds] of stationTransfers) {
      if (from === to) continue;
      lists[from]!.set(to, seconds);
    }
    for (let stop = 0; stop < stops; stop += 1) {
      if (this.stopPatternStart[stop + 1] === this.stopPatternStart[stop]) continue;
      const own = lists[stop]!;
      for (const other of this.stopsNear(this.stopLat[stop]!, this.stopLon[stop]!, MAX_TRANSFER_METERS)) {
        if (other.stop === stop || own.has(other.stop)) continue;
        own.set(other.stop, this.estimatedWalkSeconds(stop, other.stop, other.meters));
      }
    }
    const transferCounts = new Uint32Array(stops + 1);
    for (let stop = 0; stop < stops; stop += 1) transferCounts[stop + 1] = transferCounts[stop]! + lists[stop]!.size;
    this.transferStart = transferCounts;
    this.transferTo = new Int32Array(transferCounts[stops]!);
    this.transferSeconds = new Int32Array(transferCounts[stops]!);
    for (let stop = 0; stop < stops; stop += 1) {
      let slot = transferCounts[stop]!;
      for (const [to, seconds] of lists[stop]!) {
        this.transferTo[slot] = to;
        this.transferSeconds[slot] = seconds;
        slot += 1;
      }
    }
  }

  private cellKey(row: number, column: number): number {
    return row * 100_000 + column;
  }

  /** Stops vehicles call at within `meters` (straight line) of a point, nearest first. */
  stopsNear(lat: number, lon: number, meters: number): { stop: number; meters: number }[] {
    const rows = Math.ceil(meters / 110_540 / GRID_DEGREES);
    const columns = Math.ceil(meters / (111_320 * Math.cos((lat * Math.PI) / 180)) / GRID_DEGREES);
    const row0 = Math.floor(lat / GRID_DEGREES);
    const column0 = Math.floor(lon / GRID_DEGREES);
    const found: { stop: number; meters: number }[] = [];
    for (let row = row0 - rows; row <= row0 + rows; row += 1) {
      for (let column = column0 - columns; column <= column0 + columns; column += 1) {
        for (const stop of this.grid.get(this.cellKey(row, column)) ?? []) {
          const distance = haversineMeters(lat, lon, this.stopLat[stop]!, this.stopLon[stop]!);
          if (distance <= meters) found.push({ stop, meters: distance });
        }
      }
    }
    return found.sort((a, b) => a.meters - b.meters);
  }

  /** Walking time between two stops estimated from their straight-line distance. */
  estimatedWalkSeconds(from: number, to: number, straightMeters: number): number {
    return Math.round((straightMeters * TRANSFER_DETOUR) / WALK_METERS_PER_SECOND) + WALK_TRANSFER_SLACK_SECONDS + this.stationAccessSeconds(from, to);
  }

  /** Stairs to and from subway platforms when a walk leaves or enters a station (not between two platforms of one). */
  stationAccessSeconds(from: number, to: number): number {
    const fromSubway = this.stopMode[from] === 'subway';
    const toSubway = this.stopMode[to] === 'subway';
    if (fromSubway && toSubway) return 0;
    return (fromSubway ? STATION_ACCESS_SECONDS : 0) + (toSubway ? STATION_ACCESS_SECONDS : 0);
  }

  /** Replaces a walk's estimate (both ways) once the street graph has measured it; -1 forbids it. */
  correctTransfer(from: number, to: number, seconds: number): void {
    for (const [a, b] of [[from, to], [to, from]] as const) {
      for (let slot = this.transferStart[a]!; slot < this.transferStart[a + 1]!; slot += 1) {
        if (this.transferTo[slot] === b) this.transferSeconds[slot] = seconds;
      }
    }
  }

  /** The stop's name as riders know it: its station's, for a platform. */
  stopName(stop: number): string {
    const parent = this.stopParent[stop]!;
    const named = parent >= 0 ? parent : stop;
    const part = this.parts[this.stopPart[named]!]!;
    return part.timetable.stopNames[named - part.stopOffset] ?? '';
  }

  /** The stop's id in its own feed. */
  stopId(stop: number): string {
    const part = this.parts[this.stopPart[stop]!]!;
    return part.timetable.stopIds[stop - part.stopOffset]!;
  }

  agencyOfStop(stop: number): AgencyId {
    return this.parts[this.stopPart[stop]!]!.agencyId;
  }

  tripId(trip: number): string {
    const part = this.parts[this.stopPart[this.patternStops[this.patternStopStart[this.tripPattern[trip]!]!]!]!]!;
    return part.timetable.tripIds[trip - part.tripOffset]!;
  }

  patternStopCount(pattern: number): number {
    return this.patternStopStart[pattern + 1]! - this.patternStopStart[pattern]!;
  }

  /** Scheduled arrival and departure (seconds after the trip's service day's GTFS midnight). */
  arrival(trip: number, position: number): number {
    return this.tripStart[trip]! + this.profileArr[this.tripProfileOffset[trip]! + position]!;
  }

  departure(trip: number, position: number): number {
    return this.tripStart[trip]! + this.profileDep[this.tripProfileOffset[trip]! + position]!;
  }

  canBoard(pattern: number, position: number): boolean {
    return (this.patternFlags[this.patternStopStart[pattern]! + position]! & NO_PICKUP) === 0;
  }

  canAlight(pattern: number, position: number): boolean {
    return (this.patternFlags[this.patternStopStart[pattern]! + position]! & NO_DROP_OFF) === 0;
  }

  /** Which services run on each of the given days. */
  activeServices(days: readonly ServiceDay[]): Uint8Array[] {
    return days.map((day) => {
      const active = new Uint8Array(this.services.length);
      this.services.forEach(({ service }, index) => {
        if (serviceRunsOn(service, day.date, day.dayOfWeek)) active[index] = 1;
      });
      return active;
    });
  }

  /** The line drawn between two positions of a pattern, as [lat, lng] pairs. */
  pathBetween(pattern: number, from: number, to: number): { lat: number; lng: number }[] {
    const base = this.patternStopStart[pattern]!;
    const pathBase = this.patternPathStart[pattern]!;
    const start = pathBase + this.patternPathIndex[base + from]!;
    const end = pathBase + this.patternPathIndex[base + to]!;
    const points: { lat: number; lng: number }[] = [];
    for (let index = start; index <= end; index += 1) points.push({ lat: this.pathLat[index]! / 1e6, lng: this.pathLon[index]! / 1e6 });
    return points;
  }
}
