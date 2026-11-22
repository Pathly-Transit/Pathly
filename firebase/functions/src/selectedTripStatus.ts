import { HttpsError } from 'firebase-functions/v2/https';

import { AGENCY_CONFIGS, agencyConfig, type AgencyId } from './gtfsAgencies';
import { fetchRealtimeFeed, type RealtimeFeed } from './gtfsRealtime';
import { observeSelectedRun, unknownTripObservation } from './tripLiveSelection';
import type { ResolvedTripRun, TripLiveRequest, TripLiveResponse, TripRunRef } from './tripLiveTypes';
import { resolveSelectedRun } from './tripRunSchedule';

export const MAX_SELECTED_TRIP_LEGS = 12;
const SELECTED_STATUS_BUDGET_MS = 2_500;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpsError('invalid-argument', 'A versioned selected trip is required.');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new HttpsError('invalid-argument', `${name} must be a nonempty string of at most ${max} characters.`);
  return value;
}

function integer(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) throw new HttpsError('invalid-argument', `${name} is out of range.`);
  return value;
}

/** Only identity is accepted; client-supplied scheduled/predicted times are never trusted. */
export function parseTripLiveRequest(value: unknown): TripLiveRequest {
  const data = record(value);
  if (data.version !== 1 || !Array.isArray(data.legs) || data.legs.length < 1 || data.legs.length > MAX_SELECTED_TRIP_LEGS) {
    throw new HttpsError('invalid-argument', `version 1 and 1 to ${MAX_SELECTED_TRIP_LEGS} selected legs are required.`);
  }
  const keys = new Set<string>();
  const legs = data.legs.map((entry) => {
    const leg = record(entry);
    const legKey = text(leg.legKey, 'legKey', 128);
    if (keys.has(legKey)) throw new HttpsError('invalid-argument', 'legKey must be unique.');
    keys.add(legKey);
    const ref = record(leg.runRef);
    const agencyId = text(ref.agencyId, 'agencyId', 32);
    if (ref.version !== 1 || !Object.hasOwn(AGENCY_CONFIGS, agencyId)) throw new HttpsError('invalid-argument', 'runRef version or agency is unsupported.');
    const serviceDate = text(ref.serviceDate, 'serviceDate', 8);
    if (!/^\d{8}$/.test(serviceDate)) throw new HttpsError('invalid-argument', 'serviceDate must be YYYYMMDD.');
    const day = new Date(`${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6)}T12:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10).replaceAll('-', '') !== serviceDate) throw new HttpsError('invalid-argument', 'serviceDate must be a real date.');
    const startTime = text(ref.startTime, 'startTime', 9);
    if (!/^\d{2,3}:[0-5]\d:[0-5]\d$/.test(startTime) || Number(startTime.split(':')[0]) > 167) throw new HttpsError('invalid-argument', 'startTime must be a GTFS clock time.');
    const runRef: TripRunRef = {
      version: 1, agencyId: agencyId as AgencyId,
      routeId: text(ref.routeId, 'routeId'), tripId: text(ref.tripId, 'tripId', 512),
      serviceDate, scheduleVersion: text(ref.scheduleVersion, 'scheduleVersion'), startTime,
      boardStopId: text(ref.boardStopId, 'boardStopId'), alightStopId: text(ref.alightStopId, 'alightStopId'),
      boardOccurrence: integer(ref.boardOccurrence, 'boardOccurrence', 10_000),
      alightOccurrence: integer(ref.alightOccurrence, 'alightOccurrence', 10_000),
      ...(ref.boardStopSequence !== undefined ? { boardStopSequence: integer(ref.boardStopSequence, 'boardStopSequence', 0xffff_ffff) } : {}),
      ...(ref.alightStopSequence !== undefined ? { alightStopSequence: integer(ref.alightStopSequence, 'alightStopSequence', 0xffff_ffff) } : {}),
      ...(ref.directionId !== undefined ? { directionId: integer(ref.directionId, 'directionId', 1) } : {}),
    };
    return { legKey, runRef };
  });
  return { version: 1, legs };
}

async function selectedFeeds(ref: TripRunRef): Promise<RealtimeFeed[]> {
  const config = agencyConfig(ref.agencyId);
  if (config.liveFeedSecret !== undefined && !process.env[config.liveFeedSecret]) throw new Error('Live feed is not configured.');
  const requests = config.feedRequestsForRoute(ref.routeId);
  return Promise.all(requests.map(({ url, headers }) => fetchRealtimeFeed(url, headers)));
}

type SelectedStatusDependencies = {
  resolveRun?: (ref: TripRunRef) => Promise<ResolvedTripRun | null>;
  feedsFor?: (ref: TripRunRef) => Promise<RealtimeFeed[]>;
  unavailableAgencies?: ReadonlySet<AgencyId>;
  nowMs?: number;
  budgetMs?: number;
};

/** Batched status for chosen runs only: never searches alternatives or changes a journey. */
export async function selectedTripStatus(request: TripLiveRequest, { resolveRun = resolveSelectedRun, feedsFor = selectedFeeds, unavailableAgencies, nowMs, budgetMs = SELECTED_STATUS_BUDGET_MS }: SelectedStatusDependencies = {}): Promise<TripLiveResponse> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); });
  const legs = await Promise.all(request.legs.map(async ({ legKey, runRef }) => {
    const work = (async () => {
      if (unavailableAgencies?.has(runRef.agencyId)) return unknownTripObservation(legKey, runRef, 'feed-unavailable');
      const run = await resolveRun(runRef);
      if (!run) return unknownTripObservation(legKey, runRef, 'schedule-mismatch');
      const feeds = await feedsFor(runRef);
      return feeds.length === 0 ? unknownTripObservation(legKey, runRef, 'unsupported-feed') : observeSelectedRun(feeds, run, legKey, nowMs ?? Date.now());
    })().catch(() => unknownTripObservation(legKey, runRef, 'feed-unavailable'));
    return Promise.race([work, deadline.then(() => unknownTripObservation(legKey, runRef, 'timeout'))]);
  }));
  if (timer) clearTimeout(timer);
  return { version: 1, fetchedAt: nowMs ?? Date.now(), legs };
}
