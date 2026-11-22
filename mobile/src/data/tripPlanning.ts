
import type { Coordinates, LocationStatus } from '../hooks/useCurrentLocation';
import { badgeLabel, type TransitMode } from '../components/RouteBadge';
import { auth, callable } from '../lib/firebase';
import { isPathAgency, pathHeadsign, pathLineCode } from './pathLines';
import type { SearchPlace } from './placesSearch';
import { appNow, isMockClock } from '../debug/clock';
import type { RoutePreference, ServiceAlert, TripTimeChoice } from './transit';
import type { StationEntrance } from './stationEntrances';
import {
  createTripSelectionIdentity,
  sameTripSelection,
  type TripEndpointReference,
  type TripSelectionIdentity,
} from './enrouteNavigation';
import { retimeItinerary } from './tripDepartures';
import { recordRequest } from '../debug/requestLog';

/** Mirrors firebase/functions/src/tripPlanning.ts — the itinerary shape planTrip returns. */
export type LatLng = { lat: number; lng: number };
export type TripMode = 'subway' | 'bus' | 'rail';
export type TripStop = { name: string; location: LatLng; time: string };
export type WalkStep = { kind: 'walk'; durationSeconds: number; distanceMeters: number; toName: string; path: LatLng[] };
export type TransitStep = {
  kind: 'transit';
  /** Ferries are asked for (or not) on their own (`ferry` in the request); 'other' is anything else (trams). */
  mode: TripMode | 'ferry' | 'other';
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
  /** The scheduled trip's GTFS trip_id (admin ID overlay). */
  tripId?: string;
  /** The same line's scheduled departures between the same two stops, this one included (tripDepartures.ts). */
  departures?: TripDeparture[];
  /** The leg's GTFS line, direction and boarding stop (backend tripPlanner.ts), for its live vehicles. */
  liveRoute?: { agencyId: string; routeId: string; boardStopId: string; alightStopId?: string; directionId?: number };
  /** The boarding and alighting stations' ways in and out (backend stationEntrances.ts); absent where the agency publishes none, and for buses. */
  boardEntrances?: StationEntrance[];
  alightEntrances?: StationEntrance[];
  /** What the agency's live feed says about this leg's trip (backend tripLive.ts). */
  live?: LegLive;
  /** The connection into this leg from the previous one, when it's tight or already missed. */
  connection?: LegConnection;
  /** The line's service alerts in effect now or starting soon (backend tripLive.ts); absent when there are none. */
  alerts?: readonly ServiceAlert[];
};
/** 'tracked': live times, `delaySeconds` against the plan (late when positive). */
export type LegLive = { status: 'tracked' | 'cancelled' | 'skips-stop'; departs?: string; arrives?: string; delaySeconds?: number };
/** `spareSeconds`: time left after the walk between the legs; negative when already missed. */
export type LegConnection = { status: 'tight' | 'missed'; spareSeconds: number };
/** `stopTimes` follow the leg's `stops` when that trip calls at the same stops in between. */
export type TripDeparture = { departs: string; arrives: string; stopTimes?: string[] };
export type TripStep = WalkStep | TransitStep;
/**
 * `reduced`: the 65+/disability/Medicare fare, when the published rules price every step.
 * `student` (K-12), `college` and `fairFares` likewise, each only when it's cheaper than the full fare.
 */
/** One part of a fare: a ride, what it adds, and why ("Free transfer within 2 hours"). */
export type FareLine = { label: string; text: string; note?: string };
export type RiderFare = { text: string; cents: number; lines?: FareLine[] };
export type TripFare = { text: string; cents: number; currency: string; estimated: boolean; lines?: FareLine[] } & Partial<Record<Exclude<FareType, 'full'>, RiderFare>>;
/** Settings -> Travel preferences; only ever kept on the device. */
export type FareType = 'full' | 'reduced' | 'student' | 'college' | 'fairFares';

/** The rider's own price for a trip, if the rules give them one. */
export const riderFare = (fare: TripFare | undefined, fareType: FareType): RiderFare | undefined => (fareType === 'full' ? undefined : fare?.[fareType]);
export type Itinerary = {
  id: string;
  departureTime: string;
  arrivalTime: string;
  durationSeconds: number;
  transfers: number;
  fare?: TripFare;
  steps: TripStep[];
};

