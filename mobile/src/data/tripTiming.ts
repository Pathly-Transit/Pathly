import type { NavigationCursor, NormalizedNavigationPlan } from './enrouteNavigation';
import type { Itinerary, TransitStep, TripStep } from './tripPlanning';
import type { TripLegObservation, TripLiveRequest, TripLiveResponse, TripRunRef } from './tripLiveTypes';
import { parseTripRunRef, sameTripRunRef } from './tripRunRef';

export type TripTimingConfidence = 'scheduled' | 'estimated' | 'live' | 'stale' | 'unavailable';
export type TripConnectionTiming = {
  fromStepIndex: number;
  toStepIndex: number;
  status: 'feasible' | 'tight' | 'missed' | 'unknown';
  spareSeconds: number | null;
  confidence: TripTimingConfidence;
};
export type TripLegTiming = {
  legKey: string;
  stepIndex: number;
  runRef?: TripRunRef;
  completed: boolean;
  boarded: boolean;
  state: TripLegObservation['state'];
  status: TripLegObservation['status'];
  confidence: TripTimingConfidence;
  departs: string;
  arrives: string;
  observedAt: number | null;
  expiresAt: number | null;
  observation: TripLegObservation | null;
};
export type TripTimingProjection = {
  projectedItinerary: Itinerary;
  arrivalTime: string | null;
  confidence: TripTimingConfidence;
  observedAt: number | null;
  expiresAt: number | null;
  legs: TripLegTiming[];
  connections: TripConnectionTiming[];
  /** A projected connection failure/disruption, never proof of a vehicle having departed. */
  infeasible: boolean;
};
export type TripTimingOptions = {
  cursor?: NavigationCursor;
  /** Only the current walk, from credible location evidence; omitted means an estimate. */
  remainingWalkSeconds?: number;
  /** Additional platform/boarding margin after the transfer walk. */
  transferBufferSeconds?: number;
};

const MAX_SOURCE_AGE_MS = 90_000;
const FUTURE_ALLOWANCE_MS = 30_000;
const at = (time: string) => Date.parse(time);
const validTime = (time: unknown): time is string => typeof time === 'string' && Number.isFinite(at(time));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const tripLegKey = (stepIndex: number): string => String(stepIndex);

/** One request identity per immutable selected step, independent of displayed live clocks. */
export function tripLiveRequests(itinerary: Itinerary | null | undefined): TripLiveRequest['legs'] {
  return (itinerary?.steps ?? []).flatMap((step, index) => {
    const runRef = step.kind === 'transit' ? parseTripRunRef(step.runRef) : null;
    return runRef ? [{ legKey: tripLegKey(index), runRef }] : [];
  }).slice(0, 12);
}

function observationFor(step: TransitStep, index: number, response: TripLiveResponse | null, now: number): TripLegObservation | null {
  if (!response || response.version !== 1 || !finite(response.fetchedAt) || response.fetchedAt > now + FUTURE_ALLOWANCE_MS
    || !Array.isArray(response.legs) || response.legs.length > 12 || !parseTripRunRef(step.runRef)) return null;
  const matches = response.legs.filter((leg) => leg?.legKey === tripLegKey(index) && parseTripRunRef(leg.runRef) && sameTripRunRef(step.runRef, leg.runRef));
  if (matches.length !== 1) return null;
  const leg = matches[0]!;
  if (!['fresh', 'stale', 'unknown'].includes(leg.state)
    || !['predicted', 'cancelled', 'skips-stop', 'no-data', 'unavailable'].includes(leg.status)
    || (leg.departs !== undefined && !validTime(leg.departs)) || (leg.arrives !== undefined && !validTime(leg.arrives))
    || (leg.departs && leg.arrives && at(leg.arrives) < at(leg.departs))) return null;
  if (leg.observedAt !== null && (!finite(leg.observedAt) || leg.observedAt < 0 || leg.observedAt > now + FUTURE_ALLOWANCE_MS)) return null;
  if (leg.expiresAt !== null && (!finite(leg.expiresAt) || leg.observedAt === null || leg.expiresAt < leg.observedAt
    || leg.expiresAt - leg.observedAt > MAX_SOURCE_AGE_MS)) return null;
  const fresh = leg.state === 'fresh' && leg.observedAt !== null && leg.expiresAt !== null
    && now - leg.observedAt <= MAX_SOURCE_AGE_MS && leg.expiresAt > now;
  return { ...leg, state: fresh ? 'fresh' : leg.observedAt !== null ? 'stale' : 'unknown' };
}

