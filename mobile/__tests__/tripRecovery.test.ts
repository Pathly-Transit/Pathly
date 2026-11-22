import { httpsCallable } from 'firebase/functions';

import { createActiveTripRuntime } from '../src/hooks/useActiveTrip';
import type { NavigationFix } from '../src/data/enrouteNavigation';
import { findTripRecovery, recoveryReason, remainingWalkSeconds, type TripRecoveryReason } from '../src/data/tripRecovery';
import type { Itinerary, ResumePlanRequest, TransitStep } from '../src/data/tripPlanning';
import type { TripLiveRequest } from '../src/data/tripLiveTypes';
import { auth } from '../src/lib/firebase';
import { parseTripAlertState, tripAlertState } from '../src/background/tripAlertState';
import { parseNativeSnapshot } from '../src/data/nativeSnapshot';
import { createTripSelectionIdentity } from '../src/data/enrouteNavigation';
import { ETA_NOW, etaAt, nativeJourney, nativeObservation, nativeResponse } from './fixtures/nativeJourney';

const fixAt = (lat: number, time = ETA_NOW, lng = -73.1): NavigationFix => ({ point: { lat, lng }, capturedAt: time, accuracyMeters: 5, source: 'real' });
const requestFor = (trip = nativeJourney()): ResumePlanRequest => ({
  origin: { kind: 'coordinate', label: 'Start', point: { lat: 40.799, lng: -73.1 }, savedAt: ETA_NOW },
  destination: { kind: 'coordinate', label: 'Meeting', point: { lat: 40.823, lng: -73.1 }, savedAt: ETA_NOW },
  time: { mode: 'depart', at: trip.departureTime }, preference: 'fastest', modes: ['bus'], ferry: false, lessWalking: true,
});
const activeFor = (trip = nativeJourney()) => {
  const request = requestFor(trip);
  return createActiveTripRuntime({ itinerary: trip, origin: request.origin, destination: request.destination }, 'test-uid', ETA_NOW, 'recovery-session');
};
const callable = (name: string) => (httpsCallable as jest.Mock)({}, name) as jest.Mock;
let originalPlan: ReturnType<jest.Mock['getMockImplementation']>;
let originalStatus: ReturnType<jest.Mock['getMockImplementation']>;
let previousUser: typeof auth.currentUser;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(ETA_NOW);
  previousUser = auth.currentUser;
  Object.defineProperty(auth, 'currentUser', { configurable: true, writable: true, value: { uid: 'test-uid' } });
  originalPlan = callable('planTrip').getMockImplementation();
  originalStatus = callable('getTripLiveStatus').getMockImplementation();
  callable('planTrip').mockClear();
  callable('getTripLiveStatus').mockImplementation((request: TripLiveRequest) => Promise.resolve({ data: { version: 1, fetchedAt: ETA_NOW,
    legs: request.legs.map(({ legKey, runRef }) => ({ legKey, runRef, state: 'unknown', status: 'unavailable', observedAt: null, expiresAt: null })) } }));
});
afterEach(() => {
  callable('planTrip').mockImplementation(originalPlan);
  callable('getTripLiveStatus').mockImplementation(originalStatus);
  jest.restoreAllMocks();
  Object.defineProperty(auth, 'currentUser', { configurable: true, writable: true, value: previousUser });
});

it('does not infer a missed service from timetable passage, a stale feed, or waiting at its stop', () => {
  const active = activeFor();
  const now = ETA_NOW + 12 * 60_000;
  expect(recoveryReason(active, null, fixAt(40.8, now), now)).toBeNull();
  expect(recoveryReason(active, nativeResponse([nativeObservation(1)]), fixAt(40.79, now), now)).toBeNull();
  const fresh = nativeResponse([nativeObservation(1, { observedAt: now, expiresAt: now + 90_000 })]);
  active.cursor = { ...active.cursor, stepIndex: 1, phase: 'waiting-to-board' };
  expect(recoveryReason(active, fresh, fixAt(40.8, now), now)).toBeNull();
});

