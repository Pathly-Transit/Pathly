import {
  advanceNavigation, guidanceForNavigation, NAVIGATION_THRESHOLDS, type ActiveTripRuntime, type NavigationCheckpoint,
  type NavigationCursor, type NavigationEvidence, type NavigationFix, type NavigationRouteSegment, type NormalizedNavigationPlan,
} from '../data/enrouteNavigation';
import { tripNotificationContent } from '../data/tripAnnouncements';
import type { TripLegObservation, TripLiveResponse } from '../data/tripLiveTypes';
import { parseTripRunRef, tripRunRefKey } from '../data/tripRunRef';

export const BACKGROUND_TRIP_MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_CHECKPOINTS = 2000;
const MAX_SEGMENTS = 100;
const FUTURE_FIX_ALLOWANCE_MS = 5_000;
export type TripAlertOwner = { uid: string; sessionId: string };
export type TripAlertState = TripAlertOwner & {
  version: 1;
  expiresAt: number;
  /** Operational stop/checkpoint anchors only, never a cached itinerary or route polyline. */
  plan: NormalizedNavigationPlan;
  cursor: NavigationCursor;
  evidence: NavigationEvidence | null;
  alertedSteps: number[];
  latestFixes: NavigationFix[];
  /** Active-session-only cache. Source expiry is never extended by reading or syncing it. */
  liveStatus?: TripLiveResponse;
  lastStatusAttemptAt?: number;
  lastProgressContent?: string;
};
export const sameTripAlertOwner = (a: TripAlertOwner | null, b: TripAlertOwner) => a?.uid === b.uid && a?.sessionId === b.sessionId;

const copyPoint = (point: { lat: number; lng: number }) => ({ lat: point.lat, lng: point.lng });
const pointKey = (point: { lat: number; lng: number }) => point.lat + ',' + point.lng;
const pointValid = (point: { lat?: unknown; lng?: unknown } | null | undefined) => Boolean(point
  && typeof point.lat === 'number' && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
  && typeof point.lng === 'number' && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180);
const integer = (value: unknown, max: number) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
const text = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length <= max;
const time = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));
const realFixValid = (fix: NavigationFix) => fix?.source === 'real' && pointValid(fix.point)
  && typeof fix.accuracyMeters === 'number' && Number.isFinite(fix.accuracyMeters)
  && fix.accuracyMeters >= 0 && fix.accuracyMeters <= NAVIGATION_THRESHOLDS.maxUsableAccuracyMeters
  && Number.isFinite(fix.capturedAt) && fix.capturedAt >= 0;
const fresh = (capturedAt: number, now: number) => capturedAt <= now + FUTURE_FIX_ALLOWANCE_MS
  && now - capturedAt <= NAVIGATION_THRESHOLDS.maxRealFixAgeMs;
const copyFix = (fix: NavigationFix): NavigationFix => ({
  point: copyPoint(fix.point), capturedAt: fix.capturedAt, accuracyMeters: fix.accuracyMeters, source: 'real',
});

/** Run keys are compact operational identity, with the same strict fields as a selected native run. */
function canonicalRunKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const fields: unknown = JSON.parse(value);
    if (!Array.isArray(fields) || fields.length !== 14) return null;
    const ref = parseTripRunRef({ version: fields[0], agencyId: fields[1], scheduleVersion: fields[2], serviceDate: fields[3],
      tripId: fields[4], startTime: fields[5], routeId: fields[6], ...(fields[7] === null ? {} : { directionId: fields[7] }),
      boardStopId: fields[8], boardOccurrence: fields[9], ...(fields[10] === null ? {} : { boardStopSequence: fields[10] }),
      alightStopId: fields[11], alightOccurrence: fields[12], ...(fields[13] === null ? {} : { alightStopSequence: fields[13] }) });
    return ref && tripRunRefKey(ref) === value ? value : null;
  } catch { return null; }
}

