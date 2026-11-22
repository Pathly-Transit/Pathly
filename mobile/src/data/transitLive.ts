
import { isRideReportKind, type VehicleReport } from './rideReports';
import { normalizeBeanAvatar, type BeanAvatarConfig } from '../avatars/beanAvatar';
import type { Coordinates } from '../hooks/useCurrentLocation';
import { auth, callable } from '../lib/firebase';
import { directionStop, type NearestDirectionResponse, type NearestRouteStop } from './nearestRouteStop';
import type { LiveSource, ServiceAlert } from './transit';

export type RouteLiveVehicle = {
  tripId: string;
  /** GTFS direction_id, so the map can show only the selected direction's vehicles. */
  directionId: number;
  lat: number;
  lon: number;
  /** When the vehicle's GPS position was measured (epoch ms); null if the backend didn't say. */
  updatedAt: number | null;
  /** What riders on it say right now (rideReports.ts), most-reported first. */
  reports?: readonly VehicleReport[];
  /** Pathly riders sharing this ride (rideSessions.ts); when set, lat/lon/updatedAt are theirs. */
  riders?: {
    count: number;
    /** At most three, the rider's own first. */
    avatars: readonly BeanAvatarConfig[];
    you: boolean;
    /** Where the agency's feed puts the vehicle. */
    feed: { lat: number; lon: number; updatedAt: number | null };
  };
};
type VehicleRidersResponse = { count: number; avatars: unknown[]; you: boolean; feed: { lat: number; lon: number; timestamp: number | null } };
export type DirectionPrediction = {
  minutes: number;
  live: boolean;
  /** This specific trip's real LIRR peak/off-peak classification — null for agencies without fare tiers (e.g. subway's flat fare) or if it couldn't be resolved. */
  peakOffpeak: boolean | null;
  /** Minutes a tracked trip runs behind its timetable; absent from functions deployed before it was added. */
  delayMinutes?: number | null;
  /** Where this trip ends (its headsign or last stop); absent from functions deployed before it was added. */
  headsign?: string | null;
  tripId?: string; serviceDate?: string; startTime?: string; stopId?: string; stopSequence?: number; directionId?: number;
  departureTime?: string;
};

type StopPredictions = {
  towardDirection1: readonly DirectionPrediction[];
  towardDirection0: readonly DirectionPrediction[];
};

type RouteLiveStatusResponse = {
  routeId: string;
  routeName: string;
  /** `timestamp` is epoch seconds; absent from functions deployed before it was added. */
  vehicles: { tripId: string; directionId: number; lat: number; lon: number; timestamp?: number | null; riders?: VehicleRidersResponse; reports?: { kind: string; count: number }[] }[];
  stopPredictions: StopPredictions;
  /** Absent from functions deployed before service alerts were added. */
  alerts?: ServiceAlert[];
};

export type RouteLiveData = {
  /** Lets callers confirm this matches the route they're about to apply it to, rather than assuming there's only ever one live route. */
  routeId: string;
  predictions: {
    /** direction_id 1. Real-time when a vehicle is currently tracked; for agencies where it's reliable (see backend's gtfsAgencies.ts), otherwise padded with the real published timetable (never a placeholder) — see `live` on each entry. */
    towardDirection1: readonly DirectionPrediction[];
    /** direction_id 0. Same real-time/timetable fallback as towardDirection1. */
    towardDirection0: readonly DirectionPrediction[];
  };
  vehicles: readonly RouteLiveVehicle[];
  /** MTA service alerts in effect on the route (empty when there are none, or the agency isn't covered). */
  alerts?: readonly ServiceAlert[];
  /** When this data was fetched (epoch ms), so countdowns can be aged between polls. */
  fetchedAt: number;
  /**
   * The nearest stop the backend resolved from the rider's location in the same call;
   * `undefined` (not null) when the deployed backend predates that, so callers can fall back.
   */
  nearestStop?: NearestRouteStop | null;
};

type NearestStopResponse = {
  distanceMeters: number;
  direction1: NearestDirectionResponse;
  direction0: NearestDirectionResponse;
} | null;

const getRouteLiveStatus = callable<
  { agencyId: string; routeId: string; direction1StopId: string; direction0StopId: string; lat?: number; lon?: number },
  RouteLiveStatusResponse & { nearestStop?: NearestStopResponse }
>('getRouteLiveStatus');

const LIVE_READ_FRESH_MS = 1_000;
const MAX_LIVE_READS = 32;
type LiveRead = { promise: Promise<RouteLiveData>; fetchedAt?: number };
const liveReads = new Map<string, LiveRead>();
let liveReadOwner: string | null | undefined;

/** Test/session reset; late requests cannot repopulate the cleared cache. */
export function clearRouteLiveReads(): void {
  liveReads.clear();
  liveReadOwner = undefined;
}

/**
 * Upcoming departures and vehicles. Identical map/sharing reads share an in-flight request and
 * a one-second fresh result; every 15-second poll still fetches current data. Direction stop IDs
 * and exact rider coordinates remain part of the key, along with the current account scope.
 */