it('recognizes physical impossibility with running and late grace while retaining a catchable delayed bus', () => {
  const active = activeFor();
  const now = ETA_NOW + 9 * 60_000;
  const observed = nativeObservation(1, { observedAt: now, expiresAt: now + 90_000 });
  expect(recoveryReason(active, nativeResponse([observed]), fixAt(40.79, now), now)?.kind).toBe('unreachable-board');
  expect(recoveryReason(active, nativeResponse([{ ...observed, departs: etaAt(15), arrives: etaAt(25) }]), fixAt(40.79, now), now)).toBeNull();
  expect(recoveryReason(active, nativeResponse([observed]), { ...fixAt(40.79, now), accuracyMeters: 51 }, now)).toBeNull();
  expect(recoveryReason(active, nativeResponse([observed]), { ...fixAt(40.79, now), source: 'mock' }, now)).toBeNull();
  expect(recoveryReason(active, nativeResponse([{ ...observed, departureInferred: true }]), fixAt(40.79, now), now)).toBeNull();
});

it('requires near-time physical vehicle proof and two own fixes at the board before declaring it passed', () => {
  const active = activeFor();
  active.cursor = { ...active.cursor, stepIndex: 1, phase: 'waiting-to-board' };
  const now = ETA_NOW + 12 * 60_000;
  const passed = nativeObservation(1, { observedAt: now, expiresAt: now + 90_000, boardPassed: true,
    vehicleLocation: { lat: 40.805, lng: -73.1, capturedAt: now } });
  const current = fixAt(40.8, now);
  const prior = fixAt(40.7999, now - 20_000);
  expect(recoveryReason(active, nativeResponse([passed]), current, now)).toBeNull();
  expect(recoveryReason(active, nativeResponse([passed]), current, now, prior)?.kind).toBe('passed-board');
  passed.vehicleLocation = { lat: 40.8005, lng: -73.1, capturedAt: now };
  expect(recoveryReason(active, nativeResponse([passed]), current, now, prior)).toBeNull();
  passed.vehicleLocation = { lat: 40.805, lng: -73.1, capturedAt: now };
  expect(recoveryReason(active, nativeResponse([passed]), { ...current, capturedAt: now - 11_000 }, now, prior)).toBeNull();
  active.cursor.phase = 'riding';
  expect(recoveryReason(active, nativeResponse([passed]), current, now, prior)).toBeNull();
});

it('requires two distinct credible wrong-way/off-path fixes at least ten seconds apart', () => {
  const active = activeFor();
  const segment = active.plan.segments.find((item) => item.kind === 'walk' && item.stepIndex === 2)!;
  active.cursor = { ...active.cursor, checkpointOrdinal: segment.startCheckpointOrdinal, stepIndex: 1, phase: 'transferring' };
  const prior = fixAt(40.8118, ETA_NOW - 20_000);
  const current = fixAt(40.8104);
  expect(recoveryReason(active, null, current, ETA_NOW)).toBeNull();
  expect(recoveryReason(active, null, current, ETA_NOW, prior)?.kind).toBe('wrong-way');
  expect(recoveryReason(active, null, current, ETA_NOW, { ...prior, capturedAt: ETA_NOW - 5000 })).toBeNull();
  expect(recoveryReason(active, null, current, ETA_NOW, { ...prior, capturedAt: ETA_NOW - 60_000 })?.kind).toBe('wrong-way');
  expect(recoveryReason(active, null, current, ETA_NOW, { ...prior, capturedAt: ETA_NOW - 91_000 })).toBeNull();
  expect(recoveryReason(active, null, fixAt(40.811, ETA_NOW, -73.103), ETA_NOW, fixAt(40.811, ETA_NOW - 20_000, -73.102))?.kind).toBe('wrong-way');
});

