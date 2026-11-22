import AsyncStorage from '@react-native-async-storage/async-storage';
import { httpsCallable } from 'firebase/functions';

import { createTripSelectionIdentity, initialNavigationCursor, normalizeItinerary, sameTripSelection } from '../src/data/enrouteNavigation';
import { parseNativeSnapshot } from '../src/data/nativeSnapshot';
import { completeNavigationSession, readNavigationDocument, resetNavigationStorageForTests, updateNavigationDocument, type ActiveTripResumeV1 } from '../src/data/navigationStorage';
import { departureChoiceKey, legDepartureOptions, retimeItinerary } from '../src/data/tripDepartures';
import { planTripForResume, type Itinerary, type ResumePlanRequest, type TransitStep } from '../src/data/tripPlanning';
import { parseTripRunRef } from '../src/data/tripRunRef';
import { ETA_NOW, etaAt, nativeJourney, nativeRun, nativeObservation, nativeResponse } from './fixtures/nativeJourney';
import { createActiveTripRuntime } from '../src/hooks/useActiveTrip';
import { projectTripTiming } from '../src/data/tripTiming';

const requestFor = (trip: Itinerary): ResumePlanRequest => ({
  origin: { kind: 'coordinate', label: 'Start', point: { lat: 40.799, lng: -73.1 }, savedAt: ETA_NOW },
  destination: { kind: 'coordinate', label: 'Meeting', point: { lat: 40.823, lng: -73.1 }, savedAt: ETA_NOW },
  time: { mode: 'depart', at: trip.departureTime }, preference: 'fastest', modes: ['bus'], ferry: false,
});
const contextFor = (trip = nativeJourney()) => {
  const request = requestFor(trip);
  return { request, origin: request.origin, destination: request.destination, selection: createTripSelectionIdentity(trip) };
};

beforeEach(async () => { resetNavigationStorageForTests(); await AsyncStorage.clear(); });

it('validates actual service dates, stop visits and GTFS times beyond midnight', () => {
  expect(parseTripRunRef(nativeRun({ startTime: '25:10:00' }))).not.toBeNull();
  expect(parseTripRunRef(nativeRun({ serviceDate: '20260230' }))).toBeNull();
  expect(parseTripRunRef(nativeRun({ boardStopId: 'same', alightStopId: 'same', boardOccurrence: 0, alightOccurrence: 0 }))).toBeNull();
  expect(parseTripRunRef(nativeRun({ boardStopSequence: 3, alightStopSequence: 2 }))).toBeNull();
  expect(parseTripRunRef({ ...nativeRun(), scheduleVersion: '' })).toBeNull();
});

it('matches complete native run/schedule proof independently of a result ID while rejecting another run', () => {
  const trip = nativeJourney();
  const selected = createTripSelectionIdentity(trip);
  const newResult = { ...trip, id: 'native-fresh-result' };
  expect(sameTripSelection(selected, createTripSelectionIdentity(newResult))).toBe(true);
  const other = structuredClone(newResult);
  (other.steps[1] as TransitStep).runRef!.tripId = 'another-bus';
  expect(sameTripSelection(selected, createTripSelectionIdentity(other))).toBe(false);
  const changedTime = structuredClone(newResult);
  (changedTime.steps[1] as TransitStep).from.time = etaAt(11);
  expect(sameTripSelection(selected, createTripSelectionIdentity(changedTime))).toBe(false);
});

it('selects one of two same-clock runs and transfers its own identity rather than the original run', () => {
  const trip = nativeJourney();
  const first = trip.steps[1] as TransitStep;
  const alternate = { departs: first.from.time, arrives: first.to.time, runRef: nativeRun({ tripId: 'parallel-run' }) };
  first.departures = [{ departs: first.from.time, arrives: first.to.time, runRef: first.runRef }, alternate];
  const choices = new Map([[0, departureChoiceKey(alternate)]]);
  const selected = retimeItinerary(trip, choices, ETA_NOW);
  expect((selected.steps[1] as TransitStep).tripId).toBe('parallel-run');
  expect(legDepartureOptions(trip, choices, ETA_NOW)[0]!.filter((option) => option.selected)).toHaveLength(1);
  expect(legDepartureOptions(trip, choices, ETA_NOW)[0]!.find((option) => option.selected)!.runRef!.tripId).toBe('parallel-run');
});