function copyCheckpoint(point: NavigationCheckpoint): NavigationCheckpoint {
  return {
    ordinal: point.ordinal, key: point.key, kind: point.kind, point: copyPoint(point.point), label: point.label,
    stepIndex: point.stepIndex, phase: point.phase, pathIndex: point.pathIndex,
    ...(point.time === undefined ? {} : { time: point.time }),
    ...(point.transitLegIndex === undefined ? {} : { transitLegIndex: point.transitLegIndex }),
    ...(point.transitStopIndex === undefined ? {} : { transitStopIndex: point.transitStopIndex }),
  };
}
function copySegment(segment: NavigationRouteSegment): NavigationRouteSegment {
  const runKey = segment.kind === 'transit' ? canonicalRunKey(segment.runKey) : null;
  return {
    stepIndex: segment.stepIndex, kind: segment.kind, path: segment.path.map(copyPoint),
    startCheckpointOrdinal: segment.startCheckpointOrdinal, endCheckpointOrdinal: segment.endCheckpointOrdinal,
    toName: segment.toName, durationSeconds: segment.durationSeconds,
    ...(segment.transitLegIndex === undefined ? {} : { transitLegIndex: segment.transitLegIndex }),
    ...(runKey ? { runKey } : {}),
    ...(segment.line ? { line: { name: segment.line.name, ...(segment.line.shortName === undefined ? {} : { shortName: segment.line.shortName }) } } : {}),
    ...(segment.headsign === undefined ? {} : { headsign: segment.headsign }),
    ...(segment.departureTime === undefined ? {} : { departureTime: segment.departureTime }),
    ...(segment.arrivalTime === undefined ? {} : { arrivalTime: segment.arrivalTime }),
    ...(segment.knownStopCount === undefined ? {} : { knownStopCount: segment.knownStopCount }),
    ...(segment.distanceMeters === undefined ? {} : { distanceMeters: segment.distanceMeters }),
  };
}
function copyPlan(plan: NormalizedNavigationPlan): NormalizedNavigationPlan {
  return {
    itineraryId: plan.itineraryId,
    selection: {
      version: plan.selection.version, itineraryId: plan.selection.itineraryId, departureTime: plan.selection.departureTime,
      arrivalTime: plan.selection.arrivalTime, fingerprint: plan.selection.fingerprint,
    },
    checkpoints: plan.checkpoints.map(copyCheckpoint), segments: plan.segments.map(copySegment),
    departureTime: plan.departureTime, arrivalTime: plan.arrivalTime, destinationName: plan.destinationName,
  };
}
function cursorAt(plan: NormalizedNavigationPlan, cursor: NavigationCursor, ordinal: number): NavigationCursor {
  const checkpoint = plan.checkpoints[ordinal]!;
  const segment = plan.segments.find((item) => item.stepIndex === checkpoint.stepIndex);
  const nextStopIndex = cursor.phase === 'riding' && checkpoint.transitStopIndex !== undefined
    ? checkpoint.transitStopIndex + 1
    : cursor.phase === 'waiting-to-board' && (segment?.knownStopCount ?? 0) > 0 ? 0 : undefined;
  return {
    checkpointOrdinal: ordinal, stepIndex: checkpoint.stepIndex, phase: cursor.phase, lastAdvancedAt: cursor.lastAdvancedAt,
    ...(nextStopIndex === undefined ? {} : { nextStopIndex }),
  };
}
function usableEvidence(state: Pick<TripAlertState, 'plan' | 'cursor' | 'evidence' | 'latestFixes'>, now: number): NavigationEvidence | null {
  const evidence = state.evidence;
  const lastFix = state.latestFixes.at(-1);
  if (!evidence || !lastFix || !fresh(evidence.lastFixAt, now) || evidence.lastFixAt !== lastFix.capturedAt
    || pointKey(evidence.lastPoint) !== pointKey(lastFix.point)) return null;
  const recomputed = advanceNavigation(state.plan, state.cursor, lastFix, null, now).evidence;
  return recomputed?.candidateKey === evidence.candidateKey ? recomputed : null;
}