it('estimates only the current remaining walk from good path evidence', () => {
  const active = activeFor();
  expect(remainingWalkSeconds(active, fixAt(40.7995), ETA_NOW)).toBeLessThan(120);
  expect(remainingWalkSeconds(active, { ...fixAt(40.7995), accuracyMeters: 100 }, ETA_NOW)).toBeUndefined();
  expect(remainingWalkSeconds(active, fixAt(40.7995, ETA_NOW - 31_000), ETA_NOW)).toBeUndefined();
});

it('uses fresh cancellation/skip evidence only for remaining unboarded legs', () => {
  const active = activeFor();
  const response = nativeResponse([nativeObservation(1, { status: 'cancelled' })]);
  expect(recoveryReason(active, response, null, ETA_NOW)?.kind).toBe('cancelled');
  active.cursor = { ...active.cursor, stepIndex: 3, phase: 'waiting-to-board' };
  expect(recoveryReason(active, response, null, ETA_NOW)).toBeNull();
  response.legs = [nativeObservation(3, { status: 'skips-stop', boardSkipped: true })];
  expect(recoveryReason(active, response, null, ETA_NOW)?.kind).toBe('skips-stop');
});

it('never abandons the current onboard service from its original timetable or an interruption', () => {
  const active = activeFor();
  active.cursor = { ...active.cursor, stepIndex: 1, phase: 'riding' };
  expect(recoveryReason(active, null, fixAt(40.79), ETA_NOW + 60 * 60_000)).toBeNull();
  expect(recoveryReason(active, nativeResponse([nativeObservation(1, { status: 'cancelled' })]), null, ETA_NOW)).toBeNull();
  expect(recoveryReason(active, nativeResponse([nativeObservation(1, { status: 'skips-stop', alightSkipped: true })]), null, ETA_NOW)).toBeNull();
});

it('only breaks a future transfer when even running plus grace cannot rescue two fresh matched predictions', () => {
  const active = activeFor();
  active.cursor = { ...active.cursor, stepIndex: 1, phase: 'riding' };
  const delayed = nativeObservation(1, { departs: etaAt(25), arrives: etaAt(35) });
  expect(recoveryReason(active, nativeResponse([delayed, nativeObservation(3)]), null, ETA_NOW)?.kind).toBe('connection');
  expect(recoveryReason(active, nativeResponse([delayed]), null, ETA_NOW)).toBeNull();
  expect(recoveryReason(active, nativeResponse([{ ...delayed, arrivalInferred: true }, nativeObservation(3)]), null, ETA_NOW)).toBeNull();
  expect(recoveryReason(active, nativeResponse([delayed, nativeObservation(3, { departs: etaAt(45), arrives: etaAt(60) })]), null, ETA_NOW)).toBeNull();
});

function nextCandidate(): Itinerary {
  const next = nativeJourney();
  next.id = 'next-run';
  const first = next.steps[1] as TransitStep;
  first.tripId = 'bus-next';
  first.runRef = { ...first.runRef!, tripId: first.tripId };
  return next;
}
const cancelledReason = (active = activeFor()): TripRecoveryReason => ({ kind: 'cancelled', stepIndex: 1, key: `${active.sessionId}:cancelled` });

it('plans from actual GPS, preserves criteria, excludes known cancelled runs and verifies the candidate live', async () => {
  const active = activeFor();
  const candidate = nextCandidate();
  callable('planTrip').mockResolvedValue({ data: { itineraries: [nativeJourney(), candidate] } });
  const response = nativeResponse([nativeObservation(1, { status: 'cancelled' })]);
  const result = await findTripRecovery(active, requestFor(), fixAt(40.799), cancelledReason(), response);
  expect(result).toMatchObject({ prefixSteps: 0, keepCursor: false, origin: { kind: 'coordinate', point: { lat: 40.799, lng: -73.1 } } });
  expect(result!.itinerary.steps).toHaveLength(candidate.steps.length);
  expect(callable('planTrip')).toHaveBeenLastCalledWith(expect.objectContaining({ modes: ['bus'], ferry: false, lessWalking: true,
    recovery: { excludedRuns: [response.legs[0]!.runRef], preferredRoute: { agencyId: 'suffolk', routeId: '51' } } }));
  expect(callable('getTripLiveStatus')).toHaveBeenCalled();
  expect((result!.itinerary.steps[1] as TransitStep).runRef!.tripId).toBe('bus-next');
});