export function fetchRouteLiveData(source: LiveSource, location?: Coordinates): Promise<RouteLiveData> {
  const owner = auth?.currentUser?.uid ?? null;
  if (owner !== liveReadOwner) {
    liveReads.clear();
    liveReadOwner = owner;
  }
  const request = {
    ...routeRequest(source),
    ...(location ? { lat: location.latitude, lon: location.longitude } : {}),
  };
  // Responses include account-specific rider overlays and stop/location-specific predictions.
  // Share only identical reads; never approximate coordinates or reuse another owner's result.
  const key = JSON.stringify(request);
  const cached = liveReads.get(key);
  const age = cached?.fetchedAt === undefined ? null : Date.now() - cached.fetchedAt;
  if (cached && (age === null || (age >= 0 && age < LIVE_READ_FRESH_MS))) return cached.promise;
  const read: LiveRead = {
    promise: getRouteLiveStatus(request).then(({ data }) => {
      if ((auth?.currentUser?.uid ?? null) !== owner) throw new Error('Live status account changed');
      if (data.routeId !== request.routeId) throw new Error('Live status did not match the requested route');
      const result = toRouteLiveData(data);
      if (liveReadOwner === owner && liveReads.get(key) === read) read.fetchedAt = result.fetchedAt;
      return result;
    }).catch((error) => {
      if (liveReads.get(key) === read) liveReads.delete(key);
      throw error;
    }),
  };
  liveReads.delete(key);
  liveReads.set(key, read);
  while (liveReads.size > MAX_LIVE_READS) liveReads.delete(liveReads.keys().next().value!);
  return read.promise;
}

type RouteRequest = { agencyId: string; routeId: string; direction1StopId: string; direction0StopId: string };

function routeRequest(source: LiveSource): RouteRequest {
  return {
    agencyId: source.agencyId,
    routeId: source.routeId,
    direction1StopId: source.direction1StopId,
    direction0StopId: source.direction0StopId,
  };
}

/** The most routes the backend answers in one batch (getRoutesLiveStatus's MAX_BATCH_ROUTES). */
export const MAX_BATCH_ROUTES = 12;

const getRoutesLiveStatus = callable<
  { routes: RouteRequest[]; lat?: number; lon?: number },
  { results: ({ ok: true; data: RouteLiveStatusResponse & { nearestStop?: NearestStopResponse } } | { ok: false; code: string })[] }
>('getRoutesLiveStatus');

/** Thrown when the deployed backend predates batching, so callers can fall back to one request per route. */
export class BatchUnavailableError extends Error {}

/**
 * Live status for up to MAX_BATCH_ROUTES routes in one request: every card on screen waits in the
 * backend's one-at-a-time live-status queue once, not once per card. Each entry is that route's
 * data, or null if that route alone failed.
 */
export async function fetchRoutesLiveData(sources: readonly LiveSource[], location?: Coordinates): Promise<(RouteLiveData | null)[]> {
  const owner = auth?.currentUser?.uid ?? null;
  const routes = sources.map(routeRequest);
  try {
    const { data } = await getRoutesLiveStatus({
      routes,
      ...(location ? { lat: location.latitude, lon: location.longitude } : {}),
    });
    if ((auth?.currentUser?.uid ?? null) !== owner) throw new Error('Live status account changed');
    return routes.map((route, index) => {
      const result = data.results[index];
      return result?.ok && result.data.routeId === route.routeId ? toRouteLiveData(result.data) : null;
    });
  } catch (error) {
    if ((auth?.currentUser?.uid ?? null) !== owner) throw new Error('Live status account changed');
    // A backend deployed before batching has no such function.
    if ((error as { code?: string } | null)?.code === 'functions/not-found') throw new BatchUnavailableError();
    throw error;
  }
}

function toRouteLiveData(data: RouteLiveStatusResponse & { nearestStop?: NearestStopResponse }): RouteLiveData {
  const nearest = data.nearestStop;
  return {
    routeId: data.routeId,
    fetchedAt: Date.now(),
    ...(nearest !== undefined
      ? {
        nearestStop: nearest
          ? {
            distanceMeters: nearest.distanceMeters,
            direction1: directionStop(nearest.direction1),
            direction0: directionStop(nearest.direction0),
          }
          : null,
      }
      : {}),
    predictions: {
      towardDirection1: data.stopPredictions.towardDirection1,
      towardDirection0: data.stopPredictions.towardDirection0,
    },
    alerts: data.alerts ?? [],
    vehicles: data.vehicles.map((vehicle) => ({
      tripId: vehicle.tripId,
      directionId: vehicle.directionId,
      lat: vehicle.lat,
      lon: vehicle.lon,
      updatedAt: vehicle.timestamp != null ? vehicle.timestamp * 1000 : null,
      ...(vehicle.reports ? { reports: vehicle.reports.filter((report): report is VehicleReport => isRideReportKind(report.kind)) } : {}),
      ...(vehicle.riders ? {
        riders: {
          count: vehicle.riders.count,
          avatars: vehicle.riders.avatars.slice(0, 3).map(normalizeBeanAvatar),
          you: vehicle.riders.you,
          feed: { lat: vehicle.riders.feed.lat, lon: vehicle.riders.feed.lon, updatedAt: vehicle.riders.feed.timestamp != null ? vehicle.riders.feed.timestamp * 1000 : null },
        },
      } : {}),
    })),
  };
}

const getStopDeparturesCallable = callable<
  { agencyId: string; routeId: string; direction1StopId: string; direction0StopId: string; directionId: 0 | 1 },
  { departures: DirectionPrediction[] }
>('getStopDepartures');

/**
 * Every remaining departure today (plus the next service day's first ones late at night) from
 * the given stops in one GTFS direction — the "More departures" page. Not cached: the page
 * refetches each time it opens.
 */
export async function fetchStopDepartures(source: LiveSource, directionId: 0 | 1): Promise<readonly DirectionPrediction[]> {
  const { data } = await getStopDeparturesCallable({
    agencyId: source.agencyId,
    routeId: source.routeId,
    direction1StopId: source.direction1StopId,
    direction0StopId: source.direction0StopId,
    directionId,
  });
  return data.departures;
}
