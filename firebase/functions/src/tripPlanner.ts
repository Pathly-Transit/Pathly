import { createHash } from 'crypto';
import { logger } from 'firebase-functions';

import { haversineMeters } from './geo';
import { AGENCY_CONFIGS, type AgencyId } from './gtfsAgencies';
import { agencySnapshotVersion, isAgencyAvailable, prepareAgencyStaticData, readRoutingTimetableFile } from './gtfsStaticData';
import { decodeRoutingTimetable } from './routingTimetable';
import {
  STATION_ACCESS_SECONDS,
  TRANSFER_DETOUR,
  TransitNetwork,
  WALK_METERS_PER_SECOND,
  WALK_TRANSFER_SLACK_SECONDS,
  type ServiceDay,
  type TransitMode,
} from './transitNetwork';
import { TransitRouter, type Journey, type RideLeg, type SearchOptions, type StopTime, type WalkLeg } from './transitRouter';
import {
  itineraryFare,
  simplifiedPath,
  type FareEstimator,
  type Itinerary,
  type LatLng,
  type PlanTripRequest,
  type TransitStep,
  type TripDeparture,
  type TripStep,
  type TripStop,
  type WalkStep,
} from './tripPlanning';
import { legEntrances } from './stationEntrances';
import { liveTripRefs, type LiveTripRef } from './tripLive';
import { hasWalkingData, walkingMeters, walkingPath } from './walkingGraph';

/**
 * Pathly's own transit trip planner: itineraries between two points from the agencies' published
 * timetables (transitRouter.ts over transitNetwork.ts) and walks along OpenStreetMap's streets
 * (walkingGraph.ts), in the same itinerary format the app has always read. No outside service is
 * asked anything, so planning costs nothing per request.
 */

/** Up to five changes; trips needing more are never what a rider wants. */
const MAX_ROUNDS = 6;
/**
 * How far ahead (or back, arriving by a time) a trip may end, from the requested time: long
 * enough for the next train on a line that runs a few times a day (the LIRR to Montauk).
 */
const HORIZON_SECONDS = 18 * 3600;
/** Walking to the first stop or from the last: first this far, then farther where few lines are near. */
const ACCESS_METERS = [1300, 2600] as const;
const LESS_WALKING_ACCESS_METERS = [700, 1300] as const;
/** Fewer different lines than this within the first radius means looking farther (the suburbs). */
const MIN_NEARBY_LINES = 4;
const MAX_ACCESS_STOPS = 450;
/** Itineraries offered at most, and how much later than the fastest one may arrive. */
const MAX_ITINERARIES = 6;
const MIN_SLACK_SECONDS = 20 * 60;
const SLACK_SHARE = 0.5;
/** Each extra ride must save at least this much over a trip with fewer, or it isn't offered. */
const SECONDS_PER_EXTRA_RIDE = 5 * 60;
/** ...unless it saves this much walking. */
const WALK_SAVED_FOR_EXTRA_RIDE_SECONDS = 5 * 60;
/**
 * Alternatives: searches leaving out the best trip's main line, then that and the next best's,
 * and so on (other lines between the same places), and ones leaving out each of the fastest
 * trip's other lines in turn.
 */
const CUMULATIVE_BAN_SEARCHES = 3;
const SINGLE_BAN_SEARCHES = 2;
/** Measured walks this much longer than estimated make the planner try again without the estimate. */
const WALK_CHECK_TOLERANCE_SECONDS = 45;
const MAX_WALK_CHECK_PASSES = 3;
/** Departures offered for a ride: a little before it to a few hours after. */
const OPTIONS_BEFORE_SECONDS = 20 * 60;
const OPTIONS_AFTER_SECONDS = 3 * 3600;
const MAX_OPTIONS = 12;
const DEPARTURE_MATCH_SECONDS = 120;
/** Under this distance a walk between two stops isn't a step of its own (a change of platforms). */
const MIN_WALK_STEP_METERS = 30;