it('excludes a proven missed run even when a planner returns a conflicting future prediction for it', async () => {
  const active = activeFor();
  callable('planTrip').mockResolvedValue({ data: { itineraries: [nativeJourney(), nextCandidate()] } });
  const result = await findTripRecovery(active, requestFor(), fixAt(40.799), { kind: 'passed-board', stepIndex: 1, key: 'missed' }, null);
  expect((result!.itinerary.steps[1] as TransitStep).runRef!.tripId).toBe('bus-next');
  expect(callable('planTrip')).toHaveBeenCalledWith(expect.objectContaining({ recovery: expect.objectContaining({
    excludedRuns: [(active.itinerary.steps[1] as TransitStep).runRef],
  }) }));
});

it('does not assume an onboard rider can alight at a stop whose forecast is already past', async () => {
  const active = activeFor();
  active.cursor = { ...active.cursor, stepIndex: 1, phase: 'riding' };
  const now = ETA_NOW + 21 * 60_000;
  (Date.now as jest.Mock).mockReturnValue(now);
  expect(await findTripRecovery(active, requestFor(), null, { kind: 'connection', stepIndex: 3, key: 'missed-transfer' }, null)).toBeNull();
  expect(callable('planTrip')).not.toHaveBeenCalled();
});

it('rechecks the canonical incoming transfer margin after planning returns', async () => {
  const active = activeFor();
  active.cursor = { ...active.cursor, stepIndex: 1, phase: 'riding' };
  const candidate = nextCandidate();
  const first = candidate.steps[1] as TransitStep;
  first.from = { ...first.from, time: etaAt(21), location: (active.itinerary.steps[1] as TransitStep).to.location };
  first.to = { ...first.to, time: etaAt(31) };
  first.minimumTransferSeconds = 180;
  candidate.steps = [first]; candidate.transfers = 0;
  candidate.departureTime = etaAt(21); candidate.arrivalTime = etaAt(31); candidate.durationSeconds = 600;
  callable('planTrip').mockResolvedValue({ data: { itineraries: [candidate] } });
  expect(await findTripRecovery(active, requestFor(), null, { kind: 'connection', stepIndex: 3, key: 'missed-transfer' }, null)).toBeNull();
  expect(callable('planTrip')).toHaveBeenCalledWith(expect.objectContaining({ recovery: expect.objectContaining({ incomingRun: (active.itinerary.steps[1] as TransitStep).runRef }) }));
});

it('prefers a reachable same-line candidate and rejects a candidate that fresh status cancels', async () => {
  const active = activeFor();
  const same = nextCandidate();
  const different = nextCandidate();
  different.id = 'different-line';
  (different.steps[1] as TransitStep).runRef!.routeId = '100';
  (different.steps[1] as TransitStep).liveRoute!.routeId = '100';
  callable('planTrip').mockResolvedValue({ data: { itineraries: [different, same] } });
  expect((await findTripRecovery(active, requestFor(), fixAt(40.799), cancelledReason(), null))!.itinerary.id).toContain('next-run');
  callable('getTripLiveStatus').mockImplementation((request: TripLiveRequest) => Promise.resolve({ data: { version: 1, fetchedAt: ETA_NOW,
    legs: request.legs.map(({ legKey, runRef }) => ({ legKey, runRef, state: 'fresh', status: 'cancelled', observedAt: ETA_NOW, expiresAt: ETA_NOW + 90_000 })) } }));
  expect(await findTripRecovery(active, requestFor(), fixAt(40.799), cancelledReason(), null)).toBeNull();
});

