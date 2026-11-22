import { createHash } from 'crypto';

import { simplifyPath } from './gtfsGeometry';
import type { StationEntrance } from './stationEntrances';

/**
 * The trip-planning request and itinerary formats the app reads (mirrored in
 * mobile/src/data/tripPlanning.ts), and the pieces of an itinerary shared by Pathly's planner
 * (tripPlanner.ts): fares, simplified paths, and walking the whole way.
 */

export type TravelModeOption = 'subway' | 'bus' | 'rail';
export type TripPreference = 'fastest' | 'transfers' | 'cheapest';
export type LatLng = { lat: number; lng: number };

/** A place given by coordinates; an older app can send only a Google place id (resolved in index.ts). */
export type TripEndpoint = { placeId?: string; lat?: number; lng?: number; label: string };
export type PlanTripRequest = {
  origin: TripEndpoint;
  destination: TripEndpoint;
  time: { mode: 'now' } | { mode: 'depart' | 'arrive'; at: string };
  preference: TripPreference;
  modes: TravelModeOption[];
  /** Ferries may be ridden unless the rider turned them off (apps before this field always rode them). */
  ferry?: boolean;
  /** The rider turned walking off (Settings -> Travel preferences): walk less to and between stops. */
  lessWalking?: boolean;
  /** Also offer walking the whole way when it takes at most this many minutes (walkOnlyItinerary). */
  walkOnlyMaxMinutes?: number;
};

export type TripStop = { name: string; location: LatLng; time: string };
export type WalkStep = { kind: 'walk'; durationSeconds: number; distanceMeters: number; toName: string; path: LatLng[] };
export type TransitStep = {
  kind: 'transit';
  mode: TravelModeOption | 'ferry' | 'other';
  agency: { name: string; url?: string };
  line: { name: string; shortName?: string; color?: string; textColor?: string; vehicleName?: string };
  headsign?: string;
  from: TripStop;
  to: TripStop;
  stopCount: number;
  durationSeconds: number;
  path: LatLng[];
  /** The stops in between, in order. */
  stops?: TripStop[];
  /** The scheduled trip's GTFS trip_id (shown by the admin ID overlay). */
  tripId?: string;
  /**
   * Scheduled departures of the same line between the same two stops around this one (this one
   * included), so the rider can pick another. `stopTimes` follow `stops` when that trip calls at
   * the same stops in between.
   */
  departures?: TripDeparture[];
  /** The leg's GTFS line, direction and boarding stop, so the app can show its live vehicles. */
  liveRoute?: { agencyId: string; routeId: string; boardStopId: string; alightStopId?: string; directionId?: number };
  /** The boarding and alighting stations' ways in and out (stationEntrances.ts); absent where the agency publishes none. */
  boardEntrances?: StationEntrance[];
  alightEntrances?: StationEntrance[];
  /** What the agency's live feed says about this leg's trip (tripLive.ts); absent when it says nothing. */
  live?: LegLive;
  /** The connection into this leg from the previous one, when it's tight or already missed (tripLive.ts). */
  connection?: LegConnection;
  /** The line's service alerts in effect now or starting soon (gtfsAlerts.ts); absent when there are none. */
  alerts?: LegAlert[];
};
/** One of a leg's line's service alerts: what route status sends, minus its internal `kind`. */
export type LegAlert = { id: string; header: string; description: string | null; label: string; warning: boolean; upcoming: boolean };
/**
 * 'tracked': live times (`delaySeconds` is the live time against the planned one, late when
 * positive); 'cancelled': the trip won't run; 'skips-stop': it won't stop where the rider boards or gets off.
 */
export type LegLive = { status: 'tracked' | 'cancelled' | 'skips-stop'; departs?: string; arrives?: string; delaySeconds?: number };
/** `spareSeconds`: time left over after the walk between the legs; negative when already missed. */
export type LegConnection = { status: 'tight' | 'missed'; spareSeconds: number };
export type TripDeparture = { departs: string; arrives: string; stopTimes?: string[] };
export type TripStep = WalkStep | TransitStep;
/** One part of a fare: a ride, what it adds, and why ("Free transfer within 2 hours"). */
export type FareLine = { label: string; text: string; note?: string };
/**
 * `reduced`: the 65+/disability/Medicare fare, when the published rules price every step.
 * `student` (K-12), `college` and `fairFares` likewise, each only when it's cheaper than the full fare.
 */
