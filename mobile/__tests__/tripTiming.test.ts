import { createTripSelectionIdentity, guidanceForNavigation, initialNavigationCursor, normalizeItinerary } from '../src/data/enrouteNavigation';
import { legNotes } from '../src/data/tripLive';
import { projectNavigationTiming, projectTripTiming, tripLiveRequests } from '../src/data/tripTiming';
import type { TransitStep } from '../src/data/tripPlanning';
import { ETA_NOW, etaAt, nativeJourney, nativeObservation, nativeResponse, nativeRun } from './fixtures/nativeJourney';

it('projects fresh endpoint times and downstream slack without changing selected runs or the baseline', () => {
  const trip = nativeJourney();
  const before = JSON.stringify(trip);
  const projection = projectTripTiming(trip, nativeResponse([
    nativeObservation(1, { departs: etaAt(20), arrives: etaAt(30) }),
    nativeObservation(3, { departs: etaAt(40), arrives: etaAt(55) }),
  ]), ETA_NOW);
  expect(projection.arrivalTime).toBe(etaAt(58));
  expect(projection.confidence).toBe('live');
  expect(projection.connections[0]).toMatchObject({ status: 'feasible', spareSeconds: 420 });
  expect(projection.projectedItinerary.id).toBe(trip.id);
  expect((projection.projectedItinerary.steps[1] as TransitStep).runRef).toBe((trip.steps[1] as TransitStep).runRef);
  expect(JSON.stringify(trip)).toBe(before);
});

it('keeps a delayed original service catchable rather than rolling to another run after its scheduled time', () => {
  const trip = nativeJourney();
  const now = ETA_NOW + 12 * 60_000;
  const observation = nativeObservation(1, { departs: etaAt(15), arrives: etaAt(25), observedAt: now, expiresAt: now + 90_000 });
  const projection = projectTripTiming(trip, { version: 1, fetchedAt: now, legs: [observation] }, now);
  expect(projection.infeasible).toBe(false);
  expect((projection.projectedItinerary.steps[1] as TransitStep).tripId).toBe('bus-a');
  expect(projection.legs[0]!.departs).toBe(etaAt(15));
});

it('does not turn missing feeds or the passage of a timetable into a departed bus', () => {
  const trip = nativeJourney();
  const projection = projectTripTiming(trip, null, ETA_NOW + 60 * 60_000);
  expect(projection.arrivalTime).toBeNull();
  expect(projection.confidence).toBe('unavailable');
  expect(projection.infeasible).toBe(false);
  expect(projectTripTiming(trip, null, ETA_NOW).confidence).toBe('scheduled');
});

it('expires source observations even if the network response was just fetched', () => {
  const now = ETA_NOW + 120_000;
  const response = { ...nativeResponse([nativeObservation(1)]), fetchedAt: now };
  const projection = projectTripTiming(nativeJourney(), response, now);
  expect(projection.confidence).toBe('stale');
  expect(projection.arrivalTime).toBeNull();
  expect(projection.infeasible).toBe(false);
});

it('ignores wrong service dates, timetable versions, duplicate observations and future sources', () => {
  const wrong = nativeObservation(1, { runRef: nativeRun({ serviceDate: '20261123' }), departs: etaAt(30), arrives: etaAt(40) });
  expect(projectTripTiming(nativeJourney(), nativeResponse([wrong]), ETA_NOW).legs[0]!.observation).toBeNull();
  const duplicate = nativeObservation(1);
  expect(projectTripTiming(nativeJourney(), nativeResponse([duplicate, duplicate]), ETA_NOW).legs[0]!.observation).toBeNull();
  const future = nativeObservation(1, { observedAt: ETA_NOW + 31_000, expiresAt: ETA_NOW + 121_000 });
  expect(projectTripTiming(nativeJourney(), nativeResponse([future]), ETA_NOW).legs[0]!.observation).toBeNull();
});

it('does not promote an explicit arrival NO_DATA to a live destination ETA', () => {
  const projection = projectTripTiming(nativeJourney(), nativeResponse([nativeObservation(3, { arrivalNoData: true })]), ETA_NOW);
  expect(projection.arrivalTime).toBeNull();
  expect(projection.confidence).toBe('unavailable');
  expect((projection.projectedItinerary.steps[3] as TransitStep).live).toBeUndefined();
});

it('labels departure-only propagation as estimated and reports arrival lateness after boarding', () => {
  const trip = nativeJourney();
  const partial = projectTripTiming(trip, nativeResponse([nativeObservation(3, { departs: etaAt(30), arrives: undefined })]), ETA_NOW);
  expect(partial.confidence).toBe('estimated');
  expect(partial.arrivalTime).toBe(etaAt(48));
  const cursor = { ...initialNavigationCursor(normalizeItinerary(trip), ETA_NOW), stepIndex: 1, phase: 'riding' as const };
  const onboard = projectTripTiming(trip, nativeResponse([nativeObservation(1, { arrives: etaAt(40) })]), ETA_NOW, { cursor });
  expect(legNotes(onboard.projectedItinerary.steps[1] as TransitStep)[0]!.text).toBe('Live: arrival 20 min late');
});