it('plans an onboard broken connection from the legal future alighting stop and keeps the current cursor prefix', async () => {
  const active = activeFor();
  active.cursor = { ...active.cursor, stepIndex: 1, phase: 'riding' };
  const onward = nextCandidate();
  onward.steps = onward.steps.slice(2);
  onward.id = 'from-legal-alight';
  onward.departureTime = etaAt(37);
  onward.arrivalTime = etaAt(58);
  onward.durationSeconds = 21 * 60;
  onward.transfers = 0;
  const next = onward.steps[1] as TransitStep;
  next.from.time = etaAt(40);
  next.to.time = etaAt(55);
  next.tripId = 'replacement-connection';
  next.runRef = { ...next.runRef!, tripId: next.tripId };
  callable('planTrip').mockResolvedValue({ data: { itineraries: [onward] } });
  const statuses = nativeResponse([nativeObservation(1, { arrives: etaAt(30) }), nativeObservation(3, { status: 'cancelled' })]);
  const result = await findTripRecovery(active, requestFor(), null, { kind: 'connection', stepIndex: 3, key: 'broken' }, statuses);
  expect(callable('planTrip')).toHaveBeenLastCalledWith(expect.objectContaining({ origin: expect.objectContaining((active.itinerary.steps[1] as TransitStep).to.location), time: { mode: 'depart', at: etaAt(30) } }));
  expect(result).toMatchObject({ prefixSteps: 2, keepCursor: true, origin: active.origin });
  expect(result!.itinerary.steps.slice(0, 2)).toEqual(active.itinerary.steps.slice(0, 2));
  expect(result!.resumeRequest.origin).toEqual(active.origin);
});

it('does not plan from an assumed future stop when the onboard service is cancelled or skips that stop', async () => {
  const active = activeFor();
  active.cursor = { ...active.cursor, stepIndex: 1, phase: 'riding' };
  expect(await findTripRecovery(active, requestFor(), null, cancelledReason(), nativeResponse([nativeObservation(1, { status: 'cancelled' })]))).toBeNull();
  expect(callable('planTrip')).not.toHaveBeenCalled();
});

it('preserves the completed ride when a transfer walk starts at its alighting checkpoint', async () => {
  const active = activeFor();
  const walk = active.plan.segments.find((segment) => segment.kind === 'walk' && segment.stepIndex === 2)!;
  active.cursor = { ...active.cursor, checkpointOrdinal: walk.startCheckpointOrdinal, stepIndex: 1, phase: 'transferring' };
  const onward = nativeJourney();
  onward.id = 'new-transfer-walk';
  onward.steps = onward.steps.slice(2);
  onward.departureTime = etaAt(22);
  onward.durationSeconds = 21 * 60;
  onward.transfers = 0;
  (onward.steps[0] as { path: { lat: number; lng: number }[] }).path[0] = { lat: 40.8104, lng: -73.1 };
  callable('planTrip').mockResolvedValue({ data: { itineraries: [onward] } });
  const result = await findTripRecovery(active, requestFor(), fixAt(40.8104), { kind: 'wrong-way', stepIndex: 2, key: 'transfer' }, null);
  expect(result).toMatchObject({ prefixSteps: 2, keepCursor: false, origin: active.origin });
  expect(result!.itinerary.steps[1]).toEqual(active.itinerary.steps[1]);
  expect(callable('planTrip')).toHaveBeenLastCalledWith(expect.objectContaining({ time: { mode: 'depart', at: etaAt(20) } }));
  expect(remainingWalkSeconds(active, fixAt(40.8104), ETA_NOW)).toBeDefined();
  expect(result!.startPoint).toEqual({ lat: 40.8104, lng: -73.1 });
  const runtime = createActiveTripRuntime({ itinerary: result!.itinerary, origin: result!.origin, destination: active.destination }, active.uid, ETA_NOW);
  const newWalk = runtime.plan.segments.find((segment) => segment.kind === 'walk' && segment.stepIndex === result!.prefixSteps)!;
  expect(runtime.plan.checkpoints[newWalk.startCheckpointOrdinal]!.point).toEqual(newWalk.path[0]);
  expect(runtime.plan.checkpoints[newWalk.endCheckpointOrdinal]!.point).toEqual(newWalk.path.at(-1));
  const gpsAnchor = runtime.plan.checkpoints.find((checkpoint) => checkpoint.kind === 'walk' && checkpoint.stepIndex === result!.prefixSteps
    && checkpoint.point.lat === result!.startPoint!.lat && checkpoint.point.lng === result!.startPoint!.lng)!;
  expect(gpsAnchor).toBeDefined();
  runtime.cursor = { checkpointOrdinal: gpsAnchor.ordinal, stepIndex: gpsAnchor.stepIndex, phase: gpsAnchor.phase, lastAdvancedAt: ETA_NOW };
  expect(parseTripAlertState(JSON.stringify(tripAlertState(runtime, null, ETA_NOW)), ETA_NOW)).not.toBeNull();
  expect(parseNativeSnapshot({ version: 1, kind: 'native', itinerary: result!.itinerary }, {
    origin: result!.origin, destination: active.destination, request: result!.resumeRequest, selection: createTripSelectionIdentity(result!.itinerary),
  })).not.toBeNull();
});

