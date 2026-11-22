import type { transit_realtime } from 'gtfs-realtime-bindings';

import { sourceFreshness, timestampMilliseconds, type RealtimeFeed } from './gtfsRealtime';
import type { ResolvedTripRun, TripLegObservation, TripLiveReason, TripRunRef } from './tripLiveTypes';

type Update = transit_realtime.TripUpdate;
type StopUpdate = transit_realtime.StopTimeUpdate;

/** Only the subway's documented shortened IDs are aliases; another agency's suffix is not. */
function sameRunId(ref: TripRunRef, liveId: string): boolean {
  if (liveId === ref.tripId) return true;
  if (ref.agencyId !== 'subway' || !liveId) return false;
  if (ref.tripId.endsWith(`_${liveId}`)) return true;
  if (!/^\d{6}_[A-Za-z0-9]+\.\.[NS]$/.test(liveId)) return false;
  const index = ref.tripId.lastIndexOf(`_${liveId}`);
  return index >= 0 && /^\d+R$/.test(ref.tripId.slice(index + 1 + liveId.length));
}

export function unknownTripObservation(legKey: string, runRef: TripRunRef, reason: TripLiveReason): TripLegObservation {
  return { legKey, runRef, state: 'unknown', status: 'unavailable', observedAt: null, expiresAt: null, reason };
}

function ownsNumber(value: object, key: string): boolean {
  return Object.hasOwn(value, key) && Number.isInteger((value as Record<string, unknown>)[key]);
}

/** Repeated stop IDs require their real GTFS sequence, because feeds may drop earlier visits. */
function endpointUpdate(update: Update, run: ResolvedTripRun, use: 'board' | 'alight'): { stop?: StopUpdate; ambiguous: boolean } {
  const ref = run.runRef;
  const stopId = use === 'board' ? ref.boardStopId : ref.alightStopId;
  const occurrence = use === 'board' ? ref.boardOccurrence : ref.alightOccurrence;
  const target = run.stops.find((stop) => stop.stopId === stopId && stop.occurrence === occurrence);
  if (!target) return { ambiguous: true };
  const visits = run.stops.filter((stop) => stop.stopId === stopId).length;
  const matches: StopUpdate[] = [];
  let ambiguous = false;
  for (const stop of update.stopTimeUpdate ?? []) {
    if (ownsNumber(stop, 'stopSequence')) {
      if (target.stopSequence === undefined || stop.stopSequence !== target.stopSequence) continue;
      // A reassigned platform/stop is not silently treated as the selected boarding point.
      if (stop.stopId && stop.stopId !== stopId) { ambiguous = true; continue; }
      matches.push(stop);
    } else if (stop.stopId === stopId) {
      if (visits !== 1) ambiguous = true;
      else matches.push(stop);
    }
  }
  return { ...(matches.length === 1 ? { stop: matches[0] } : {}), ambiguous: ambiguous || matches.length > 1 };
}