function shiftStep(step: TransitStep, timing: TripLegTiming): TransitStep {
  const { live: _live, connection: _connection, ...baseline } = step;
  const from = at(step.from.time);
  const to = at(step.to.time);
  const duration = to - from;
  const start = at(timing.departs);
  const end = at(timing.arrives);
  const fresh = timing.state === 'fresh';
  // A skipped boarding stop is no longer relevant after the rider has boarded this leg.
  const boardOnlySkip = timing.boarded && timing.observation?.boardSkipped === true && !timing.observation.alightSkipped;
  const status = boardOnlySkip ? undefined : timing.status;
  const departureDelaySeconds = Math.round((start - from) / 1000);
  const arrivalDelaySeconds = Math.round((end - to) / 1000);
  const delayAt: 'arrival' | 'departure' = timing.boarded || (Math.abs(departureDelaySeconds) < 60 && Math.abs(arrivalDelaySeconds) >= 60) ? 'arrival' : 'departure';
  const live = fresh && status === 'predicted' && timing.observation?.departs && timing.observation.arrives
    && !timing.observation.departureNoData && !timing.observation.arrivalNoData
    && !timing.observation.departureInferred && !timing.observation.arrivalInferred
    ? { status: 'tracked' as const, departs: timing.departs, arrives: timing.arrives, departureDelaySeconds, arrivalDelaySeconds, delayAt,
      delaySeconds: delayAt === 'arrival' ? arrivalDelaySeconds : departureDelaySeconds }
    : fresh && (status === 'cancelled' || status === 'skips-stop') ? { status } : undefined;
  return {
    ...baseline, from: { ...step.from, time: timing.departs }, to: { ...step.to, time: timing.arrives },
    durationSeconds: Math.max(0, (end - start) / 1000),
    ...(step.stops ? { stops: step.stops.map((stop) => ({ ...stop,
      // Endpoint interpolation is an estimate, not an independently observed stop prediction.
      time: new Date(start + (duration > 0 ? Math.max(0, Math.min(1, (at(stop.time) - from) / duration)) : 0) * (end - start)).toISOString(),
    })) } : {}),
    ...(live ? { live } : {}),
  };
}