it('disregards completed disruptions and an already-boarded skipped boarding stop', () => {
  const trip = nativeJourney();
  const cursor = { ...initialNavigationCursor(normalizeItinerary(trip), ETA_NOW), stepIndex: 3, phase: 'riding' as const };
  const response = nativeResponse([
    nativeObservation(1, { status: 'cancelled' }),
    nativeObservation(3, { status: 'skips-stop', boardSkipped: true }),
  ]);
  expect(projectTripTiming(trip, response, ETA_NOW, { cursor }).infeasible).toBe(false);
  response.legs[1]!.alightSkipped = true;
  expect(projectTripTiming(trip, response, ETA_NOW, { cursor }).infeasible).toBe(true);
});

it('uses the next service own delay to distinguish a broken connection from a recovered one', () => {
  const trip = nativeJourney();
  const delayed = nativeObservation(1, { departs: etaAt(25), arrives: etaAt(35) });
  const broken = projectTripTiming(trip, nativeResponse([delayed, nativeObservation(3)]), ETA_NOW);
  expect(broken.connections[0]).toMatchObject({ status: 'missed', confidence: 'live' });
  expect(broken.arrivalTime).toBeNull();
  expect(broken.infeasible).toBe(true);
  const recovered = projectTripTiming(trip, nativeResponse([delayed, nativeObservation(3, { departs: etaAt(45), arrives: etaAt(60) })]), ETA_NOW);
  expect(recovered.connections[0]!.status).toBe('feasible');
  expect(recovered.arrivalTime).toBe(etaAt(63));
  // An unobserved next service could itself be late; do not declare it certainly infeasible.
  expect(projectTripTiming(trip, nativeResponse([delayed]), ETA_NOW).infeasible).toBe(false);
});

it('does not add another generic margin to a walking transfer and keeps static failures conditional', () => {
  const trip = nativeJourney();
  (trip.steps[3] as TransitStep).from.time = etaAt(23);
  (trip.steps[3] as TransitStep).minimumTransferSeconds = 0;
  const projection = projectTripTiming(trip, null, ETA_NOW);
  expect(projection.connections[0]).toMatchObject({ status: 'tight', spareSeconds: 0 });
  expect(projection.arrivalTime).toBe(etaAt(43));
  (trip.steps[3] as TransitStep).from.time = etaAt(22);
  expect(projectTripTiming(trip, null, ETA_NOW).arrivalTime).toBe(etaAt(43));
});

it('strips completed live flags and keeps plan identity and progress anchors when displaying live clocks', () => {
  const trip = nativeJourney();
  (trip.steps[1] as TransitStep).live = { status: 'tracked', delaySeconds: 0 };
  const plan = normalizeItinerary(trip);
  const cursor = { ...initialNavigationCursor(plan, ETA_NOW), stepIndex: 3, phase: 'riding' as const };
  const projection = projectTripTiming(trip, nativeResponse([nativeObservation(3, { arrives: etaAt(50) })]), ETA_NOW, { cursor });
  expect((projection.projectedItinerary.steps[1] as TransitStep).live).toBeUndefined();
  const shown = projectNavigationTiming(plan, projection);
  expect(shown.selection).toBe(plan.selection);
  expect(guidanceForNavigation(shown, cursor).timing).toEqual({ confidence: projection.confidence, observedAt: projection.observedAt, expiresAt: projection.expiresAt, arrivalTime: projection.arrivalTime });
  expect(shown.checkpoints.map((checkpoint) => [checkpoint.ordinal, checkpoint.key])).toEqual(plan.checkpoints.map((checkpoint) => [checkpoint.ordinal, checkpoint.key]));
  expect(createTripSelectionIdentity(trip).native).toBeDefined();
  expect(tripLiveRequests(trip).map((leg) => leg.legKey)).toEqual(['1', '3']);
});

it('includes an authoritative same-stop minimum change margin without adding it twice', () => {
  const trip = nativeJourney();
  (trip.steps[2] as { durationSeconds: number }).durationSeconds = 0;
  (trip.steps[3] as TransitStep).minimumTransferSeconds = 120;
  const response = nativeResponse([nativeObservation(1, { arrives: etaAt(24) }), nativeObservation(3)]);
  expect(projectTripTiming(trip, response, ETA_NOW).connections[0]).toMatchObject({ status: 'missed', spareSeconds: -60 });
  (trip.steps[3] as TransitStep).minimumTransferSeconds = 0;
  expect(projectTripTiming(trip, response, ETA_NOW).connections[0]).toMatchObject({ status: 'tight', spareSeconds: 60 });
});

it('uses remaining final walking evidence without rerunning transit schedules', () => {
  const trip = nativeJourney();
  const cursor = { ...initialNavigationCursor(normalizeItinerary(trip), ETA_NOW), stepIndex: 4, phase: 'walking' as const };
  const now = ETA_NOW + 50 * 60_000;
  expect(projectTripTiming(trip, null, now, { cursor, remainingWalkSeconds: 120 })).toMatchObject({ arrivalTime: etaAt(52), confidence: 'estimated', infeasible: false });
});