type TripEndpoint = { placeId?: string; lat?: number; lng?: number; label: string };
type PlanTripRequest = {
  origin: TripEndpoint;
  destination: TripEndpoint;
  time: { mode: 'now' } | { mode: 'depart' | 'arrive'; at: string };
  preference: RoutePreference;
  modes: TripMode[];
  /** False when the rider turned ferries off; left out, ferries may be ridden. */
  ferry?: false;
  /** Settings -> Travel preferences with walking off: plan with less walking. */
  lessWalking?: boolean;
  /** Also plan walking the whole way, when it takes at most this many minutes. */
  walkOnlyMaxMinutes?: number;
};

export const CURRENT_LOCATION_LABEL = 'Current location';
export const TRIP_TIME_ZONE = 'America/New_York';

/** Why there are no itineraries to show (besides loading). */
export type TripPlanProblem = 'no-origin' | 'needs-place' | 'out-of-area' | 'unavailable';
export type TripPlanResult =
  | { ok: true; itineraries: Itinerary[]; fetchedAt: number; resumeRequest: ResumePlanRequest }
  /** `field`: which endpoint needs choosing from search (for 'needs-place'). */
  | { ok: false; problem: TripPlanProblem; field?: 'origin' | 'destination' };

export type TripEndpoints = { origin: string; originPlace?: SearchPlace; destination: string; destinationPlace?: SearchPlace };

/**
 * The provider-light request kept for relaunch recovery. Unlike the route-results picker value,
 * its time is an absolute instant, so reopening the app never changes "today" into a later day.
 */
export type ResumePlanRequest = {
  origin: TripEndpointReference;
  destination: TripEndpointReference;
  time: { mode: 'depart' | 'arrive'; at: string };
  preference: 'fastest' | 'transfers';
  modes: TripMode[];
  /** Planned asking for less walking, so a resumed trip is looked for among the same results. */
  lessWalking?: true;
};

export type ResumePlanResult =
  | { ok: true; itinerary: Itinerary; fetchedAt: number }
  | { ok: false; problem: 'unavailable' | 'no-exact-match' };

// ---------------------------------------------------------------------------------------------
// Time: the picker's clock time means its next occurrence in New York, wherever the device is.

const wallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: TRIP_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** New York's wall-clock time at `ms`, read as if it were UTC (so the difference is the offset). */
function nyWallAsUtc(ms: number): number {
  const parts = Object.fromEntries(wallClock.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** The instant New York's clock shows `minutes` past midnight on the day `dayMs` falls on there. */
export function nyInstant(dayMs: number, minutes: number): number {
  const wall = new Date(nyWallAsUtc(dayMs));
  const guess = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), Math.floor(minutes / 60), minutes % 60);
  // Two passes settle the offset on either side of a DST change.
  let instant = guess - (nyWallAsUtc(guess) - guess);
  instant = guess - (nyWallAsUtc(instant) - instant);
  return instant;
}

const ONE_MINUTE_MS = 60_000;
const ONE_DAY_MS = 24 * 60 * ONE_MINUTE_MS;
const JUST_PASSED_MS = 5 * ONE_MINUTE_MS;

/** The next time New York's clock reads `minutes` past midnight: today if still ahead, else tomorrow. */
export function nextOccurrence(minutes: number, now: Date = new Date()): { at: string; tomorrow: boolean } {
  const today = nyInstant(now.getTime(), minutes);
  if (today >= now.getTime() + ONE_MINUTE_MS) return { at: new Date(today).toISOString(), tomorrow: false };
  return { at: new Date(nyInstant(now.getTime() + ONE_DAY_MS, minutes)).toISOString(), tomorrow: true };
}

const dateKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TRIP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** New York's date at `ms`, as "2026-10-29". */
export function nyDateKey(ms: number): string {
  return dateKeyFormat.format(new Date(ms));
}

/** Midday UTC on a date key's day: an instant that falls on that same day in New York. */
export function dateKeyMs(key: string): number {
  return Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)), 16);
}

