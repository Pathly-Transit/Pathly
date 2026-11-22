import { auth, callable } from '../lib/firebase';
import { distanceMeters, projectPointToPath, type ActiveTripRuntime, type NavigationFix, type TripEndpointReference } from './enrouteNavigation';
import { planTripAlternativesForRecovery, type Itinerary, type LatLng, type ResumePlanRequest, type TransitStep, type TripStep } from './tripPlanning';
import type { TripLegObservation, TripLiveRequest, TripLiveResponse, TripRunRef } from './tripLiveTypes';
import { parseTripRunRef, tripRunRefKey } from './tripRunRef';
import { projectTripTiming, tripLiveRequests } from './tripTiming';

const getTripLiveStatus = callable<TripLiveRequest, TripLiveResponse>('getTripLiveStatus');
const MAX_RUN_METERS_PER_SECOND = 3.5;
const LATE_GRACE_SECONDS = 120;
const WALK_METERS_PER_SECOND = 1.3;
const at = (time: string) => Date.parse(time);
export type TripRecoveryReason = { kind: 'cancelled' | 'skips-stop' | 'connection' | 'passed-board' | 'unreachable-board' | 'wrong-way'; stepIndex: number; key: string };
export type TripRecoveryPlan = { itinerary: Itinerary; origin: TripEndpointReference; resumeRequest: ResumePlanRequest; prefixSteps: number; keepCursor: boolean; startPoint?: LatLng };

function credible(fix: NavigationFix | null | undefined, now: number, maxAgeMs = 30_000): fix is NavigationFix {
  return Boolean(fix && fix.source === 'real' && Number.isFinite(fix.capturedAt) && fix.capturedAt <= now + 5000 && now - fix.capturedAt <= maxAgeMs
    && typeof fix.accuracyMeters === 'number' && Number.isFinite(fix.accuracyMeters) && fix.accuracyMeters >= 0 && fix.accuracyMeters <= 50
    && Number.isFinite(fix.point.lat) && Math.abs(fix.point.lat) <= 90 && Number.isFinite(fix.point.lng) && Math.abs(fix.point.lng) <= 180);
}
function fresh(observation: TripLegObservation | null | undefined, now: number): observation is TripLegObservation {
  return Boolean(observation && observation.state === 'fresh' && typeof observation.observedAt === 'number' && Number.isFinite(observation.observedAt)
    && typeof observation.expiresAt === 'number' && Number.isFinite(observation.expiresAt)
    && observation.observedAt >= now - 90_000 && observation.observedAt <= now + 30_000 && observation.expiresAt > now
    && observation.expiresAt >= observation.observedAt && observation.expiresAt - observation.observedAt <= 90_000);
}
const reasonFor = (active: ActiveTripRuntime, kind: TripRecoveryReason['kind'], stepIndex: number): TripRecoveryReason => {
  const step = active.itinerary.steps[stepIndex];
  return { kind, stepIndex, key: `${active.sessionId}:${active.cursor.stepIndex}:${kind}:${step?.kind === 'transit' && step.runRef ? tripRunRefKey(step.runRef) : stepIndex}` };
};

/** A transfer walk begins on the previous leg's alighting checkpoint, not its own step index. */
function currentWalk(active: ActiveTripRuntime): { stepIndex: number; step: Extract<TripStep, { kind: 'walk' }> } | null {
  if (active.cursor.phase !== 'walking' && active.cursor.phase !== 'transferring') return null;
  const segment = active.plan.segments.find((item) => item.kind === 'walk'
    && active.cursor.checkpointOrdinal >= item.startCheckpointOrdinal && active.cursor.checkpointOrdinal < item.endCheckpointOrdinal);
  const stepIndex = segment?.stepIndex ?? active.cursor.stepIndex;
  const step = active.itinerary.steps[stepIndex];
  return step?.kind === 'walk' ? { stepIndex, step } : null;
}

/** Current-walk estimate only; no stale location, service-area fallback or simulated GPS. */
export function remainingWalkSeconds(active: ActiveTripRuntime, fix: NavigationFix | null, now = Date.now()): number | undefined {
  const walk = currentWalk(active);
  if (!credible(fix, now) || !walk) return undefined;
  const { step } = walk;
  const projection = projectPointToPath(fix.point, step.path);
  if (!projection || projection.distanceMeters > 75) return undefined;
  return Math.ceil(Math.max((projection.totalMeters - projection.alongMeters + projection.distanceMeters) / WALK_METERS_PER_SECOND,
    step.durationSeconds * (1 - projection.fraction)));
}