it('drops a completed approach walk before a fresh walk so waiting-board recovery has valid segment boundaries', async () => {
  const active = activeFor();
  const board = active.plan.checkpoints.find((checkpoint) => checkpoint.kind === 'board')!;
  active.cursor = { checkpointOrdinal: board.ordinal, stepIndex: board.stepIndex, phase: 'waiting-to-board', lastAdvancedAt: ETA_NOW };
  callable('planTrip').mockResolvedValue({ data: { itineraries: [nextCandidate()] } });
  const result = await findTripRecovery(active, requestFor(), fixAt(40.799), cancelledReason(), null);
  expect(result).toMatchObject({ prefixSteps: 0, keepCursor: false, startPoint: { lat: 40.799, lng: -73.1 } });
  expect(result!.itinerary.steps.filter((step, index, steps) => step.kind === 'walk' && steps[index + 1]?.kind === 'walk')).toHaveLength(0);
  const runtime = createActiveTripRuntime({ itinerary: result!.itinerary, origin: result!.origin, destination: active.destination }, active.uid, ETA_NOW);
  expect(parseTripAlertState(JSON.stringify(tripAlertState(runtime, null, ETA_NOW)), ETA_NOW)).not.toBeNull();
});

it('restarts native remaining navigation from GPS instead of making an unresumable legacy-prefix composite', async () => {
  const active = activeFor();
  delete (active.itinerary.steps[1] as TransitStep).runRef;
  const walk = active.plan.segments.find((segment) => segment.kind === 'walk' && segment.stepIndex === 2)!;
  active.cursor = { ...active.cursor, checkpointOrdinal: walk.startCheckpointOrdinal, stepIndex: 1, phase: 'transferring' };
  const candidate = nextCandidate();
  (candidate.steps[0] as { path: { lat: number; lng: number }[] }).path[0] = { lat: 40.8104, lng: -73.1 };
  callable('planTrip').mockResolvedValue({ data: { itineraries: [candidate] } });
  const result = await findTripRecovery(active, requestFor(), fixAt(40.8104), { kind: 'wrong-way', stepIndex: 2, key: 'legacy' }, null);
  expect(result).toMatchObject({ prefixSteps: 0, origin: { kind: 'coordinate', point: { lat: 40.8104, lng: -73.1 } } });
});

it('stops before followup live reads when the owning epoch is invalidated during planning', async () => {
  const active = activeFor();
  let current = true;
  callable('planTrip').mockImplementation(async () => { current = false; return { data: { itineraries: [nextCandidate()] } }; });
  callable('getTripLiveStatus').mockClear();
  expect(await findTripRecovery(active, requestFor(), fixAt(40.799), cancelledReason(), null, { isCurrent: () => current })).toBeNull();
  expect(callable('getTripLiveStatus')).not.toHaveBeenCalled();
});