/** `key` moved by whole days. */
export function addDays(key: string, days: number): string {
  return new Date(dateKeyMs(key) + days * ONE_DAY_MS).toISOString().slice(0, 10);
}

/**
 * When a timed trip choice happens: its chosen day at that clock time unless that has clearly
 * passed, otherwise (no day chosen, or it has) the clock time's next occurrence. A time that has
 * only just gone stays put, so the current time, or a trip left open for a few minutes, isn't
 * moved to tomorrow. `dayOffset` counts New York days from today.
 */
export function tripTimeAt(time: { minutes: number; date?: string }, now: Date = new Date()): { at: string; dayOffset: number } {
  const chosen = time.date ? nyInstant(dateKeyMs(time.date), time.minutes) : Number.NaN;
  const at = chosen >= now.getTime() - JUST_PASSED_MS ? new Date(chosen).toISOString() : nextOccurrence(time.minutes, now).at;
  const dayOffset = Math.round((dateKeyMs(nyDateKey(Date.parse(at))) - dateKeyMs(nyDateKey(now.getTime()))) / ONE_DAY_MS);
  return { at, dayOffset };
}

const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

/** "Tue, Oct 27" for a date key. */
export function formatDateKey(key: string): string {
  return dayFormat.format(new Date(dateKeyMs(key)));
}

/** How a trip time's day reads after the clock time: nothing today, "tomorrow", else the date. */
export function tripDayLabel(time: { minutes: number; date?: string }, now: Date = new Date()): string {
  const { at, dayOffset } = tripTimeAt(time, now);
  if (dayOffset <= 0) return '';
  return dayOffset === 1 ? 'tomorrow' : formatDateKey(nyDateKey(Date.parse(at)));
}

const clockFormat = new Intl.DateTimeFormat('en-US', { timeZone: TRIP_TIME_ZONE, hour: 'numeric', minute: '2-digit' });

/** "9:41 AM" in New York time. */
export function formatTripClock(iso: string): string {
  return clockFormat.format(new Date(iso)).replace(/ /g, ' ');
}

export function tripMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

export type DurationDisplay = {
  /** Compact rider-facing copy, such as "42 min" or "2hr 26m". */
  visible: string;
  /** Natural copy for screen readers, such as "2 hours 26 minutes". */
  accessibility: string;
};