/** Keep only operational anchors; even path endpoints come from checkpoints, not provider polylines. */
export function tripAlertState(runtime: ActiveTripRuntime, previous: TripAlertState | null = null, now = Date.now()): TripAlertState {
  const original = runtime.plan;
  const retained = original.checkpoints.filter((point) => point.kind !== 'walk');
  const checkpoints = retained.map((point, ordinal) => ({
    ...copyCheckpoint(point), ordinal, pathIndex: 0,
    // Walking geometry can add/remove original ordinals while the selected trip stays unchanged.
    key: point.kind + ':' + point.stepIndex + ':' + (point.transitStopIndex ?? '-') + ':'
      + point.point.lat.toFixed(6) + ':' + point.point.lng.toFixed(6),
  }));
  const segments = original.segments.map((segment) => {
    const start = Math.max(0, retained.findLastIndex((point) => point.ordinal <= segment.startCheckpointOrdinal));
    const after = retained.findIndex((point) => point.ordinal >= segment.endCheckpointOrdinal);
    const end = Math.max(start, after < 0 ? checkpoints.length - 1 : after);
    const points = checkpoints.slice(start, end + 1).map((point) => copyPoint(point.point))
      .filter((point, index, all) => index === 0 || pointKey(point) !== pointKey(all[index - 1]!));
    for (let index = start; index <= end; index += 1) {
      const checkpoint = checkpoints[index]!;
      if (checkpoint.stepIndex === segment.stepIndex) checkpoint.pathIndex = Math.max(0, points.findIndex((point) => pointKey(point) === pointKey(checkpoint.point)));
    }
    return { ...copySegment(segment), path: points, startCheckpointOrdinal: start, endCheckpointOrdinal: end };
  });
  let plan = copyPlan({ ...original, checkpoints, segments });
  const ordinal = Math.max(0, retained.findLastIndex((point) => point.ordinal <= runtime.cursor.checkpointOrdinal));
  let cursor = cursorAt(plan, runtime.cursor, ordinal);
  const sameSession = previous && previous.expiresAt > now && sameTripAlertOwner(previous, runtime);
  const owned = sameSession && previous.plan.selection.fingerprint === runtime.selection.fingerprint;
  const claimedRuns = new Set(sameSession ? previous.plan.segments.filter((segment) => segment.kind === 'transit'
    && previous.alertedSteps.includes(segment.stepIndex)).map((segment) => canonicalRunKey(segment.runKey)).filter((key) => key !== null) : []);
  const alertedSteps = owned ? [...previous.alertedSteps] : sameSession ? plan.segments.filter((segment) => segment.kind === 'transit'
    && segment.runKey !== undefined && claimedRuns.has(segment.runKey)).map((segment) => segment.stepIndex) : [];
  let evidence: NavigationEvidence | null = null;
  const latestFixes = owned ? previous.latestFixes.filter((fix) => realFixValid(fix) && fresh(fix.capturedAt, now)).map(copyFix) : [];
  if (owned) {
    const oldKey = previous.plan.checkpoints[previous.cursor.checkpointOrdinal]?.key;
    const mapped = plan.checkpoints.findIndex((point) => point.key === oldKey);
    if (mapped < 0) {
      // Changed enrichment cannot justify moving proven progress backwards or guessing a jump.
      plan = copyPlan(previous.plan);
      cursor = { ...previous.cursor };
      evidence = previous.evidence;
    } else {
      const oldCursor = cursorAt(plan, previous.cursor, mapped);
      if (mapped > cursor.checkpointOrdinal || (mapped === cursor.checkpointOrdinal
        && (oldCursor.phase === cursor.phase || (oldCursor.phase === 'riding' && cursor.phase === 'waiting-to-board')))) {
        cursor = { ...oldCursor, lastAdvancedAt: Math.max(oldCursor.lastAdvancedAt, cursor.lastAdvancedAt) };
        if (previous.evidence) {
          const match = /^(checkpoint|phase):(\d+):([^:]+)$/.exec(previous.evidence.candidateKey);
          const oldTarget = match ? previous.plan.checkpoints[Number(match[2])]?.key : undefined;
          const target = plan.checkpoints.findIndex((point) => point.key === oldTarget);
          if (match && target >= 0) evidence = { ...previous.evidence, candidateKey: match[1] + ':' + target + ':' + match[3] };
        }
      }
    }
  }
  const result: TripAlertState = {
    version: 1, uid: runtime.uid, sessionId: runtime.sessionId,
    expiresAt: owned ? Math.min(previous.expiresAt, runtime.startedAt + BACKGROUND_TRIP_MAX_AGE_MS) : runtime.startedAt + BACKGROUND_TRIP_MAX_AGE_MS,
    plan, cursor, evidence, alertedSteps, latestFixes,
    ...(owned && previous.lastStatusAttemptAt !== undefined ? { lastStatusAttemptAt: previous.lastStatusAttemptAt } : {}),
    ...(owned && previous.liveStatus ? { liveStatus: previous.liveStatus } : {}),
    ...(owned && previous.lastProgressContent ? { lastProgressContent: previous.lastProgressContent } : {}),
  };
  result.evidence = usableEvidence(result, now);
  return result;
}