/** Pure projection: never changes selected run refs, schedule identity, geometry or cursor. */
export function projectTripTiming(itinerary: Itinerary, response: TripLiveResponse | null, now: number, options: TripTimingOptions = {}): TripTimingProjection {
  const cursor = options.cursor;
  const legs: TripLegTiming[] = [];
  let blocked = false;
  for (const [stepIndex, step] of itinerary.steps.entries()) {
    if (step.kind !== 'transit') continue;
    const completed = Boolean(cursor && (stepIndex < cursor.stepIndex || cursor.phase === 'arrived'
      || (stepIndex === cursor.stepIndex && (cursor.phase === 'walking' || cursor.phase === 'transferring'))));
    const boarded = Boolean(cursor && stepIndex === cursor.stepIndex && cursor.phase === 'riding');
    const observation = completed ? null : observationFor(step, stepIndex, response, now);
    const fresh = observation?.state === 'fresh';
    let departs = step.from.time;
    let arrives = step.to.time;
    let confidence: TripTimingConfidence = observation?.state === 'stale' ? 'stale' : 'scheduled';
    if (fresh && observation.status === 'predicted') {
      if (observation.departs && !observation.departureNoData) departs = observation.departs;
      if (observation.arrives && !observation.arrivalNoData) arrives = observation.arrives;
      else if (observation.departs && !observation.arrivalNoData) arrives = new Date(at(departs) + step.durationSeconds * 1000).toISOString();
      confidence = observation.arrives && !observation.arrivalNoData
        ? observation.departs && !observation.departureNoData && !observation.departureInferred && !observation.arrivalInferred ? 'live' : 'estimated' : 'estimated';
      if (observation.arrivalNoData) confidence = 'unavailable';
      if (at(arrives) < at(departs)) { departs = step.from.time; arrives = step.to.time; confidence = 'unavailable'; }
    }
    const boardOnlySkip = boarded && observation?.boardSkipped === true && !observation.alightSkipped;
    if (fresh && (observation.status === 'cancelled' || (observation.status === 'skips-stop' && !boardOnlySkip))) {
      blocked = true;
      confidence = 'unavailable';
    }
    if (fresh && (observation.status === 'no-data' || observation.status === 'unavailable')) confidence = 'unavailable';
    legs.push({ legKey: tripLegKey(stepIndex), stepIndex, ...(step.runRef ? { runRef: step.runRef } : {}), completed, boarded,
      state: observation?.state ?? 'unknown', status: observation?.status ?? 'unavailable', confidence, departs, arrives,
      observedAt: observation?.observedAt ?? null, expiresAt: observation?.expiresAt ?? null, observation });
  }
  const connections: TripConnectionTiming[] = [];
  for (let index = 1; index < legs.length; index += 1) {
    const before = legs[index - 1]!;
    const after = legs[index]!;
    if (after.completed || after.boarded) continue;
    const walkSeconds = itinerary.steps.slice(before.stepIndex + 1, after.stepIndex).reduce((sum, step) => sum + (step.kind === 'walk' ? step.durationSeconds : 0), 0);
    const nextStep = itinerary.steps[after.stepIndex] as TransitStep;
    const buffer = finite(options.transferBufferSeconds) && options.transferBufferSeconds >= 0 ? options.transferBufferSeconds
      : finite(nextStep.minimumTransferSeconds) && nextStep.minimumTransferSeconds >= 0 ? nextStep.minimumTransferSeconds : 0;
    const onCurrentWalk = cursor && (cursor.phase === 'walking' || cursor.phase === 'transferring')
      && cursor.stepIndex >= before.stepIndex && cursor.stepIndex < after.stepIndex;
    const remaining = finite(options.remainingWalkSeconds) && options.remainingWalkSeconds >= 0 ? options.remainingWalkSeconds : walkSeconds;
    const readyAt = onCurrentWalk ? now + remaining * 1000 : before.completed && cursor?.stepIndex === after.stepIndex ? now : at(before.arrives) + walkSeconds * 1000;
    const unknown = before.confidence === 'unavailable' || before.confidence === 'stale' || after.confidence === 'unavailable'
      || after.confidence === 'stale' || after.observation?.departureNoData === true;
    const rawSpare = Math.round((at(after.departs) - readyAt) / 1000);
    const spare = rawSpare - buffer;
    const confidence: TripTimingConfidence = unknown ? 'unavailable'
      : before.state === 'fresh' && after.state === 'fresh' && before.observation?.arrives && after.observation?.departs
        && !before.observation.arrivalInferred && !after.observation.departureInferred && !onCurrentWalk ? 'live'
        : before.confidence === 'scheduled' && after.confidence === 'scheduled' ? 'scheduled' : 'estimated';
    const status = unknown ? 'unknown' : spare < 0 ? 'missed' : spare < 120 ? 'tight' : 'feasible';
    connections.push({ fromStepIndex: before.stepIndex, toStepIndex: after.stepIndex, status, spareSeconds: unknown ? null : spare, confidence });
  }
  const byIndex = new Map(legs.map((leg) => [leg.stepIndex, leg]));
  const steps = itinerary.steps.map((step, index): TripStep => {
    if (step.kind !== 'transit') return step;
    const timing = byIndex.get(index)!;
    if (timing.completed) {
      const { live: _live, connection: _connection, ...completed } = step;
      return completed;
    }
    const projected = shiftStep(step, timing);
    const connection = connections.find((item) => item.toStepIndex === index);
    return connection && (connection.status === 'missed' || connection.status === 'tight')
      ? { ...projected, connection: { status: connection.status, spareSeconds: connection.spareSeconds! } } : projected;
  });
  const pending = legs.filter((leg) => !leg.completed);
  const brokenConnection = connections.some((connection) => connection.status === 'missed' && connection.confidence === 'live');
  const last = legs.at(-1);
  const tailSeconds = last ? itinerary.steps.slice(last.stepIndex + 1).reduce((sum, step) => sum + (step.kind === 'walk' ? step.durationSeconds : 0), 0) : 0;
  const remainingWalk = finite(options.remainingWalkSeconds) && options.remainingWalkSeconds >= 0 ? options.remainingWalkSeconds : null;
  const lastWalkInProgress = cursor && cursor.phase !== 'arrived' && (!last || cursor.stepIndex > last.stepIndex);
  const projectedArrival = lastWalkInProgress && remainingWalk !== null ? new Date(now + remainingWalk * 1000).toISOString()
    : last ? new Date(at(last.arrives) + tailSeconds * 1000).toISOString() : itinerary.arrivalTime;
  const stale = pending.some((leg) => leg.confidence === 'stale');
  const unavailable = pending.some((leg) => leg.confidence === 'unavailable');
  const hasLive = pending.some((leg) => leg.state === 'fresh' && leg.status === 'predicted');
  const hasSchedule = pending.some((leg) => leg.confidence === 'scheduled');
  const confidence: TripTimingConfidence = blocked || brokenConnection || unavailable ? 'unavailable' : stale ? 'stale'
    : lastWalkInProgress && remainingWalk !== null ? 'estimated'
      : pending.length > 0 && pending.every((leg) => leg.confidence === 'live') ? 'live'
      : hasLive || pending.some((leg) => leg.confidence === 'estimated') ? 'estimated' : 'scheduled';
  // Passing a planned arrival is not evidence of arrival or a missed vehicle. Stop presenting it as a current ETA.
  const arrivalTime = blocked || brokenConnection || unavailable || stale || (cursor && at(projectedArrival) < now && cursor.phase !== 'arrived') ? null : projectedArrival;
  const observations = pending.filter((leg) => leg.observedAt !== null);
  const observedAt = observations.length ? Math.min(...observations.map((leg) => leg.observedAt!)) : null;
  const expiries = pending.filter((leg) => leg.expiresAt !== null);
  const expiresAt = expiries.length ? Math.min(...expiries.map((leg) => leg.expiresAt!)) : null;
  const first = legs[0];
  const leadSeconds = first ? (at((itinerary.steps[first.stepIndex] as TransitStep).from.time) - at(itinerary.departureTime)) / 1000 : 0;
  const departureTime = first && !first.completed && !first.boarded ? new Date(at(first.departs) - leadSeconds * 1000).toISOString() : itinerary.departureTime;
  const projectedItinerary: Itinerary = { ...itinerary, steps, departureTime, arrivalTime: projectedArrival,
    durationSeconds: Math.max(0, (at(projectedArrival) - at(departureTime)) / 1000) };
  // `hasSchedule` deliberately prevents any consumer treating mixed scheduled legs as fully live.
  return { projectedItinerary, arrivalTime, confidence: arrivalTime === null && confidence !== 'stale' ? 'unavailable' : hasSchedule && confidence === 'live' ? 'estimated' : confidence,
    observedAt, expiresAt, legs, connections, infeasible: blocked || connections.some((connection) => connection.status === 'missed' && connection.confidence === 'live') };
}