/** Strong infeasibility only. Predictions are not proof of departure or boarding. */
export function recoveryReason(active: ActiveTripRuntime, statuses: TripLiveResponse | null, fix: NavigationFix | null, now: number,
  priorFix?: NavigationFix | null): TripRecoveryReason | null {
  const cursor = active.cursor;
  if (cursor.phase === 'arrived') return null;
  const projection = projectTripTiming(active.itinerary, statuses, now, { cursor, remainingWalkSeconds: remainingWalkSeconds(active, fix, now) });
  const currentLeg = projection.legs.find((leg) => leg.stepIndex === cursor.stepIndex);
  // The vehicle may stop short: never teleport its onboard rider to an assumed later alighting.
  if (cursor.phase === 'riding' && fresh(currentLeg?.observation, now)
    && (currentLeg.observation.status === 'cancelled' || (currentLeg.observation.status === 'skips-stop' && currentLeg.observation.alightSkipped === true))) return null;
  for (const leg of projection.legs) {
    if (leg.completed || leg.boarded || !fresh(leg.observation, now)) continue;
    if (leg.status === 'cancelled' || leg.status === 'skips-stop') return reasonFor(active, leg.status, leg.stepIndex);
  }
  // A transfer may still be made by running, or if the following service is a little later.
  for (const connection of projection.connections) {
    if (connection.status !== 'missed' || connection.confidence !== 'live') continue;
    const before = projection.legs.find((leg) => leg.stepIndex === connection.fromStepIndex)!;
    const after = projection.legs.find((leg) => leg.stepIndex === connection.toStepIndex)!;
    const first = active.itinerary.steps[before.stepIndex] as TransitStep;
    const next = active.itinerary.steps[after.stepIndex] as TransitStep;
    if (!fresh(before.observation, now) || !fresh(after.observation, now)
      || !before.observation.arrives || !after.observation.departs || before.observation.arrivalNoData || after.observation.departureNoData
      || before.observation.arrivalInferred || after.observation.departureInferred) continue;
    const minimum = distanceMeters(first.to.location, next.from.location) / MAX_RUN_METERS_PER_SECOND + (next.minimumTransferSeconds ?? 0);
    const ready = Math.max(at(before.observation.arrives), at(first.to.time), now);
    if (ready + minimum * 1000 > at(after.observation.departs) + LATE_GRACE_SECONDS * 1000) return reasonFor(active, 'connection', after.stepIndex);
  }
  if (!credible(fix, now) || cursor.phase === 'riding') return null;
  const nextLeg = projection.legs.find((leg) => !leg.completed);
  if (nextLeg && fresh(nextLeg.observation, now) && nextLeg.observation.boardPassed === true
    && credible(fix, now, 10_000) && credible(priorFix, now, 90_000) && fix.capturedAt - priorFix.capturedAt >= 10_000) {
    const step = active.itinerary.steps[nextLeg.stepIndex] as TransitStep;
    const vehicle = nextLeg.observation.vehicleLocation;
    if (vehicle && Number.isFinite(vehicle.lat) && Math.abs(vehicle.lat) <= 90 && Number.isFinite(vehicle.lng) && Math.abs(vehicle.lng) <= 180
      && Number.isFinite(vehicle.capturedAt) && vehicle.capturedAt <= now + 5000 && Math.abs(vehicle.capturedAt - fix.capturedAt) <= 15_000
      && distanceMeters(step.from.location, vehicle) >= 200 && distanceMeters(fix.point, vehicle) >= 150
      && distanceMeters(fix.point, step.from.location) <= 80 && distanceMeters(priorFix.point, step.from.location) <= 100) {
      return reasonFor(active, 'passed-board', nextLeg.stepIndex);
    }
  }
  if (nextLeg && fresh(nextLeg.observation, now) && nextLeg.status === 'predicted'
    && nextLeg.observation.departs && !nextLeg.observation.departureNoData && !nextLeg.observation.departureInferred) {
    const step = active.itinerary.steps[nextLeg.stepIndex] as TransitStep;
    const distance = distanceMeters(fix.point, step.from.location);
    if (distance > 100 && now + distance / MAX_RUN_METERS_PER_SECOND * 1000
      > Math.max(at(nextLeg.observation.departs), at(step.from.time)) + LATE_GRACE_SECONDS * 1000) return reasonFor(active, 'unreachable-board', nextLeg.stepIndex);
  }
  const walk = currentWalk(active);
  if (!walk || !credible(priorFix, now, 90_000) || fix.capturedAt - priorFix.capturedAt < 10_000
    || distanceMeters(fix.point, priorFix.point) < 40) return null;
  const { step } = walk;
  const current = projectPointToPath(fix.point, step.path);
  const prior = projectPointToPath(priorFix.point, step.path);
  if (!current || !prior) return null;
  const wrongWay = current.alongMeters < prior.alongMeters - 50;
  const offRoute = current.distanceMeters > 100 && prior.distanceMeters > 100;
  return wrongWay || offRoute ? reasonFor(active, 'wrong-way', walk.stepIndex) : null;
}