/** Persist only the bounded live wire fields, never attached responses or route geometry. */
export function parseBackgroundLiveStatus(value: unknown, now = Date.now()): TripLiveResponse | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as TripLiveResponse;
  if (response.version !== 1 || !Number.isFinite(response.fetchedAt) || response.fetchedAt < 0
    || response.fetchedAt > now + 30_000 || now - response.fetchedAt > BACKGROUND_TRIP_MAX_AGE_MS
    || !Array.isArray(response.legs) || response.legs.length > 12) return null;
  const legs: TripLegObservation[] = [];
  const keys = new Set<string>();
  for (const leg of response.legs) {
    const ref = parseTripRunRef(leg?.runRef);
    if (!leg || !ref || !text(leg.legKey, 128) || !/^\d{1,2}$/.test(leg.legKey) || keys.has(leg.legKey)
      || response.legs.filter((candidate) => candidate?.legKey === leg.legKey).length !== 1
      || !['fresh', 'stale', 'unknown'].includes(leg.state)
      || !['predicted', 'cancelled', 'skips-stop', 'no-data', 'unavailable'].includes(leg.status)
      || (leg.observedAt !== null && (!Number.isFinite(leg.observedAt) || leg.observedAt < 0 || leg.observedAt > now + 30_000))
      || (leg.expiresAt !== null && (!Number.isFinite(leg.expiresAt) || leg.observedAt === null || leg.expiresAt < leg.observedAt || leg.expiresAt - leg.observedAt > 90_000))
      || (leg.departs !== undefined && !time(leg.departs)) || (leg.arrives !== undefined && !time(leg.arrives))
      || (leg.departs && leg.arrives && Date.parse(leg.arrives) < Date.parse(leg.departs))
      || [leg.departureNoData, leg.arrivalNoData, leg.boardSkipped, leg.alightSkipped, leg.departureInferred, leg.arrivalInferred].some((flag) => flag !== undefined && typeof flag !== 'boolean')) continue;
    keys.add(leg.legKey);
    const state = leg.state === 'fresh' && leg.observedAt !== null && leg.expiresAt !== null && leg.expiresAt > now
      && now - leg.observedAt <= 90_000 ? 'fresh' : leg.observedAt !== null ? 'stale' : 'unknown';
    legs.push({ legKey: leg.legKey, runRef: ref, state, status: leg.status, observedAt: leg.observedAt, expiresAt: leg.expiresAt,
      ...(leg.departs ? { departs: leg.departs } : {}), ...(leg.arrives ? { arrives: leg.arrives } : {}),
      ...(typeof leg.departureDelaySeconds === 'number' && Number.isFinite(leg.departureDelaySeconds) ? { departureDelaySeconds: leg.departureDelaySeconds } : {}),
      ...(typeof leg.arrivalDelaySeconds === 'number' && Number.isFinite(leg.arrivalDelaySeconds) ? { arrivalDelaySeconds: leg.arrivalDelaySeconds } : {}),
      ...(leg.departureNoData !== undefined ? { departureNoData: leg.departureNoData } : {}),
      ...(leg.arrivalNoData !== undefined ? { arrivalNoData: leg.arrivalNoData } : {}),
      ...(leg.boardSkipped !== undefined ? { boardSkipped: leg.boardSkipped } : {}),
      ...(leg.alightSkipped !== undefined ? { alightSkipped: leg.alightSkipped } : {}),
      ...(leg.departureInferred !== undefined ? { departureInferred: leg.departureInferred } : {}),
      ...(leg.arrivalInferred !== undefined ? { arrivalInferred: leg.arrivalInferred } : {}),
    });
  }
  return { version: 1, fetchedAt: response.fetchedAt, legs };
}