export type DiscountRider = 'reduced' | 'student' | 'college' | 'fairFares';
export type RiderFare = { text: string; cents: number; lines?: FareLine[] };
export type TripFare = { text: string; cents: number; currency: string; estimated: boolean; lines?: FareLine[] } & Partial<Record<DiscountRider, RiderFare>>;
export type Itinerary = {
  id: string;
  departureTime: string;
  arrivalTime: string;
  durationSeconds: number;
  transfers: number;
  fare?: TripFare;
  steps: TripStep[];
};

/** Prices a trip's rides from the agencies' published fares (tripFares.ts). */
export type FareEstimator = (steps: readonly TransitStep[], departureTime: string, rider?: 'full' | DiscountRider) => TripFare | undefined;

const DISCOUNT_RIDERS: readonly DiscountRider[] = ['reduced', 'student', 'college', 'fairFares'];

/**
 * The trip's fare from the published fare rules, with each discount fare the rules price lower:
 * sent with every fare, so which one applies to the rider never leaves their device.
 */
export function itineraryFare(transits: readonly TransitStep[], departureTime: string, estimateFare?: FareEstimator): TripFare | undefined {
  if (transits.length === 0 || !estimateFare) return undefined;
  let fare = estimateFare(transits, departureTime);
  if (!fare) return undefined;
  for (const rider of DISCOUNT_RIDERS) {
    const discounted = estimateFare(transits, departureTime, rider);
    if (discounted && discounted.cents < fare.cents) {
      fare = { ...fare, [rider]: { text: discounted.text, cents: discounted.cents, ...(discounted.lines ? { lines: discounted.lines } : {}) } };
    }
  }
  return fare;
}

// Visually identical at street zoom, while keeping a six-itinerary response to tens of KB.
const PATH_SIMPLIFY_METERS = 4;

/** A path simplified for the app and rounded to about a meter. */
export function simplifiedPath(points: readonly LatLng[]): LatLng[] {
  return simplifyPath(points.map((point) => ({ lat: point.lat, lon: point.lng })), PATH_SIMPLIFY_METERS)
    .map((point) => ({ lat: Math.round(point.lat * 1e5) / 1e5, lng: Math.round(point.lon * 1e5) / 1e5 }));
}

const addSeconds = (iso: string, delta: number) => new Date(Date.parse(iso) + delta * 1000).toISOString();

/** Walking pace for a walk-only trip: about 3 mph, as the app's other walking estimates. */
export const WALK_ONLY_METERS_PER_SECOND = 1.3;
/** The longest walk-only trip a rider can ask for. */
export const MAX_WALK_ONLY_MINUTES = 90;

/** The farthest a walk-only trip of `maxMinutes` can go, which bounds the street search. */
export function walkOnlyLimitMeters(maxMinutes: number): number {
  return maxMinutes * 60 * WALK_ONLY_METERS_PER_SECOND;
}

/**
 * Walking the whole way, as an itinerary: one walk step along `path` (from Pathly's own street
 * graph, walkingGraph.ts), timed from the trip's requested time. Null when it's over `maxMinutes`.
 */
export function walkOnlyItinerary(
  walk: { meters: number; path: LatLng[] },
  time: PlanTripRequest['time'],
  nowMs: number,
  destinationLabel: string,
  maxMinutes: number,
): Itinerary | null {
  const durationSeconds = Math.round(walk.meters / WALK_ONLY_METERS_PER_SECOND);
  if (durationSeconds > maxMinutes * 60) return null;
  const departs = time.mode === 'now' ? nowMs : time.mode === 'depart' ? Date.parse(time.at) : Date.parse(time.at) - durationSeconds * 1000;
  const departureTime = new Date(departs).toISOString();
  return {
    // Every walk-only trip shares one id, so it's offered once.
    id: createHash('sha256').update('walk').digest('hex').slice(0, 12),
    departureTime,
    arrivalTime: addSeconds(departureTime, durationSeconds),
    durationSeconds,
    transfers: 0,
    steps: [{ kind: 'walk', durationSeconds, distanceMeters: Math.round(walk.meters), toName: destinationLabel, path: simplifiedPath(walk.path) }],
  };
}