const serviceKey = (ref: TripRunRef) => JSON.stringify([ref.agencyId, ref.scheduleVersion, ref.serviceDate, ref.tripId, ref.startTime]);
function knownBad(candidate: Itinerary, statuses: TripLiveResponse | null, now: number): boolean {
  return candidate.steps.some((step) => {
    if (step.kind !== 'transit' || !parseTripRunRef(step.runRef)) return false;
    return (statuses?.legs ?? []).some((observation) => {
      if (!fresh(observation, now) || !parseTripRunRef(observation.runRef) || serviceKey(step.runRef!) !== serviceKey(observation.runRef)) return false;
      if (observation.status === 'cancelled') return true;
      if (observation.status !== 'skips-stop') return false;
      if (!observation.boardSkipped && !observation.alightSkipped) return true;
      return Boolean(observation.boardSkipped && ((step.runRef!.boardStopId === observation.runRef.boardStopId && step.runRef!.boardOccurrence === observation.runRef.boardOccurrence)
        || (step.runRef!.alightStopId === observation.runRef.boardStopId && step.runRef!.alightOccurrence === observation.runRef.boardOccurrence)))
        || Boolean(observation.alightSkipped && ((step.runRef!.boardStopId === observation.runRef.alightStopId && step.runRef!.boardOccurrence === observation.runRef.alightOccurrence)
          || (step.runRef!.alightStopId === observation.runRef.alightStopId && step.runRef!.alightOccurrence === observation.runRef.alightOccurrence)));
    });
  });
}