const phases = new Set(['walking', 'waiting-to-board', 'riding', 'transferring', 'arrived']);
const kinds = new Set(['start', 'board', 'transit-stop', 'alight', 'destination']);
function planValid(plan: NormalizedNavigationPlan): boolean {
  if (!plan || !text(plan.itineraryId, 256) || !plan.itineraryId || !text(plan.destinationName)
    || !time(plan.departureTime) || !time(plan.arrivalTime) || !plan.selection
    || ![1, 2].includes(plan.selection.version) || plan.selection.itineraryId !== plan.itineraryId
    || !time(plan.selection.departureTime) || !time(plan.selection.arrivalTime)
    || !/^v[12]-[a-f0-9]{32}$/.test(plan.selection.fingerprint)
    || !Array.isArray(plan.checkpoints) || !plan.checkpoints.length || plan.checkpoints.length > MAX_CHECKPOINTS
    || !Array.isArray(plan.segments) || !plan.segments.length || plan.segments.length > MAX_SEGMENTS) return false;
  const keys = new Set<string>();
  for (const [index, checkpoint] of plan.checkpoints.entries()) {
    if (!checkpoint || checkpoint.ordinal !== index || !text(checkpoint.key, 256) || !checkpoint.key || keys.has(checkpoint.key)
      || !kinds.has(checkpoint.kind) || !phases.has(checkpoint.phase) || !pointValid(checkpoint.point)
      || !text(checkpoint.label) || !integer(checkpoint.stepIndex, MAX_SEGMENTS - 1) || !integer(checkpoint.pathIndex, MAX_CHECKPOINTS)
      || (checkpoint.time !== undefined && !time(checkpoint.time))
      || (checkpoint.transitLegIndex !== undefined && !integer(checkpoint.transitLegIndex, MAX_SEGMENTS - 1))
      || (checkpoint.transitStopIndex !== undefined && !integer(checkpoint.transitStopIndex, MAX_CHECKPOINTS))) return false;
    if ((checkpoint.kind === 'board' && checkpoint.phase !== 'waiting-to-board')
      || (checkpoint.kind === 'transit-stop' && checkpoint.phase !== 'riding')
      || (checkpoint.kind === 'destination' && checkpoint.phase !== 'arrived')
      || (checkpoint.kind === 'start' && checkpoint.phase !== 'walking' && checkpoint.phase !== 'transferring')
      || (checkpoint.kind === 'alight' && checkpoint.phase !== 'walking' && checkpoint.phase !== 'transferring')) return false;
    keys.add(checkpoint.key);
  }
  const anchors = new Set(plan.checkpoints.map((checkpoint) => pointKey(checkpoint.point)));
  let pathPoints = 0;
  let lastStep = -1;
  for (const segment of plan.segments) {
    if (!segment || !integer(segment.stepIndex, MAX_SEGMENTS - 1) || segment.stepIndex <= lastStep
      || !['walk', 'transit'].includes(segment.kind) || !integer(segment.startCheckpointOrdinal, plan.checkpoints.length - 1)
      || !integer(segment.endCheckpointOrdinal, plan.checkpoints.length - 1) || segment.endCheckpointOrdinal < segment.startCheckpointOrdinal
      || !Array.isArray(segment.path) || !segment.path.length || segment.path.length > MAX_CHECKPOINTS
      || segment.path.some((point) => !pointValid(point) || !anchors.has(pointKey(point)))
      || pointKey(segment.path[0]!) !== pointKey(plan.checkpoints[segment.startCheckpointOrdinal]!.point)
      || pointKey(segment.path.at(-1)!) !== pointKey(plan.checkpoints[segment.endCheckpointOrdinal]!.point)
      || !text(segment.toName) || !Number.isFinite(segment.durationSeconds) || segment.durationSeconds < 0 || segment.durationSeconds > 7 * 24 * 3600
      || (segment.distanceMeters !== undefined && (!Number.isFinite(segment.distanceMeters) || segment.distanceMeters < 0 || segment.distanceMeters > 2_000_000))
      || (segment.transitLegIndex !== undefined && !integer(segment.transitLegIndex, MAX_SEGMENTS - 1))
      || (segment.runKey !== undefined && (segment.kind !== 'transit' || !canonicalRunKey(segment.runKey)))
      || (segment.departureTime !== undefined && !time(segment.departureTime))
      || (segment.arrivalTime !== undefined && !time(segment.arrivalTime))
      || (segment.headsign !== undefined && !text(segment.headsign))
      || (segment.line !== undefined && (!segment.line || !text(segment.line.name) || (segment.line.shortName !== undefined && !text(segment.line.shortName, 100))))
      || (segment.knownStopCount !== undefined && (segment.kind !== 'transit' || !integer(segment.knownStopCount, MAX_CHECKPOINTS)
        || segment.knownStopCount !== plan.checkpoints.filter((point) => point.stepIndex === segment.stepIndex && point.kind === 'transit-stop').length))) return false;
    pathPoints += segment.path.length;
    if (pathPoints > plan.checkpoints.length + 2 * plan.segments.length) return false;
    lastStep = segment.stepIndex;
  }
  return plan.checkpoints.every((checkpoint) => {
    const segment = plan.segments.find((item) => item.stepIndex === checkpoint.stepIndex);
    return segment && checkpoint.ordinal >= segment.startCheckpointOrdinal && checkpoint.ordinal <= segment.endCheckpointOrdinal
      && checkpoint.pathIndex < segment.path.length && pointKey(segment.path[checkpoint.pathIndex]!) === pointKey(checkpoint.point);
  });
}