it('drops an old native reference when a legacy time-only alternative has no run proof', () => {
  const trip = nativeJourney();
  const first = trip.steps[1] as TransitStep;
  first.departures = [{ departs: etaAt(15), arrives: etaAt(25) }];
  const selected = retimeItinerary(trip, new Map([[0, etaAt(15)]]), ETA_NOW);
  expect((selected.steps[1] as TransitStep).runRef).toBeUndefined();
  expect((selected.steps[1] as TransitStep).tripId).toBeUndefined();
});

it('restores a selected native journey returned under a different native result ID', async () => {
  const trip = nativeJourney();
  const callable = (httpsCallable as jest.Mock)({}, 'planTrip') as jest.Mock;
  const original = callable.getMockImplementation();
  callable.mockResolvedValue({ data: { itineraries: [{ ...trip, id: 'native-new-result' }] } });
  try {
    const result = await planTripForResume(requestFor(trip), createTripSelectionIdentity(trip));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.itinerary.id).toBe('native-new-result');
    const wrong = structuredClone(trip);
    (wrong.steps[1] as TransitStep).runRef!.serviceDate = '20261123';
    callable.mockResolvedValue({ data: { itineraries: [wrong] } });
    expect(await planTripForResume(requestFor(trip), createTripSelectionIdentity(trip))).toEqual({ ok: false, problem: 'no-exact-match' });
  } finally { callable.mockImplementation(original); }
});

it('persists only the selected native baseline and strips mutable live/departure/alert state', () => {
  const trip = nativeJourney();
  const first = trip.steps[1] as TransitStep;
  first.live = { status: 'tracked', delaySeconds: 300 };
  first.connection = { status: 'missed', spareSeconds: -60 };
  first.departures = [{ departs: etaAt(30), arrives: etaAt(40), runRef: nativeRun({ tripId: 'later' }) }];
  const parsed = parseNativeSnapshot({ version: 1, kind: 'native', itinerary: trip }, contextFor(trip));
  expect(parsed).not.toBeNull();
  const saved = parsed!.itinerary.steps[1] as TransitStep;
  expect(saved.runRef).toEqual(first.runRef);
  expect(saved.live).toBeUndefined();
  expect(saved.connection).toBeUndefined();
  expect(saved.departures).toBeUndefined();
  expect(sameTripSelection(contextFor(trip).selection, createTripSelectionIdentity(parsed!.itinerary))).toBe(true);
});

it('roundtrips an independently identified later native journey and its bounded published fare', () => {
  const trip = nativeJourney();
  const shift = (time: string) => new Date(Date.parse(time) + 15 * 60_000).toISOString();
  trip.id = 'next-reachable-bus';
  trip.departureTime = shift(trip.departureTime);
  trip.arrivalTime = shift(trip.arrivalTime);
  trip.steps = trip.steps.map((step) => step.kind === 'walk' ? step : { ...step, tripId: `${step.tripId}-next`, runRef: { ...step.runRef!, tripId: `${step.tripId}-next` },
    from: { ...step.from, time: shift(step.from.time) }, to: { ...step.to, time: shift(step.to.time) } });
  trip.fare = { text: '$3.00', cents: 300, currency: 'USD', estimated: false, lines: [{ label: 'Bus', text: '$3.00' }], reduced: { text: '$1.50', cents: 150 } };
  const context = contextFor(trip);
  const runtime = createActiveTripRuntime({ itinerary: trip, origin: context.origin, destination: context.destination }, 'alice', ETA_NOW);
  const snapshot = parseNativeSnapshot({ version: 1, kind: 'native', itinerary: runtime.itinerary }, { ...context, selection: runtime.selection });
  expect(runtime.selection.native).toBeDefined();
  expect(snapshot?.itinerary.fare).toEqual(trip.fare);
  expect(snapshot?.itinerary.id).toBe(trip.id);
});