/** Prepare an autonomous replacement; the hook atomically validates and installs it afterwards. */
export async function findTripRecovery(active: ActiveTripRuntime, request: ResumePlanRequest, fix: NavigationFix | null,
  reason: TripRecoveryReason, statuses: TripLiveResponse | null, options: { isCurrent?: () => boolean } = {}): Promise<TripRecoveryPlan | null> {
  const owner = auth.currentUser?.uid ?? null;
  const isCurrent = () => owner === (auth.currentUser?.uid ?? null) && options.isCurrent?.() !== false;
  const now = Date.now();
  if (!isCurrent() || owner !== active.uid || active.cursor.phase === 'arrived') return null;
  const onBoard = active.cursor.phase === 'riding';
  const current = active.itinerary.steps[active.cursor.stepIndex];
  let anchor: TripEndpointReference;
  let notBefore: number;
  let prefixSteps: number;
  if (onBoard) {
    if (current?.kind !== 'transit' || !parseTripRunRef(current.runRef)) return null;
    const projection = projectTripTiming(active.itinerary, statuses, now, { cursor: active.cursor });
    const observed = projection.legs.find((leg) => leg.stepIndex === active.cursor.stepIndex)?.observation;
    if (fresh(observed, now) && (observed.status === 'cancelled' || observed.alightSkipped)) return null;
    const alightAt = Math.max(at(current.to.time), fresh(observed, now) && observed.arrives && !observed.arrivalNoData ? at(observed.arrives) : 0);
    // A passed forecast cannot prove the rider can still alight at this stop.
    if (alightAt <= now) return null;
    anchor = { kind: 'coordinate', label: current.to.name, point: { ...current.to.location }, savedAt: now };
    notBefore = alightAt;
    prefixSteps = active.cursor.stepIndex + 1;
  } else {
    if (!credible(fix, now)) return null;
    anchor = { kind: 'coordinate', label: 'Current location', point: { ...fix.point }, savedAt: now };
    notBefore = now;
    prefixSteps = currentWalk(active)?.stepIndex ?? active.cursor.stepIndex;
    // A completed approach walk followed by a new walk has no boarding boundary between them.
    // Drop that trailing walk rather than create consecutive walk segments with incompatible anchors.
    while (prefixSteps > 0 && active.itinerary.steps[prefixSteps - 1]?.kind === 'walk') prefixSteps -= 1;
    if (active.itinerary.steps.slice(0, prefixSteps).some((step) => step.kind === 'transit' && !parseTripRunRef(step.runRef))) prefixSteps = 0;
    const lastCompletedRide = active.itinerary.steps.slice(0, prefixSteps).findLast((step): step is TransitStep => step.kind === 'transit');
    if (lastCompletedRide) notBefore = Math.max(notBefore, at(lastCompletedRide.to.time));
  }
  try {
    const affectedStep = active.itinerary.steps[reason.stepIndex];
    const affected = affectedStep?.kind === 'transit' ? affectedStep
      : active.itinerary.steps.slice(prefixSteps).find((step): step is TransitStep => step.kind === 'transit');
    const excludedRuns = (statuses?.legs ?? []).filter((observation) => fresh(observation, now) && observation.status === 'cancelled' && parseTripRunRef(observation.runRef))
      .map((observation) => observation.runRef).slice(0, 12);
    if (['passed-board', 'unreachable-board', 'connection'].includes(reason.kind) && affected?.runRef
      && !excludedRuns.some((ref) => serviceKey(ref) === serviceKey(affected.runRef!))) excludedRuns.push(affected.runRef);
    const excludedKeys = new Set(excludedRuns.map(serviceKey));
    const containsExcludedRun = (candidate: Itinerary) => candidate.steps.some((step) => step.kind === 'transit'
      && step.runRef && excludedKeys.has(serviceKey(step.runRef)));
    const recovery = { excludedRuns, ...(affected?.liveRoute ? { preferredRoute: { agencyId: affected.liveRoute.agencyId, routeId: affected.liveRoute.routeId } } : {}),
      ...(onBoard && current?.kind === 'transit' && current.runRef ? { incomingRun: current.runRef } : {}) };
    const planned = await planTripAlternativesForRecovery(request, anchor, new Date(notBefore).toISOString(), recovery);
    if (!isCurrent()) return null;
    const sameLine = (candidate: Itinerary) => {
      const next = candidate.steps.find((step): step is TransitStep => step.kind === 'transit');
      return affected?.kind === 'transit' && next?.liveRoute && affected.liveRoute
        && next.liveRoute.agencyId === affected.liveRoute.agencyId && next.liveRoute.routeId === affected.liveRoute.routeId;
    };
    const candidates = planned.itineraries.filter((candidate) => candidate.steps.length > 0 && at(candidate.arrivalTime) >= at(candidate.departureTime)
      && !containsExcludedRun(candidate) && !knownBad(candidate, statuses, Date.now()))
      .sort((a, b) => Number(Boolean(sameLine(b))) - Number(Boolean(sameLine(a))) || at(a.arrivalTime) - at(b.arrivalTime));
    for (const candidate of candidates.slice(0, 4)) {
      if (!isCurrent()) return null;
      const legs = tripLiveRequests(candidate);
      let response: TripLiveResponse | null = null;
      if (legs.length > 0) {
        const result = await getTripLiveStatus({ version: 1, legs });
        if (!isCurrent()) return null;
        response = result.data;
      }
      const checkedAt = Date.now();
      const projection = projectTripTiming(candidate, response, checkedAt);
      if (projection.infeasible || projection.connections.some((connection) => connection.status === 'missed') || knownBad(candidate, response, checkedAt)) continue;
      const first = projection.legs[0];
      if (first) {
        const access = candidate.steps.slice(0, first.stepIndex).reduce((sum, step) => sum + (step.kind === 'walk' ? step.durationSeconds : 0), 0);
        const incomingMargin = onBoard ? (candidate.steps[first.stepIndex] as TransitStep).minimumTransferSeconds ?? 0 : 0;
        if (at(first.departs) < Math.max(notBefore, onBoard ? notBefore : checkedAt) + (access + incomingMargin) * 1000) continue;
      }
      const prefix = active.itinerary.steps.slice(0, prefixSteps);
      const steps: TripStep[] = [...prefix, ...candidate.steps];
      const origin = prefix.length > 0 ? active.origin : anchor;
      const departureTime = prefix.length > 0 ? active.itinerary.departureTime : candidate.departureTime;
      const transits = steps.filter((step) => step.kind === 'transit');
      const itinerary: Itinerary = { ...candidate, id: `recovery:${active.sessionId}:${reason.kind}:${candidate.id}`, steps, departureTime,
        durationSeconds: Math.max(0, (at(candidate.arrivalTime) - at(departureTime)) / 1000), transfers: Math.max(0, transits.length - 1) };
      if (prefix.length > 0) delete itinerary.fare; // Completed and onward fare combination is not known here.
      return { itinerary, origin, resumeRequest: { ...planned.resumeRequest, origin, time: { mode: 'depart', at: departureTime } }, prefixSteps, keepCursor: onBoard,
        ...(!onBoard && fix ? { startPoint: { ...fix.point } } : {}) };
    }
  } catch { /* Keep the current trip while planning/feed work is unavailable. */ }
  return null;
}