export function parseTripAlertState(raw: string | null, now = Date.now()): TripAlertState | null {
  try {
    if (!raw || raw.length > 1_500_000) return null;
    const value = JSON.parse(raw) as TripAlertState;
    if (!value || value.version !== 1 || !text(value.uid, 128) || !value.uid || !text(value.sessionId, 256) || !value.sessionId
      || !Number.isFinite(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + BACKGROUND_TRIP_MAX_AGE_MS
      || !planValid(value.plan) || !value.cursor || !integer(value.cursor.checkpointOrdinal, value.plan.checkpoints.length - 1)
      || !phases.has(value.cursor.phase) || !Number.isFinite(value.cursor.lastAdvancedAt)
      || value.cursor.lastAdvancedAt < 0 || value.cursor.lastAdvancedAt > now + FUTURE_FIX_ALLOWANCE_MS
      || !Array.isArray(value.alertedSteps) || value.alertedSteps.length > MAX_SEGMENTS || new Set(value.alertedSteps).size !== value.alertedSteps.length
      || value.alertedSteps.some((step) => !integer(step, MAX_SEGMENTS - 1) || !value.plan.segments.some((segment) => segment.kind === 'transit' && segment.stepIndex === step))
      || !Array.isArray(value.latestFixes) || value.latestFixes.length > 2
      || (value.lastStatusAttemptAt !== undefined && (!Number.isFinite(value.lastStatusAttemptAt) || value.lastStatusAttemptAt < 0 || value.lastStatusAttemptAt > now + FUTURE_FIX_ALLOWANCE_MS))
      || (value.lastProgressContent !== undefined && !text(value.lastProgressContent, 4000))
      || value.latestFixes.some((fix, index) => !realFixValid(fix) || fix.capturedAt > now + FUTURE_FIX_ALLOWANCE_MS
        || fix.capturedAt < value.expiresAt - BACKGROUND_TRIP_MAX_AGE_MS
        || (index > 0 && fix.capturedAt <= value.latestFixes[index - 1]!.capturedAt))) return null;
    const checkpoint = value.plan.checkpoints[value.cursor.checkpointOrdinal]!;
    if (value.cursor.stepIndex !== checkpoint.stepIndex || (value.cursor.phase !== checkpoint.phase
      && !(checkpoint.kind === 'board' && value.cursor.phase === 'riding'))
      || (value.cursor.nextStopIndex !== undefined && !integer(value.cursor.nextStopIndex, MAX_CHECKPOINTS))) return null;
    if (value.evidence && (!pointValid(value.evidence.lastPoint) || !Number.isFinite(value.evidence.lastFixAt)
      || value.evidence.lastFixAt < 0 || value.evidence.lastFixAt > now + FUTURE_FIX_ALLOWANCE_MS
      || value.evidence.confirmations !== 1 || !text(value.evidence.candidateKey, 256))) return null;
    const result: TripAlertState = {
      version: 1, uid: value.uid, sessionId: value.sessionId, expiresAt: value.expiresAt, plan: copyPlan(value.plan),
      cursor: cursorAt(value.plan, value.cursor, value.cursor.checkpointOrdinal), evidence: value.evidence,
      alertedSteps: [...value.alertedSteps], latestFixes: value.latestFixes.filter((fix) => fresh(fix.capturedAt, now)).map(copyFix),
      ...(value.lastStatusAttemptAt !== undefined ? { lastStatusAttemptAt: value.lastStatusAttemptAt } : {}),
      ...(value.lastProgressContent ? { lastProgressContent: value.lastProgressContent } : {}),
    };
    const liveStatus = parseBackgroundLiveStatus(value.liveStatus, now);
    if (liveStatus) result.liveStatus = liveStatus;
    result.evidence = usableEvidence(result, now);
    return result;
  } catch { return null; }
}

export type BackgroundTripUpdate = {
  state: TripAlertState;
  notification: { title: string; body: string; alert: boolean } | null;
  /** The native serialized sender commits this claim only after the OS accepts scheduling. */
  approachStep: number | null;
  finished: boolean;
};

/** Real, fresh ordered fixes only. A batch must not announce an approach its newest fix passed. */
export function advanceTripAlerts(current: TripAlertState, fixes: readonly NavigationFix[], now = Date.now()): BackgroundTripUpdate {
  let state = {
    ...current, evidence: usableEvidence(current, now),
    latestFixes: current.latestFixes.filter((fix) => fresh(fix.capturedAt, now)).map(copyFix), alertedSteps: [...current.alertedSteps],
  };
  if (state.expiresAt <= now) return { state, notification: null, approachStep: null, finished: true };
  const before = guidanceForNavigation(state.plan, state.cursor);
  const latestAt = current.latestFixes.at(-1)?.capturedAt ?? -Infinity;
  let accepted = 0;
  let onRoute = false;
  for (const fix of [...fixes].sort((a, b) => a.capturedAt - b.capturedAt)) {
    if (fix.source !== 'real' || !Number.isFinite(fix.capturedAt) || fix.capturedAt <= Math.max(latestAt, state.latestFixes.at(-1)?.capturedAt ?? -Infinity)
      || fix.capturedAt < state.expiresAt - BACKGROUND_TRIP_MAX_AGE_MS
      || fix.capturedAt > now + FUTURE_FIX_ALLOWANCE_MS) continue;
    if (!realFixValid(fix) || !fresh(fix.capturedAt, now)) { state.evidence = null; continue; }
    if (state.evidence && fix.capturedAt - state.evidence.lastFixAt > NAVIGATION_THRESHOLDS.maxRealFixAgeMs) state.evidence = null;
    const movement = advanceNavigation(state.plan, state.cursor, fix, state.evidence, now);
    state = { ...state, cursor: movement.cursor, evidence: movement.evidence, latestFixes: [...state.latestFixes, copyFix(fix)].slice(-2) };
    accepted += 1;
    onRoute = movement.locationState === 'current';
  }
  const next = guidanceForNavigation(state.plan, state.cursor);
  const approachStep = accepted > 0 && onRoute && next.phase === 'riding' && next.remainingStops === 1
    && !state.alertedSteps.includes(state.cursor.stepIndex) ? state.cursor.stepIndex : null;
  const changed = JSON.stringify(tripNotificationContent(before)) !== JSON.stringify(tripNotificationContent(next));
  return {
    state, approachStep, notification: changed || approachStep !== null ? { ...tripNotificationContent(next), alert: approachStep !== null } : null,
    finished: next.phase === 'arrived',
  };
}