/** Formats a whole-minute trip duration without leaving long trips as one large minute count. */
export function formatDurationMinutes(minutes: number): DurationDisplay {
  const totalMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (hours === 0) {
    return {
      visible: `${remainingMinutes} min`,
      accessibility: `${remainingMinutes} ${remainingMinutes === 1 ? 'minute' : 'minutes'}`,
    };
  }

  const hourAccessibility = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  if (remainingMinutes === 0) return { visible: `${hours}hr`, accessibility: hourAccessibility };
  return {
    visible: `${hours}hr ${remainingMinutes}m`,
    accessibility: `${hourAccessibility} ${remainingMinutes} ${remainingMinutes === 1 ? 'minute' : 'minutes'}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Endpoints

/** A Places id we can route to (names-only and demo places have none). */
function googlePlaceId(place: SearchPlace | undefined): string | undefined {
  const id = place?.id;
  return id && !id.startsWith('name:') && /^[A-Za-z0-9_-]{16,}$/.test(id) ? id : undefined;
}

function placeLocation(place: SearchPlace | undefined): LatLng | undefined {
  const location = place?.location;
  // Saved places without coordinates are stored as [0, 0].
  return location && (location.latitude !== 0 || location.longitude !== 0) ? { lat: location.latitude, lng: location.longitude } : undefined;
}

/** Whether a selected/saved place can route without waiting for the device's current position. */
export function hasRoutableTripPlace(label: string, place: SearchPlace | undefined): boolean {
  const usablePlace = place?.title === label ? place : undefined;
  return Boolean(googlePlaceId(usablePlace) || placeLocation(usablePlace));
}

type EndpointResult = { endpoint: TripEndpoint } | { problem: 'no-origin' | 'needs-place' };

function endpointFor(label: string, place: SearchPlace | undefined, location: Coordinates | null): EndpointResult {
  const usablePlace = place?.title === label ? place : undefined;
  const placeId = googlePlaceId(usablePlace);
  const point = placeLocation(usablePlace);
  // A Recent can deliberately carry the coordinate that was called "Current location" when the
  // trip ran. Prefer that explicit provider-light endpoint; ordinary new searches have no place
  // object and continue to use the rider's live position.
  if (label === CURRENT_LOCATION_LABEL && !placeId && !point) {
    return location ? { endpoint: { label, lat: location.latitude, lng: location.longitude } } : { problem: 'no-origin' };
  }
  if (!placeId && !point) return { problem: 'needs-place' };
  return { endpoint: { label, ...(placeId ? { placeId } : {}), ...(point ? point : {}) } };
}

function referenceFor(endpoint: TripEndpoint, savedAt: number): TripEndpointReference | null {
  if (endpoint.placeId) return { kind: 'place', label: endpoint.label, placeId: endpoint.placeId };
  if (endpoint.lat === undefined || endpoint.lng === undefined) return null;
  return { kind: 'coordinate', label: endpoint.label, point: { lat: endpoint.lat, lng: endpoint.lng }, savedAt };
}

function requestEndpoint(reference: TripEndpointReference): TripEndpoint {
  return reference.kind === 'place'
    ? { label: reference.label, placeId: reference.placeId }
    : { label: reference.label, lat: reference.point.lat, lng: reference.point.lng };
}

/** The rider's position for "Current location", once a real fix exists. */
export function riderLocation(location: Coordinates, status: LocationStatus): Coordinates | null {
  return status === 'located' ? location : null;
}

// ---------------------------------------------------------------------------------------------
// Requests

/** What the admin's request log keeps of a plan: each trip's lines, times, and fare, not every step. */
export function summarizeItineraries({ itineraries }: { itineraries: Itinerary[] }) {
  return {
    count: itineraries.length,
    itineraries: itineraries.map((itinerary) => ({
      lines: itinerary.steps.filter((step): step is TransitStep => step.kind === 'transit').map((step) => step.line.shortName ?? step.line.name),
      departureTime: itinerary.departureTime,
      arrivalTime: itinerary.arrivalTime,
      fare: itinerary.fare?.text ?? null,
    })),
  };
}

const planTripCallable = callable<PlanTripRequest, { itineraries: Itinerary[] }>('planTrip', summarizeItineraries);

const CACHE_MS = 2 * ONE_MINUTE_MS;
const cache = new Map<string, { result: TripPlanResult; at: number }>();

export type PlanTripOptions = {
  endpoints: TripEndpoints;
  location: Coordinates | null;
  time: TripTimeChoice;
  preference: RoutePreference;
  modes: readonly TripMode[];
  /** Whether ferries may be ridden (the Ferry mode switch); true unless turned off. */
  ferry?: boolean;
  /** Ask for trips with less walking (Settings -> Travel preferences, walking off). */
  lessWalking?: boolean;
  /** Also offer walking the whole way up to this many minutes (Settings -> Travel preferences); null is off. */
  walkOnlyMaxMinutes?: number | null;
  /** Skip the short-lived cache (the refresh control). */
  refresh?: boolean;
  now?: Date;
};

/**
 * Captures the route-results request as a safe relaunch reference. Coordinate endpoints are
 * timestamped so navigation storage can enforce Google Places' 30-day limit on keeping the
 * coordinates of a place it found.
 */
export function createResumePlanRequest(
  { endpoints, location, time, preference, modes, lessWalking = false, now = new Date(appNow()) }: PlanTripOptions,
  savedAt = Date.now(),
): ResumePlanRequest | null {
  const origin = endpointFor(endpoints.origin, endpoints.originPlace, location);
  if ('problem' in origin) return null;
  const destination = endpointFor(endpoints.destination, endpoints.destinationPlace, location);
  if ('problem' in destination) return null;
  const originReference = referenceFor(origin.endpoint, savedAt);
  const destinationReference = referenceFor(destination.endpoint, savedAt);
  if (!originReference || !destinationReference) return null;
  return {
    origin: originReference,
    destination: destinationReference,
    time: time.mode === 'now'
      ? { mode: 'depart', at: now.toISOString() }
      : { mode: time.mode, at: tripTimeAt(time, now).at },
    preference: preference === 'transfers' ? 'transfers' : 'fastest',
    modes: [...modes],
    ...(asksLessWalking(preference, lessWalking) ? { lessWalking: true as const } : {}),
  };
}

/**
 * Whether to plan with less walking: the Less walking sort, or walking turned off in Settings.
 * The fewer-transfers sort wins over it, so that sort's trips aren't cut short for walking.
 */
function asksLessWalking(preference: RoutePreference, lessWalking: boolean): boolean {
  return preference === 'walking' || (lessWalking && preference !== 'transfers');
}

/**
 * Real itineraries for the trip criteria from Pathly's own planner (the backend's planTrip,
 * from the agencies' timetables). Results are kept for two minutes in memory only, so moving
 * between results and a trip doesn't plan again; they're never stored, since itineraries go stale.
 */
export async function planTrip({ endpoints, location, time, preference, modes, ferry = true, lessWalking = false, walkOnlyMaxMinutes = null, refresh = false, now = new Date(appNow()) }: PlanTripOptions): Promise<TripPlanResult> {
  const origin = endpointFor(endpoints.origin, endpoints.originPlace, location);
  if ('problem' in origin) return { ok: false, problem: origin.problem, field: 'origin' };
  const destination = endpointFor(endpoints.destination, endpoints.destinationPlace, location);
  if ('problem' in destination) return { ok: false, problem: destination.problem === 'no-origin' ? 'needs-place' : destination.problem, field: 'destination' };

  const request: PlanTripRequest = {
    origin: origin.endpoint,
    destination: destination.endpoint,
    // The backend's "now" is real, so an admin's mock time goes as an explicit departure.
    time: time.mode === 'now' ? (isMockClock() ? { mode: 'depart', at: now.toISOString() } : { mode: 'now' }) : { mode: time.mode, at: tripTimeAt(time, now).at },
    // Lowest fare and fastest sort the same results; fewer transfers and less walking plan
    // differently.
    preference: preference === 'transfers' ? 'transfers' : 'fastest',
    modes: [...modes],
    ...(ferry ? {} : { ferry: false as const }),
    ...(asksLessWalking(preference, lessWalking) ? { lessWalking: true } : {}),
    // Walking turned off in Settings means no walk-only trip either.
    ...(walkOnlyMaxMinutes !== null && !lessWalking ? { walkOnlyMaxMinutes } : {}),
  };
  // Coordinate retention is based on when the device actually saved it, not the admin's mock
  // planning clock (which can deliberately be months in the past or future).
  const resumeRequest = createResumePlanRequest({ endpoints, location, time, preference, modes, lessWalking, now }, Date.now());
  if (!resumeRequest) return { ok: false, problem: 'needs-place' };
  const key = JSON.stringify({ ...request, minute: time.mode === 'now' ? Math.floor(now.getTime() / ONE_MINUTE_MS) : undefined });
  const cached = cache.get(key);
  if (!refresh && cached && now.getTime() - cached.at < CACHE_MS) return cached.result;

  let result: TripPlanResult;
  try {
    const { data } = await planTripCallable(request);
    result = { ok: true, itineraries: data.itineraries, fetchedAt: now.getTime(), resumeRequest };
  } catch (error) {
    const reason = (error as { details?: { reason?: string } } | null)?.details?.reason;
    return { ok: false, problem: reason === 'out-of-area' ? 'out-of-area' : 'unavailable' };
  }
  cache.set(key, { result, at: now.getTime() });
  return result;
}

const MAX_RESUME_VARIANTS = 512;

export type TripRestoreDiagnostic = {
  category: 'restored' | 'provider-unavailable' | 'candidate-absent' | 'selection-mismatch' | 'progress-anchor-mismatch';
  attempts?: number;
  candidates?: number;
  matchingIds?: number;
  variantsChecked?: number;
  variantLimitReached?: boolean;
  code?: string;
};

/** Protected admin diagnostics only: counts/categories, never endpoints or provider content. */
export function recordTripRestoreDiagnostic(diagnostic: TripRestoreDiagnostic, startedAt = Date.now()): void {
  recordRequest({
    name: 'restoreTrip', startedAt, ms: Date.now() - startedAt,
    ok: diagnostic.category === 'restored', request: null, responseSummary: diagnostic,
  });
}

/**
 * Candidate variants include client-retimed departures. The provider itinerary id is unchanged
 * by retiming, so id-only matching could otherwise restore the wrong train or bus.
 */
function exactResumeCandidate(itineraries: readonly Itinerary[], selection: TripSelectionIdentity) {
  let checked = 0;
  let matchingIds = 0;
  const answer = (itinerary: Itinerary | null) => ({ itinerary, candidates: itineraries.length, matchingIds, variantsChecked: checked, variantLimitReached: checked >= MAX_RESUME_VARIANTS });
  for (const itinerary of itineraries) {
    // Retiming never changes an itinerary id. Searching an unrelated route's departure product
    // cannot match, and used to exhaust the shared budget before reaching the selected route.
    if (itinerary.id !== selection.itineraryId) continue;
    matchingIds += 1;
    if (sameTripSelection(createTripSelectionIdentity(itinerary), selection)) return answer(itinerary);

    const legs = itinerary.steps.filter((step): step is TransitStep => step.kind === 'transit');
    const visit = (legIndex: number, choices: ReadonlyMap<number, string>): Itinerary | null => {
      if (checked >= MAX_RESUME_VARIANTS) return null;
      if (legIndex === legs.length) {
        checked += 1;
        // This is identity reconstruction, not a "can I still catch it now?" decision. A time
        // before the candidate keeps every stored departure eligible, including Arrive-by plans.
        const variant = retimeItinerary(itinerary, choices, Date.parse(itinerary.departureTime) - ONE_DAY_MS);
        return sameTripSelection(createTripSelectionIdentity(variant), selection) ? variant : null;
      }
      const leg = legs[legIndex]!;
      const departures = [...new Set([leg.from.time, ...(leg.departures ?? []).map((departure) => departure.departs)])];
      for (const departs of departures) {
        const found = visit(legIndex + 1, new Map(choices).set(legIndex, departs));
        if (found) return found;
      }
      return null;
    };
    const found = visit(0, new Map());
    if (found) return answer(found);
  }
  return answer(null);
}

/** Fresh planning for a persisted session. A merely similar route is never substituted. */
export async function planTripForResume(request: ResumePlanRequest, selection: TripSelectionIdentity, options: { isCurrent?: () => boolean } = {}): Promise<ResumePlanResult> {
  const startedAt = Date.now();
  let attempts = 0;
  let candidateCount = 0;
  let matchingIds = 0;
  let variantsChecked = 0;
  let variantLimitReached = false;
  const requestOwner = auth?.currentUser?.uid ?? null;
  const current = () => options.isCurrent?.() !== false && (auth?.currentUser?.uid ?? null) === requestOwner;
  try {
    const base = {
      origin: requestEndpoint(request.origin),
      destination: requestEndpoint(request.destination),
      preference: request.preference,
      modes: [...request.modes],
      ...(request.lessWalking ? { lessWalking: true } : {}),
      // A walk-only trip resumes too: it's planned again only to be matched exactly.
      ...(request.lessWalking ? {} : { walkOnlyMaxMinutes: MAX_WALK_ONLY_MINUTES }),
    };
    // Alternatives selected after the original search can be outside its new result window.
    // Make at most one bounded fresh search at that selected journey's original boundary.
    // This only broadens candidate retrieval: both responses still require exact identity.
    const selectedAt = request.time.mode === 'depart'
      ? selection.legacy?.departureTime ?? selection.departureTime
      : selection.legacy?.arrivalTime ?? selection.arrivalTime;
    const times = [request.time];
    if (Number.isFinite(Date.parse(selectedAt)) && Date.parse(selectedAt) !== Date.parse(request.time.at)) {
      times.push({ mode: request.time.mode, at: selectedAt });
    }
    for (const time of times) {
      if (!current()) return { ok: false, problem: 'unavailable' };
      attempts += 1;
      const { data } = await planTripCallable({ ...base, time });
      if (!current()) return { ok: false, problem: 'unavailable' };
      const matched = exactResumeCandidate(data.itineraries, selection);
      candidateCount += matched.candidates;
      matchingIds += matched.matchingIds;
      variantsChecked += matched.variantsChecked;
      variantLimitReached ||= matched.variantLimitReached;
      if (matched.itinerary) {
        recordTripRestoreDiagnostic({ category: 'restored', attempts, candidates: candidateCount, matchingIds, variantsChecked, variantLimitReached }, startedAt);
        return { ok: true, itinerary: matched.itinerary, fetchedAt: appNow() };
      }
    }
    recordTripRestoreDiagnostic({ category: matchingIds > 0 ? 'selection-mismatch' : 'candidate-absent', attempts, candidates: candidateCount, matchingIds, variantsChecked, variantLimitReached }, startedAt);
    return { ok: false, problem: 'no-exact-match' };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (current()) recordTripRestoreDiagnostic({ category: 'provider-unavailable', attempts, ...(typeof code === 'string' && /^[a-z/-]{1,64}$/.test(code) ? { code } : {}) }, startedAt);
    return { ok: false, problem: 'unavailable' };
  }
}

/** Test isolation only. */
/** Admin tools: forget every remembered plan, so the next one asks the backend again. */
export function clearTripPlanCache(): void {
  cache.clear();
}

export function resetTripPlanCacheForTests(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------------------------
// Ordering and filtering

const arrival = (itinerary: Itinerary) => Date.parse(itinerary.arrivalTime);

/** Itineraries in the rider's preferred order. */
export function orderItineraries(itineraries: readonly Itinerary[], preference: RoutePreference, fareType: FareType = 'full'): Itinerary[] {
  const cents = (fare: TripFare | undefined) => riderFare(fare, fareType)?.cents ?? fare?.cents ?? 0;
  const byArrival = (a: Itinerary, b: Itinerary) => arrival(a) - arrival(b);
  const sorted = [...itineraries];
  if (preference === 'transfers') return sorted.sort((a, b) => a.transfers - b.transfers || byArrival(a, b));
  if (preference === 'walking') return sorted.sort((a, b) => walkingSeconds(a) - walkingSeconds(b) || byArrival(a, b));
  if (preference === 'cheapest') {
    return sorted.sort((a, b) => (a.fare ? 0 : 1) - (b.fare ? 0 : 1) || cents(a.fare) - cents(b.fare) || byArrival(a, b));
  }
  return sorted.sort(byArrival);
}

/**
 * The modes a plan may ride, besides ferries (asked for on their own, `ferry` in planTrip's
 * options): empty when only Ferry is switched on.
 */
export function requestModes(enabled: readonly TransitMode[]): TripMode[] {
  return enabled.filter((mode): mode is TripMode => mode !== 'ferry');
}

/** The longest walk-only trip the backend plans. */
export const MAX_WALK_ONLY_MINUTES = 90;

/** A trip that walks the whole way, with no ride. */
export function isWalkOnly(itinerary: Itinerary): boolean {
  return itinerary.steps.every((step) => step.kind === 'walk');
}

/**
 * Drops walking the whole way when it's over the rider's cap (or the cap is off), as one planned
 * before the setting changed may be. Every trip with a ride is kept.
 */
export function filterWalkOnlyItineraries(itineraries: readonly Itinerary[], walkOnlyMaxMinutes: number | null): Itinerary[] {
  return itineraries.filter((itinerary) => !isWalkOnly(itinerary) || (walkOnlyMaxMinutes !== null && itinerary.durationSeconds <= walkOnlyMaxMinutes * 60));
}

/** Total walking in a trip, in seconds. */
export function walkingSeconds(itinerary: Itinerary): number {
  return itinerary.steps.reduce((total, step) => total + (step.kind === 'walk' ? step.durationSeconds : 0), 0);
}

/**
 * Trips within the rider's walking limit (Settings -> Travel preferences), or null when there's
 * no limit or no trip fits, so the caller can show every trip rather than none.
 */
export function filterItinerariesByWalk(itineraries: readonly Itinerary[], maxWalkMinutes: number | null): Itinerary[] | null {
  if (maxWalkMinutes === null) return null;
  // Walking the whole way has its own cap (filterWalkOnlyItineraries), so this limit is for trips with a ride.
  const withRide = itineraries.filter((itinerary) => !isWalkOnly(itinerary));
  const within = withRide.filter((itinerary) => walkingSeconds(itinerary) <= maxWalkMinutes * 60);
  return within.length > 0 ? [...within, ...itineraries.filter(isWalkOnly)] : null;
}

/** Itineraries that use only enabled modes (a plan from before a switch changed may not). */
export function filterItinerariesByMode(itineraries: readonly Itinerary[], modes: readonly TransitMode[]): Itinerary[] {
  return itineraries.filter((itinerary) => itinerary.steps.every((step) => step.kind !== 'transit' || step.mode === 'other' || modes.includes(step.mode)));
}

/**
 * One trip per route: a plan often has the same lines at several departure times (the next
 * train as well). Keeps each line sequence's first trip in the given order; the later departures
 * stay a tap away in that trip's departure picker.
 */
export function distinctRouteItineraries(itineraries: readonly Itinerary[]): Itinerary[] {
  const seen = new Set<string>();
  return itineraries.filter((itinerary) => {
    const key = transitSteps(itinerary).map((step) => `${step.agency.name}|${step.line.shortName || step.line.name}`).join('>') || 'walk';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function transitSteps(itinerary: Itinerary): TransitStep[] {
  return itinerary.steps.filter((step): step is TransitStep => step.kind === 'transit');
}

/** The fare as a card shows it: the rider's fare type where it's known, else the adult one-way fare from the published fare rules, or unknown. */
export function fareLabel(fare: TripFare | undefined, fareType: FareType = 'full'): string {
  if (!fare) return 'Fare N/A';
  return riderFare(fare, fareType)?.text ?? fare.text;
}

const LIRR_AGENCY = 'Long Island Rail Road';
const METRO_NORTH_AGENCY = /metro[\s-]*north|\bmnr\b/i;
const PATH_AGENCY = /^path$|port authority trans[\s-]*hudson/i;

/** The badge for a trip leg: LIRR branch codes ("PJ"), "N" for an "N Line", "51" for bus 51. */
export function lineBadge(step: TransitStep): string {
  if (step.agency.name === LIRR_AGENCY) return badgeLabel({ agency: 'LIRR', shortName: step.line.name });
  if (METRO_NORTH_AGENCY.test(step.agency.name)) return badgeLabel({ agency: 'Metro-North Railroad', shortName: step.line.shortName || step.line.name });
  // PATH's lines by their codes (NWK-WTC), as its signs and the line list name them. Google may
  // send the code, or only the line's name ("Newark - World Trade Center").
  if (PATH_AGENCY.test(step.agency.name.trim())) {
    const code = (step.line.shortName ?? '').trim();
    if (/^[A-Z0-9]+(-[A-Z0-9]+)+$/i.test(code)) return code.toUpperCase();
    return pathLineCode(step.line.name) ?? 'PATH';
  }
  const short = (step.line.shortName ?? '').replace(/\s+(Line|Train)$/i, '').trim();
  return badgeLabel({ agency: step.agency.name, shortName: short || step.line.name });
}

/** Where a leg's vehicle is headed, as riders read it ("33rd Street via Hoboken" for that PATH train). */
export function legHeadsign(step: TransitStep): string | undefined {
  const headsign = step.headsign?.trim();
  if (!headsign) return undefined;
  return isPathAgency(step.agency.name) ? pathHeadsign(headsign, step.line) : headsign;
}

/**
 * A leg's line in a sentence ("PJ is cancelled"). PATH's line codes are a timetable detail;
 * riders say "the PATH to 33rd Street", so that's what PATH legs say.
 */
export function lineInText(step: TransitStep): string {
  if (!isPathAgency(step.agency.name)) return lineBadge(step);
  const headsign = legHeadsign(step);
  return headsign ? `PATH to ${headsign}` : 'PATH';
}

/** The badge shape for a leg's mode; other vehicles (trams, cable cars) use the bus shape. */
export function badgeMode(step: TransitStep): TransitMode {
  return step.mode === 'other' ? 'bus' : step.mode;
}
