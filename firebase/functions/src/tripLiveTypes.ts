import type { AgencyId } from './gtfsAgencies';

/** Identifies a scheduled run and the exact two visits selected by the rider. */
export type TripRunRef = {
  version: 1;
  agencyId: AgencyId;
  routeId: string;
  tripId: string;
  serviceDate: string;
  scheduleVersion: string;
  /** GTFS time from the run's first stop, possibly beyond 24:00:00. */
  startTime: string;
  boardStopId: string;
  alightStopId: string;
  /** Zero-based visit count of this stop_id in the full run, not its overall stop index. */
  boardOccurrence: number;
  alightOccurrence: number;
  boardStopSequence?: number;
  alightStopSequence?: number;
  directionId?: number;
};

/** Server-only baseline, validated against the selected agency's published schedule. */
export type ResolvedTripRun = {
  runRef: TripRunRef;
  departs: string;
  arrives: string;
  stops: {
    stopId: string;
    occurrence: number;
    stopSequence?: number;
    arrives: string;
    departs: string;
  }[];
};

export type TripLiveReason = 'schedule-mismatch' | 'not-found' | 'ambiguous-run' | 'missing-timestamp'
  | 'future-timestamp' | 'stale' | 'unsupported-feed' | 'timeout' | 'feed-unavailable' | 'no-prediction';

/** Times are predictions, never evidence that the rider or vehicle has passed a checkpoint. */
export type TripLegObservation = {
  legKey: string;
  runRef: TripRunRef;
  state: 'fresh' | 'stale' | 'unknown';
  status: 'predicted' | 'cancelled' | 'skips-stop' | 'no-data' | 'unavailable';
  observedAt: number | null;
  expiresAt: number | null;
  departs?: string;
  arrives?: string;
  departureDelaySeconds?: number;
  arrivalDelaySeconds?: number;
  /** Explicit NO_DATA is retained even when the other endpoint has a usable prediction. */
  departureNoData?: boolean;
  arrivalNoData?: boolean;
  departureInferred?: boolean;
  arrivalInferred?: boolean;
  boardSkipped?: boolean;
  alightSkipped?: boolean;
  /** Exact fresh vehicle evidence only; the rider's own boarding status is still independent. */
  boardPassed?: boolean;
  vehicleLocation?: { lat: number; lng: number; capturedAt: number };
  reason?: TripLiveReason;
};

export type TripLiveRequest = { version: 1; legs: { legKey: string; runRef: TripRunRef }[] };
export type TripLiveResponse = { version: 1; fetchedAt: number; legs: TripLegObservation[] };

/** Route View's chosen departure, before the server supplies its canonical timetable version. */
export type ResolveRideGuideRunRequest = {
  version: 1; agencyId: AgencyId; routeId: string; tripId: string; serviceDate: string; startTime?: string; directionId?: number;
  boardStopId: string; alightStopId: string; boardOccurrence?: number; alightOccurrence?: number;
  boardStopSequence?: number; alightStopSequence?: number;
};
export type ResolveRideGuideRunResponse = {
  version: 1; status: 'resolved'; runRef: TripRunRef; departs: string; arrives: string;
  stops: (ResolvedTripRun['stops'][number] & { name: string; location: { lat: number; lng: number } })[];
} | { version: 1; status: 'unknown'; reason: 'not-found' | 'unavailable' | 'unsupported-run' };