/** Absolute event instants are predictions, not measurement timestamps or departure proof. */
function prediction(event: transit_realtime.StopTimeEvent | null | undefined, scheduled: string): string | undefined {
  if (!event) return undefined;
  const absolute = timestampMilliseconds(event.time);
  if (absolute !== null && Number.isFinite(new Date(absolute).getTime())) return new Date(absolute).toISOString();
  if (!ownsNumber(event, 'delay') || event.delay == null || Math.abs(event.delay) > 7 * 86_400) return undefined;
  const at = Date.parse(scheduled) + event.delay * 1000;
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/** Pure exact-run matcher, independently testable without static data, network or Firebase. */
export function observeSelectedRun(feeds: readonly RealtimeFeed[], run: ResolvedTripRun, legKey: string, nowMs = Date.now()): TripLegObservation {
  const ref = run.runRef;
  const unknown = (reason: TripLiveReason) => unknownTripObservation(legKey, ref, reason);
  const candidates: { update: Update; feed: RealtimeFeed; measured: number }[] = [];
  let missingDate = false;
  let unsupported = false;
  for (const feed of feeds) {
    for (const entity of feed.entities) {
      if (entity.isDeleted || !entity.tripUpdate) continue;
      const update = entity.tripUpdate;
      const descriptor = update.trip;
      if (!sameRunId(ref, descriptor.tripId ?? '')) continue;
      if (descriptor.routeId && descriptor.routeId !== ref.routeId) continue;
      if (ref.directionId !== undefined && ownsNumber(descriptor, 'directionId') && descriptor.directionId !== ref.directionId) continue;
      if (descriptor.startTime && descriptor.startTime !== ref.startTime) continue;
      if (!descriptor.startDate) { missingDate = true; continue; }
      if (descriptor.startDate !== ref.serviceDate) continue;
      if (feed.differential || ![0, 3, 7].includes(descriptor.scheduleRelationship ?? 0)) { unsupported = true; continue; }
      candidates.push({ update, feed, measured: timestampMilliseconds(update.timestamp) ?? feed.observedAt ?? 0 });
    }
  }
  if (candidates.length === 0) return unknown(missingDate ? 'ambiguous-run' : unsupported ? 'unsupported-feed' : 'not-found');
  if (unsupported) return unknown('unsupported-feed');
  candidates.sort((a, b) => b.measured - a.measured);
  const chosen = candidates[0]!;
  const tied = candidates.filter((candidate) => candidate.measured === chosen.measured);
  if (tied.some((candidate) => JSON.stringify(candidate.update) !== JSON.stringify(chosen.update))) return unknown('ambiguous-run');
  const { update, feed } = chosen;
  const freshness = sourceFreshness(feed.observedAt, timestampMilliseconds(update.timestamp), nowMs);
  if (freshness.state === 'unknown') return unknown(feed.observedAt === null && timestampMilliseconds(update.timestamp) === null ? 'missing-timestamp' : 'future-timestamp');
  const base = { legKey, runRef: ref, ...freshness, ...(freshness.state === 'stale' ? { reason: 'stale' as const } : {}) };
  if (update.trip.scheduleRelationship === 3 || update.trip.scheduleRelationship === 7) return { ...base, status: 'cancelled' };
  const board = endpointUpdate(update, run, 'board');
  const alight = endpointUpdate(update, run, 'alight');
  if (board.ambiguous || alight.ambiguous) return unknown('ambiguous-run');
  const boardSkipped = board.stop?.scheduleRelationship === 1;
  const alightSkipped = alight.stop?.scheduleRelationship === 1;
  if (boardSkipped || alightSkipped) return { ...base, status: 'skips-stop', ...(boardSkipped ? { boardSkipped: true } : {}), ...(alightSkipped ? { alightSkipped: true } : {}) };
  const departureNoData = board.stop?.scheduleRelationship === 2;
  const arrivalNoData = alight.stop?.scheduleRelationship === 2;
  const departs = departureNoData ? undefined : prediction(board.stop?.departure ?? board.stop?.arrival, run.departs);
  const arrives = arrivalNoData ? undefined : prediction(alight.stop?.arrival ?? alight.stop?.departure, run.arrives);
  if (!departs && !arrives && !departureNoData && !arrivalNoData) return { ...base, status: 'unavailable', reason: freshness.state === 'stale' ? 'stale' : 'no-prediction' };
  return {
    ...base,
    status: departs || arrives ? 'predicted' : 'no-data',
    ...(departs ? { departs, departureDelaySeconds: Math.round((Date.parse(departs) - Date.parse(run.departs)) / 1000) } : {}),
    ...(arrives ? { arrives, arrivalDelaySeconds: Math.round((Date.parse(arrives) - Date.parse(run.arrives)) / 1000) } : {}),
    ...(departureNoData ? { departureNoData: true } : {}),
    ...(arrivalNoData ? { arrivalNoData: true } : {}),
  };
}