// ---------------------------------------------------------------------------------------------
// The network, built once per instance and again when any agency's timetable changes.

type LoadedNetwork = { key: string; network: TransitNetwork; router: TransitRouter; walks: Map<string, { meters: number; path: LatLng[] } | null> };
let loaded: LoadedNetwork | null = null;
let loading: Promise<LoadedNetwork | null> | null = null;

/** Unit-test dependency injection only: plan over these timetables instead of the agencies'. */
let networkOverride: TransitNetwork | null = null;
export function setTransitNetworkForTests(network: TransitNetwork | null): void {
  networkOverride = network;
  loaded = null;
}

async function buildNetwork(): Promise<LoadedNetwork | null> {
  const agencyIds = Object.keys(AGENCY_CONFIGS) as AgencyId[];
  await Promise.all(agencyIds.map((agencyId) => prepareAgencyStaticData(agencyId).catch(() => undefined)));
  const available = agencyIds.filter(isAgencyAvailable);
  const key = available.map((agencyId) => `${agencyId}@${agencySnapshotVersion(agencyId) ?? 'bundled'}`).join(',');
  if (loaded?.key === key) return loaded;
  const started = Date.now();
  const timetables = await Promise.all(available.map(async (agencyId) => {
    try {
      const file = await readRoutingTimetableFile(agencyId);
      return file ? { agencyId, version: agencySnapshotVersion(agencyId) ?? 'bundled', timetable: decodeRoutingTimetable(file) } : null;
    } catch (error) {
      logger.warn('Could not read an agency routing timetable', {
        agencyId,
        event: 'trip_planner_timetable_failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }));
  const usable = timetables.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (usable.length === 0) return null;
  const network = new TransitNetwork(usable);
  logger.info('Built the trip planning network', {
    event: 'trip_planner_network_built',
    agencies: usable.map((entry) => entry.agencyId),
    stops: network.stopCount,
    patterns: network.patternCount,
    trips: network.tripCount,
    ms: Date.now() - started,
  });
  return { key, network, router: new TransitRouter(network, MAX_ROUNDS), walks: new Map() };
}

async function currentNetwork(): Promise<LoadedNetwork | null> {
  if (networkOverride) {
    if (loaded?.network !== networkOverride) loaded = { key: 'test', network: networkOverride, router: new TransitRouter(networkOverride, MAX_ROUNDS), walks: new Map() };
    return loaded;
  }
  loading ??= buildNetwork().finally(() => {
    loading = null;
  });
  const result = await loading;
  if (result) loaded = result;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Service days: the planner's clock is seconds after the base day's GTFS midnight in New York.

const TIME_ZONE = 'America/New_York';
const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function serviceDayContaining(ms: number): { date: number; dayOfWeek: number; startMs: number; noonMs: number } {
  const parts = Object.fromEntries(nyParts.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const seconds = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  // GTFS midnight is noon minus 12 hours, which keeps times right on daylight-saving days.
  const noonMs = ms + (12 * 3600 - seconds) * 1000;
  return { date: Number(`${parts.year}${parts.month}${parts.day}`), dayOfWeek: WEEKDAYS.indexOf(parts.weekday ?? ''), startMs: noonMs - 12 * 3600 * 1000, noonMs };
}

/** Yesterday (its trips running past midnight), the day of `ms`, and tomorrow, around `ms`'s day. */
export function serviceDaysAround(ms: number): { baseStartMs: number; days: ServiceDay[] } {
  const today = serviceDayContaining(ms);
  const yesterday = serviceDayContaining(today.noonMs - 24 * 3600 * 1000);
  const tomorrow = serviceDayContaining(today.noonMs + 24 * 3600 * 1000);
  const day = (entry: typeof today): ServiceDay => ({ date: entry.date, dayOfWeek: entry.dayOfWeek, offset: Math.round((entry.startMs - today.startMs) / 1000) });
  return { baseStartMs: today.startMs, days: [day(yesterday), day(today), day(tomorrow)] };
}

// ---------------------------------------------------------------------------------------------
// Planning

type PlanContext = {
  network: TransitNetwork;
  router: TransitRouter;
  walks: LoadedNetwork['walks'];
  days: ServiceDay[];
  active: Uint8Array[];
  baseStartMs: number;
  origin: LatLng;
  destination: LatLng;
  modes: Set<TransitMode>;
  access: (StopTime & { meters: number })[];
  egress: (StopTime & { meters: number })[];
  arriveBy: boolean;
  /** Seconds after the base day's midnight: leaving at, or arriving by. */
  time: number;
};

const walkSecondsFor = (network: TransitNetwork, stop: number, meters: number) => (
  Math.round(meters / WALK_METERS_PER_SECOND) + (network.stopMode[stop] === 'subway' ? STATION_ACCESS_SECONDS : 0)
);

/** The stops a rider can walk to from a point within `maxMeters` along the streets, and how long each walk takes. */
function stopsWithinWalk(network: TransitNetwork, point: LatLng, maxMeters: number): (StopTime & { meters: number })[] {
  const candidates = network.stopsNear(point.lat, point.lng, maxMeters).slice(0, MAX_ACCESS_STOPS);
  const graph = hasWalkingData();
  const found: (StopTime & { meters: number })[] = [];
  for (const { stop, meters: straight } of candidates) {
    const meters = graph ? walkingMeters(point.lat, point.lng, network.stopLat[stop]!, network.stopLon[stop]!, maxMeters) : straight * TRANSFER_DETOUR;
    if (meters === null || meters > maxMeters) continue;
    found.push({ stop, seconds: walkSecondsFor(network, stop, meters), meters });
  }
  // A point the street graph can't reach (off its edge) still walks to the stops beside it.
  if (graph && found.length === 0) {
    for (const { stop, meters: straight } of candidates) {
      const meters = straight * TRANSFER_DETOUR;
      if (meters <= maxMeters) found.push({ stop, seconds: walkSecondsFor(network, stop, meters), meters });
    }
  }
  return found;
}

function linesAt(network: TransitNetwork, stops: readonly StopTime[]): number {
  const routes = new Set<number>();
  for (const { stop } of stops) {
    for (let slot = network.stopPatternStart[stop]!; slot < network.stopPatternStart[stop + 1]!; slot += 1) {
      routes.add(network.patternRoute[network.stopPatternPattern[slot]!]!);
    }
  }
  return routes.size;
}

function walkableStops(network: TransitNetwork, point: LatLng, lessWalking: boolean): (StopTime & { meters: number })[] {
  const [near, far] = lessWalking ? LESS_WALKING_ACCESS_METERS : ACCESS_METERS;
  const nearby = stopsWithinWalk(network, point, near);
  return linesAt(network, nearby) >= MIN_NEARBY_LINES ? nearby : stopsWithinWalk(network, point, far);
}

function search(context: PlanContext, time: number, extra: Partial<SearchOptions> = {}): Journey[] {
  const options: SearchOptions = { days: context.days, maxRounds: MAX_ROUNDS, modes: context.modes, horizonSeconds: HORIZON_SECONDS, ...extra };
  const journeys = context.arriveBy
    ? context.router.backward(time, context.access, context.egress, options, context.active)
    : context.router.forward(time, context.access, context.egress, options, context.active);
  return journeys.map((journey) => boardWhereClosest(context, journey));
}

const rides = (journey: Journey) => journey.legs.filter((leg): leg is RideLeg => leg.kind === 'ride');

function bestOf(journeys: readonly Journey[], arriveBy: boolean): Journey | undefined {
  if (journeys.length === 0) return undefined;
  return arriveBy
    ? journeys.reduce((a, b) => (b.departs > a.departs || (b.departs === a.departs && b.rides < a.rides) ? b : a))
    : journeys.reduce((a, b) => (b.arrives < a.arrives || (b.arrives === a.arrives && b.rides < a.rides) ? b : a));
}

/** The line a journey spends longest on. */
function mainRoute(network: TransitNetwork, journey: Journey): number {
  const longest = rides(journey).reduce((a, b) => (b.arrives - b.departs > a.arrives - a.departs ? b : a));
  return network.patternRoute[longest.pattern]!;
}

/**
 * The fastest search; the next departure after it (or, arriving by a time, the one before); the
 * other lines between the same places (leaving out the best trip's main line, then the next
 * best's too, and so on); and trips around each of the fastest trip's other lines.
 */
function runSearches(context: PlanContext): Journey[] {
  const { network, arriveBy } = context;
  const found = search(context, context.time);
  const best = bestOf(found, arriveBy);
  if (!best) return found;
  const all = [...found];
  all.push(...search(context, arriveBy ? best.arrives - 60 : best.departs + 60));

  const banned = new Set<number>();
  let latest: Journey | undefined = best;
  for (let index = 0; index < CUMULATIVE_BAN_SEARCHES && latest; index += 1) {
    banned.add(mainRoute(network, latest));
    const alternatives = search(context, context.time, { bannedRoutes: new Set(banned) });
    all.push(...alternatives);
    latest = bestOf(alternatives, arriveBy);
  }

  let singles = 0;
  for (const ride of rides(best)) {
    const route = network.patternRoute[ride.pattern]!;
    if (banned.has(route) || singles >= SINGLE_BAN_SEARCHES) continue;
    singles += 1;
    all.push(...search(context, context.time, { bannedRoutes: new Set([route]) }));
  }
  return all;
}

/**
 * Boards the first vehicle where the rider can leave latest for it. The search boards a trip at
 * the first stop on its way that the rider can reach in time, which can be a long walk upstream
 * of a stop the same vehicle calls at a minute later, a short walk away.
 */
function boardWhereClosest(context: PlanContext, journey: Journey): Journey {
  const { network } = context;
  const first = journey.legs.findIndex((leg) => leg.kind === 'ride');
  const ride = journey.legs[first] as RideLeg;
  const walk = journey.legs[first - 1];
  if (!walk || walk.kind !== 'walk' || walk.from !== null) return journey;
  const accessSeconds = new Map<number, number>();
  for (const { stop, seconds } of context.access) accessSeconds.set(stop, Math.min(seconds, accessSeconds.get(stop) ?? Infinity));
  const offset = context.days[ride.day]!.offset;
  const base = network.patternStopStart[ride.pattern]!;
  let best = { position: ride.boardPosition, leaves: ride.departs - walk.seconds, walk: walk.seconds };
  for (let position = ride.boardPosition + 1; position < ride.alightPosition; position += 1) {
    const stop = network.patternStops[base + position]!;
    const seconds = accessSeconds.get(stop);
    if (seconds === undefined || !network.canBoard(ride.pattern, position)) continue;
    const leaves = network.departure(ride.trip, position) + offset - seconds;
    if (!context.arriveBy && leaves < context.time) continue;
    if (leaves > best.leaves || (leaves === best.leaves && seconds < best.walk)) best = { position, leaves, walk: seconds };
  }
  if (best.position === ride.boardPosition) return journey;
  const stop = network.patternStops[base + best.position]!;
  const legs = [...journey.legs];
  legs[first] = { ...ride, boardPosition: best.position, boardStop: stop, departs: network.departure(ride.trip, best.position) + offset };
  legs[first - 1] = { ...walk, to: stop, seconds: best.walk };
  return { ...journey, legs, departs: best.leaves };
}

const walkKey = (from: number, to: number) => `${from}>${to}`;

/**
 * Checks each walk between stops the journeys use against the street graph, correcting the
 * network's estimate where the real walk is longer (or impossible). True when anything changed,
 * so the searches are run again.
 */
function checkWalks(context: PlanContext, journeys: readonly Journey[]): boolean {
  const { network, walks } = context;
  if (!hasWalkingData()) return false;
  let changed = false;
  for (const journey of journeys) {
    for (const leg of journey.legs) {
      if (leg.kind !== 'walk' || leg.from === null || leg.to === null) continue;
      const key = walkKey(leg.from, leg.to);
      if (walks.has(key)) continue;
      // Platforms of one station (and the feed's own station transfers) are trusted as published.
      if (network.stopParent[leg.from]! >= 0 && network.stopParent[leg.from] === network.stopParent[leg.to]) {
        walks.set(key, null);
        continue;
      }
      const from = { lat: network.stopLat[leg.from]!, lng: network.stopLon[leg.from]! };
      const to = { lat: network.stopLat[leg.to]!, lng: network.stopLon[leg.to]! };
      const straight = haversineMeters(from.lat, from.lng, to.lat, to.lng);
      const walk = walkingPath(from.lat, from.lng, to.lat, to.lng, Math.max(1500, straight * 4));
      const reverseKey = walkKey(leg.to, leg.from);
      if (!walk) {
        network.correctTransfer(leg.from, leg.to, -1);
        walks.set(key, null);
        walks.set(reverseKey, null);
        changed = true;
        continue;
      }
      const path = walk.path.map((point) => ({ lat: point.lat, lng: point.lon }));
      walks.set(key, { meters: walk.meters, path });
      walks.set(reverseKey, { meters: walk.meters, path: [...path].reverse() });
      const seconds = Math.round(walk.meters / WALK_METERS_PER_SECOND) + WALK_TRANSFER_SLACK_SECONDS + network.stationAccessSeconds(leg.from, leg.to);
      if (seconds > leg.seconds + WALK_CHECK_TOLERANCE_SECONDS) {
        network.correctTransfer(leg.from, leg.to, seconds);
        changed = true;
      }
    }
  }
  return changed;
}

const walkingSecondsOf = (journey: Journey) => journey.legs.reduce((sum, leg) => sum + (leg.kind === 'walk' ? leg.seconds : 0), 0);
const journeyKey = (journey: Journey) => rides(journey).map((ride) => `${ride.trip}:${ride.day}:${ride.boardStop}:${ride.alightStop}`).join('>');

/** Distinct journeys worth offering: none clearly worse than another, none far slower than the best, in arrival order. */
export function chooseJourneys(journeys: readonly Journey[], arriveBy: boolean, time: number): Journey[] {
  const unique = new Map<string, Journey>();
  for (const journey of journeys) {
    const key = journeyKey(journey);
    const known = unique.get(key);
    if (!known || walkingSecondsOf(journey) < walkingSecondsOf(known)) unique.set(key, journey);
  }
  const list = [...unique.values()];
  if (list.length === 0) return [];
  const dominated = (a: Journey, b: Journey) => (
    b.arrives <= a.arrives && b.departs >= a.departs && b.rides <= a.rides && walkingSecondsOf(b) <= walkingSecondsOf(a)
    && (b.arrives < a.arrives || b.departs > a.departs || b.rides < a.rides || walkingSecondsOf(b) < walkingSecondsOf(a))
  );
  // An extra ride is worth offering only for real time (or walking) saved.
  const pointless = (a: Journey, b: Journey) => {
    if (b.rides >= a.rides) return false;
    const allowance = (a.rides - b.rides) * SECONDS_PER_EXTRA_RIDE;
    const timeSaved = arriveBy ? a.departs - b.departs : b.arrives - a.arrives;
    return timeSaved < allowance && walkingSecondsOf(a) > walkingSecondsOf(b) - WALK_SAVED_FOR_EXTRA_RIDE_SECONDS;
  };
  let kept = list.filter((journey) => !list.some((other) => other !== journey && (dominated(journey, other) || pointless(journey, other))));
  if (arriveBy) {
    const latest = Math.max(...kept.map((journey) => journey.departs));
    const slack = Math.max(MIN_SLACK_SECONDS, SLACK_SHARE * (time - latest));
    kept = kept.filter((journey) => journey.departs >= latest - slack).sort((a, b) => b.departs - a.departs || a.arrives - b.arrives);
  } else {
    const earliest = Math.min(...kept.map((journey) => journey.arrives));
    const slack = Math.max(MIN_SLACK_SECONDS, SLACK_SHARE * (earliest - time));
    kept = kept.filter((journey) => journey.arrives <= earliest + slack).sort((a, b) => a.arrives - b.arrives || b.departs - a.departs);
  }
  return kept.slice(0, MAX_ITINERARIES);
}

// ---------------------------------------------------------------------------------------------
// Itineraries

function stopPoint(network: TransitNetwork, stop: number): LatLng {
  return { lat: network.stopLat[stop]!, lng: network.stopLon[stop]! };
}

function walkStep(context: PlanContext, leg: WalkLeg, toName: string): WalkStep | null {
  const { network } = context;
  const from = leg.from === null ? context.origin : stopPoint(network, leg.from);
  const to = leg.to === null ? context.destination : stopPoint(network, leg.to);
  let meters: number | null = null;
  let path: LatLng[] | null = null;
  if (leg.from !== null && leg.to !== null) {
    const known = context.walks.get(walkKey(leg.from, leg.to));
    if (known) ({ meters, path } = known);
  }
  if (path === null && hasWalkingData()) {
    const walk = walkingPath(from.lat, from.lng, to.lat, to.lng, Math.max(3000, haversineMeters(from.lat, from.lng, to.lat, to.lng) * 4));
    if (walk) {
      meters = walk.meters;
      path = walk.path.map((point) => ({ lat: point.lat, lng: point.lon }));
    }
  }
  if (path === null || meters === null) {
    meters = haversineMeters(from.lat, from.lng, to.lat, to.lng) * TRANSFER_DETOUR;
    path = [from, to];
  }
  // A change of platforms in one station isn't a walk of its own.
  if (leg.from !== null && leg.to !== null && meters < MIN_WALK_STEP_METERS) return null;
  return { kind: 'walk', durationSeconds: Math.round(leg.seconds), distanceMeters: Math.round(meters), toName, path: simplifiedPath(path) };
}

/** Every pattern of each route, for a ride's other departures. */
const routePatternsCache = new WeakMap<TransitNetwork, number[][]>();
function patternsOfRoute(network: TransitNetwork, route: number): number[] {
  let index = routePatternsCache.get(network);
  if (!index) {
    index = network.routes.map(() => []);
    for (let pattern = 0; pattern < network.patternCount; pattern += 1) index[network.patternRoute[pattern]!]!.push(pattern);
    routePatternsCache.set(network, index);
  }
  return index[route]!;
}

/** The same line's departures, in the same direction, from this ride's stop to its alighting stop, around this one. */
function rideDepartures(context: PlanContext, ride: RideLeg, iso: (seconds: number) => string): TripDeparture[] {
  const { network, days, active } = context;
  const route = network.patternRoute[ride.pattern]!;
  const direction = network.patternDirection[ride.pattern]!;
  const between = (pattern: number, from: number, to: number) => {
    const base = network.patternStopStart[pattern]!;
    return Array.from(network.patternStops.subarray(base + from + 1, base + to)).join(',');
  };
  const rideBetween = between(ride.pattern, ride.boardPosition, ride.alightPosition);
  const options = new Map<string, TripDeparture & { at: number }>();
  for (const pattern of patternsOfRoute(network, route)) {
    if (network.patternDirection[pattern] !== direction) continue;
    const base = network.patternStopStart[pattern]!;
    const count = network.patternStopCount(pattern);
    let board = -1;
    let alight = -1;
    for (let position = 0; position < count; position += 1) {
      const stop = network.patternStops[base + position]!;
      if (board < 0 && stop === ride.boardStop && network.canBoard(pattern, position)) board = position;
      else if (board >= 0 && stop === ride.alightStop && network.canAlight(pattern, position)) {
        alight = position;
        break;
      }
    }
    if (board < 0 || alight < 0) continue;
    const sameStops = between(pattern, board, alight) === rideBetween;
    for (let trip = network.patternTripStart[pattern]!; trip < network.patternTripStart[pattern + 1]!; trip += 1) {
      for (let day = 0; day < days.length; day += 1) {
        const offset = days[day]!.offset;
        const departs = network.departure(trip, board) + offset;
        if (departs < ride.departs - OPTIONS_BEFORE_SECONDS || departs > ride.departs + OPTIONS_AFTER_SECONDS) continue;
        if (active[day]![network.tripService[trip]!] !== 1) continue;
        const stopTimes: string[] = [];
        if (sameStops) for (let position = board + 1; position < alight; position += 1) stopTimes.push(iso(network.departure(trip, position) + offset));
        options.set(`${trip}@${day}`, {
          at: departs,
          departs: iso(departs),
          arrives: iso(network.arrival(trip, alight) + offset),
          ...(sameStops ? { stopTimes } : {}),
        });
      }
    }
  }
  const sorted = [...options.values()].sort((a, b) => a.at - b.at);
  const matched = sorted.findIndex((option) => Math.abs(option.at - ride.departs) <= DEPARTURE_MATCH_SECONDS);
  const start = Math.max(0, Math.min(matched < 0 ? 0 : matched - 2, sorted.length - MAX_OPTIONS));
  return sorted.slice(start, start + MAX_OPTIONS).map(({ at: _at, ...option }) => option);
}

function transitStep(context: PlanContext, ride: RideLeg, iso: (seconds: number) => string): TransitStep {
  const { network } = context;
  const route = network.routes[network.patternRoute[ride.pattern]!]!;
  const offset = context.days[ride.day]!.offset;
  const intermediate: TripStop[] = [];
  const base = network.patternStopStart[ride.pattern]!;
  for (let position = ride.boardPosition + 1; position < ride.alightPosition; position += 1) {
    const stop = network.patternStops[base + position]!;
    intermediate.push({ name: network.stopName(stop), location: stopPoint(network, stop), time: iso(network.departure(ride.trip, position) + offset) });
  }
  const direction = network.patternDirection[ride.pattern]!;
  const agencyId = network.agencyOfStop(ride.boardStop);
  const step: TransitStep = {
    kind: 'transit',
    mode: route.mode,
    agency: { name: route.agencyName, ...(route.agencyUrl ? { url: route.agencyUrl } : {}) },
    line: {
      name: route.longName || route.shortName || route.routeId,
      ...(route.shortName ? { shortName: route.shortName } : {}),
      color: route.color,
      ...(route.textColor ? { textColor: route.textColor } : {}),
      vehicleName: route.vehicleName,
    },
    ...(network.tripHeadsignText(ride.trip) ? { headsign: network.tripHeadsignText(ride.trip) } : {}),
    from: { name: network.stopName(ride.boardStop), location: stopPoint(network, ride.boardStop), time: iso(ride.departs) },
    to: { name: network.stopName(ride.alightStop), location: stopPoint(network, ride.alightStop), time: iso(ride.arrives) },
    stopCount: ride.alightPosition - ride.boardPosition,
    durationSeconds: ride.arrives - ride.departs,
    path: simplifiedPath(network.pathBetween(ride.pattern, ride.boardPosition, ride.alightPosition)),
    ...(intermediate.length > 0 ? { stops: intermediate } : {}),
    tripId: network.tripId(ride.trip),
    liveRoute: {
      agencyId,
      routeId: route.routeId,
      boardStopId: network.stopId(ride.boardStop),
      alightStopId: network.stopId(ride.alightStop),
      ...(direction >= 0 ? { directionId: direction } : {}),
    },
    // Where to go in at the boarding station and out at the alighting one.
    ...legEntrances(agencyId, network.stopId(ride.boardStop), network.stopId(ride.alightStop)),
  };
  const departures = rideDepartures(context, ride, iso);
  if (departures.length > 1) step.departures = departures;
  const ref: LiveTripRef = {
    agencyId,
    routeId: route.routeId,
    tripId: step.tripId!,
    boardStopId: network.stopId(ride.boardStop),
    alightStopId: network.stopId(ride.alightStop),
    ...(direction >= 0 ? { directionId: direction } : {}),
    stopIdsBetween: Array.from(network.patternStops.subarray(base + ride.boardPosition + 1, base + ride.alightPosition)).map((stop) => network.stopId(stop)),
  };
  liveTripRefs.set(step, ref);
  return step;
}

function itineraryFor(context: PlanContext, journey: Journey, destinationLabel: string, estimateFare?: FareEstimator): Itinerary {
  const iso = (seconds: number) => new Date(context.baseStartMs + seconds * 1000).toISOString();
  const steps: TripStep[] = [];
  journey.legs.forEach((leg, index) => {
    if (leg.kind === 'ride') {
      steps.push(transitStep(context, leg, iso));
      return;
    }
    const next = journey.legs[index + 1];
    const toName = next?.kind === 'ride' ? context.network.stopName(next.boardStop) : destinationLabel;
    const step = walkStep(context, leg, toName);
    if (step) steps.push(step);
  });
  const transits = steps.filter((step): step is TransitStep => step.kind === 'transit');
  const departureTime = iso(journey.departs);
  const key = transits.map((step) => `${step.line.name}|${step.from.name}|${step.from.time}`).join('>');
  const fare = itineraryFare(transits, departureTime, estimateFare);
  return {
    id: createHash('sha256').update(key).digest('hex').slice(0, 12),
    departureTime,
    arrivalTime: iso(journey.arrives),
    durationSeconds: journey.arrives - journey.departs,
    transfers: Math.max(0, transits.length - 1),
    ...(fare ? { fare } : {}),
    steps,
  };
}

export type PlanTransitInput = {
  request: PlanTripRequest;
  origin: LatLng;
  destination: LatLng;
  nowMs: number;
  estimateFare?: FareEstimator;
};

/** The modes a request rides: the app's three filters, ferries unless turned off, and anything else (trams). */
function modesFor(request: PlanTripRequest): Set<TransitMode> {
  const modes = new Set<TransitMode>(request.modes);
  modes.add('other');
  if (request.ferry !== false) modes.add('ferry');
  return modes;
}

/**
 * Transit itineraries between two points, fastest first (or, arriving by a time, latest leaving
 * first). Empty when no trip within reach gets there.
 */
export async function planTransitTrip({ request, origin, destination, nowMs, estimateFare }: PlanTransitInput): Promise<Itinerary[]> {
  const current = await currentNetwork();
  if (!current) return [];
  const { network, router, walks } = current;
  const arriveBy = request.time.mode === 'arrive';
  const atMs = request.time.mode === 'now' ? nowMs : Date.parse(request.time.at);
  const { baseStartMs, days } = serviceDaysAround(atMs);
  const lessWalking = request.lessWalking === true;
  const access = walkableStops(network, origin, lessWalking);
  const egress = walkableStops(network, destination, lessWalking);
  if (access.length === 0 || egress.length === 0) return [];
  const context: PlanContext = {
    network,
    router,
    walks,
    days,
    active: network.activeServices(days),
    baseStartMs,
    origin,
    destination,
    modes: modesFor(request),
    access,
    egress,
    arriveBy,
    time: Math.round((atMs - baseStartMs) / 1000),
  };

  let journeys: Journey[] = [];
  for (let pass = 0; pass < MAX_WALK_CHECK_PASSES; pass += 1) {
    journeys = chooseJourneys(runSearches(context), arriveBy, context.time);
    if (!checkWalks(context, journeys)) break;
  }
  return journeys.map((journey) => itineraryFor(context, journey, request.destination.label, estimateFare));
}

/** Unit-test isolation only. */
export function resetTripPlannerForTests(): void {
  loaded = null;
  loading = null;
  networkOverride = null;
}