/** A transient view plan only; selection and checkpoint ordering remain the baseline's. */
export function projectNavigationTiming(plan: NormalizedNavigationPlan, projection: TripTimingProjection): NormalizedNavigationPlan {
  const byStep = new Map(projection.legs.map((leg) => [leg.stepIndex, leg]));
  return { ...plan, departureTime: projection.projectedItinerary.departureTime,
    arrivalTime: projection.arrivalTime ?? plan.arrivalTime,
    timing: { confidence: projection.confidence, observedAt: projection.observedAt, expiresAt: projection.expiresAt, arrivalTime: projection.arrivalTime },
    segments: plan.segments.map((segment) => {
      const leg = byStep.get(segment.stepIndex);
      return leg ? { ...segment, departureTime: leg.departs, arrivalTime: leg.arrives,
        durationSeconds: Math.max(0, (at(leg.arrives) - at(leg.departs)) / 1000) } : segment;
    }),
    checkpoints: plan.checkpoints.map((checkpoint) => {
      const leg = byStep.get(checkpoint.stepIndex);
      if (!leg || !checkpoint.time) return checkpoint;
      if (checkpoint.kind === 'board') return { ...checkpoint, time: leg.departs };
      if (checkpoint.kind === 'alight') return { ...checkpoint, time: leg.arrives };
      return checkpoint;
    }),
  };
}