it('rejects legacy conversion, corrupt run proof, and a snapshot for different endpoint coordinates', () => {
  const trip = nativeJourney();
  const value = { version: 1, kind: 'native', itinerary: trip };
  const legacy = contextFor(trip);
  delete legacy.selection.native;
  expect(parseNativeSnapshot(value, legacy)).toBeNull();
  const wrongRun = structuredClone(value);
  (wrongRun.itinerary.steps[1] as TransitStep).runRef!.scheduleVersion = 'different';
  expect(parseNativeSnapshot(wrongRun, contextFor(trip))).toBeNull();
  const wrongEndpoint = contextFor(trip);
  wrongEndpoint.destination = { kind: 'coordinate', label: 'Other', point: { lat: 41, lng: -73 }, savedAt: ETA_NOW };
  expect(parseNativeSnapshot(value, wrongEndpoint)).toBeNull();
});

it('roundtrips strict native live-recovery schedules with an overlapping but live-rescued transfer', () => {
  const trip = nativeJourney();
  trip.id = 'recovery:session:live-rescued';
  const second = trip.steps[3] as TransitStep;
  second.from.time = etaAt(15);
  second.to.time = etaAt(30);
  second.runRef = { ...second.runRef!, tripId: 'delayed-earlier-run' };
  second.tripId = second.runRef.tripId;
  trip.arrivalTime = etaAt(33);
  trip.durationSeconds = 25 * 60;
  const parsed = parseNativeSnapshot({ version: 1, kind: 'native', itinerary: trip }, contextFor(trip));
  expect(parsed).not.toBeNull();
  expect((parsed!.itinerary.steps[3] as TransitStep).from.time).toBe(etaAt(15));
  const live = nativeResponse([nativeObservation(1, {}, trip), nativeObservation(3, { departs: etaAt(30), arrives: etaAt(45) }, trip)]);
  expect(projectTripTiming(parsed!.itinerary, live, ETA_NOW)).toMatchObject({ arrivalTime: etaAt(48), confidence: 'live', infeasible: false });
  // The overlap relaxation cannot be used for arbitrary normal/legacy snapshots.
  const normal = { ...trip, id: 'normal-static-plan' };
  expect(parseNativeSnapshot({ version: 1, kind: 'native', itinerary: normal }, contextFor(normal))).toBeNull();
});

it('keeps a past-scheduled delayed run with a future live departure without double-counting the delay', () => {
  const trip = nativeJourney();
  trip.id = 'recovery:session:delayed-original';
  const snapshot = parseNativeSnapshot({ version: 1, kind: 'native', itinerary: trip }, contextFor(trip))!;
  const now = ETA_NOW + 12 * 60_000;
  const response = { version: 1 as const, fetchedAt: now, legs: [
    nativeObservation(1, { departs: etaAt(15), arrives: etaAt(25), observedAt: now, expiresAt: now + 90_000 }, trip),
    nativeObservation(3, { departs: etaAt(35), arrives: etaAt(50), observedAt: now, expiresAt: now + 90_000 }, trip),
  ] };
  const projected = projectTripTiming(snapshot.itinerary, response, now);
  expect(projected.arrivalTime).toBe(etaAt(53));
  expect(projected.projectedItinerary.departureTime).toBe(etaAt(13));
  expect(snapshot.itinerary.departureTime).toBe(etaAt(8));
  expect((snapshot.itinerary.steps[1] as TransitStep).from.time).toBe(etaAt(10));
});

it('keeps active native snapshots account-local and excludes their geometry from recent history', async () => {
  const trip = nativeJourney();
  const context = contextFor(trip);
  const active: ActiveTripResumeV1 = { version: 1, sessionId: 'native-session', uid: 'alice', startedAt: ETA_NOW, updatedAt: ETA_NOW,
    ...context, cursor: initialNavigationCursor(normalizeItinerary(trip), ETA_NOW), lines: [],
    nativeSnapshot: { version: 1, kind: 'native', itinerary: trip } };
  await updateNavigationDocument('alice', (current) => ({ ...current, active }), ETA_NOW);
  expect((await readNavigationDocument('alice', ETA_NOW)).active?.nativeSnapshot?.itinerary.id).toBe(trip.id);
  expect((await readNavigationDocument('bob', ETA_NOW)).active).toBeNull();
  await completeNavigationSession('alice', active.sessionId, 'arrived', ETA_NOW + 1000);
  const document = await readNavigationDocument('alice', ETA_NOW + 1000);
  expect(document.active).toBeNull();
  expect(document.recents).toHaveLength(1);
  expect(document.recents[0]).not.toHaveProperty('nativeSnapshot');
});
