import { httpsCallable } from 'firebase/functions';

import { createTripSelectionIdentity, type TripEndpointReference } from '../src/data/enrouteNavigation';
import { enrichRideGuideItinerary, rideGuideItinerary, type RideGuideRequest } from '../src/data/rideGuide';
import { parseRideSnapshot } from '../src/data/rideSnapshot';
import { departureChoiceKey, retimeItinerary } from '../src/data/tripDepartures';
import type { ResolveRideGuideRunResponse } from '../src/data/tripLiveTypes';
import type { Itinerary, ResumePlanRequest, TransitStep } from '../src/data/tripPlanning';
import { auth } from '../src/lib/firebase';
import { ETA_NOW, etaAt, nativeRun } from './fixtures/nativeJourney';

const request = (extra: Partial<RideGuideRequest> = {}): RideGuideRequest => ({
  routeId: 'suffolk:51', directionIndex: 0, agency: 'Suffolk County Transit', agencyId: 'suffolk', routeIdAtAgency: '51', directionId: 0,
  mode: 'bus', routeName: 'Route 51', shortName: '51', color: '#C43D4B', headsign: 'Harbor',
  stops: [{ name: 'Main', stopId: 'a', lat: 40.8, lon: -73.1, offsetMinutes: 0 },
    { name: 'Elm', stopId: 'x', lat: 40.805, lon: -73.1, offsetMinutes: 4 },
    { name: 'Harbor', stopId: 'b', lat: 40.81, lon: -73.1, offsetMinutes: 10 }],
  departures: [{ minutes: 12, live: true, tripId: 'bus-a', serviceDate: '20261122', stopId: 'a', stopSequence: 1, directionId: 0, departureTime: etaAt(12.5) },
    { minutes: 12, live: true, tripId: 'bus-other', serviceDate: '20261122', stopId: 'a', stopSequence: 1, directionId: 0, departureTime: etaAt(12.5) }],
  selectedDeparture: 0, walk: { minutes: 2, path: [{ lat: 40.799, lon: -73.1 }, { lat: 40.8, lon: -73.1 }] }, notices: [], capturedAt: ETA_NOW, ...extra,
});
const ride = (itinerary: Itinerary) => itinerary.steps.find((step): step is TransitStep => step.kind === 'transit')!;
const resolve = () => (httpsCallable as jest.Mock)({}, 'resolveRideGuideRun') as jest.Mock;
const response = (): ResolveRideGuideRunResponse => ({ version: 1, status: 'resolved', runRef: nativeRun(), departs: etaAt(10), arrives: etaAt(21),
  stops: [
    { stopId: 'a', occurrence: 0, stopSequence: 1, arrives: etaAt(9.5), departs: etaAt(10), name: 'Main', location: { lat: 40.8, lng: -73.1 } },
    { stopId: 'x', occurrence: 0, stopSequence: 2, arrives: etaAt(14), departs: etaAt(15), name: 'Elm', location: { lat: 40.805, lng: -73.1 } },
    { stopId: 'b', occurrence: 0, stopSequence: 3, arrives: etaAt(21), departs: etaAt(21), name: 'Harbor', location: { lat: 40.81, lng: -73.1 } },
  ] });
let original: ReturnType<jest.Mock['getMockImplementation']>;
let previousUser: typeof auth.currentUser;
beforeEach(() => {
  previousUser = auth.currentUser;
  Object.defineProperty(auth, 'currentUser', { configurable: true, writable: true, value: { uid: 'alice' } });
  original = resolve().getMockImplementation();
  resolve().mockClear().mockResolvedValue({ data: response() });
});
afterEach(() => {
  resolve().mockImplementation(original);
  Object.defineProperty(auth, 'currentUser', { configurable: true, writable: true, value: previousUser });
  jest.useRealTimers();
});

it('carries exact selected departure metadata without minute rounding or same-clock run collapse', () => {
  const itinerary = rideGuideItinerary(request(), 2)!;
  const leg = ride(itinerary);
  expect(leg.from.time).toBe(etaAt(12.5));
  expect(leg.runSeed).toMatchObject({ tripId: 'bus-a', serviceDate: '20261122', boardStopId: 'a', alightStopId: 'b', boardStopSequence: 1 });
  expect(departureChoiceKey(leg.departures![0]!)).not.toBe(departureChoiceKey(leg.departures![1]!));
});

it('resolves only the chosen run, preserves selection/endpoints, and persists canonical cold-resume evidence', async () => {
  const itinerary = rideGuideItinerary(request(), 2)!;
  const canonical = (await enrichRideGuideItinerary(itinerary))!;
  expect(resolve()).toHaveBeenCalledWith(ride(itinerary).runSeed);
  expect(canonical.id).toBe(itinerary.id);
  expect(canonical.departureTime).toBe(etaAt(8));
  expect(canonical.arrivalTime).toBe(etaAt(21));
  expect(ride(canonical)).toMatchObject({ tripId: 'bus-a', runRef: nativeRun(), durationSeconds: 660, stops: [{ name: 'Elm', time: etaAt(14) }] });
  expect(ride(canonical).live).toBeUndefined();
  expect(ride(canonical).from.location).toEqual(ride(itinerary).from.location);
  const origin: TripEndpointReference = { kind: 'coordinate', label: 'Start', point: { lat: 40.799, lng: -73.1 }, savedAt: ETA_NOW };
  const destination: TripEndpointReference = { kind: 'coordinate', label: 'Harbor', point: { lat: 40.81, lng: -73.1 }, savedAt: ETA_NOW };
  const resume: ResumePlanRequest = { origin, destination, time: { mode: 'depart', at: canonical.departureTime }, preference: 'fastest', modes: ['bus'] };
  const snapshot = parseRideSnapshot({ version: 1, itinerary: canonical }, { origin, destination, request: resume, selection: createTripSelectionIdentity(canonical) });
  expect(snapshot?.itinerary.steps.at(-1)).toMatchObject({ runRef: nativeRun(), runSeed: ride(canonical).runSeed });
});

it('clears a previous canonical identity when a distinct same-clock departure is explicitly selected', async () => {
  const original = (await enrichRideGuideItinerary(rideGuideItinerary(request(), 2)!))!;
  const leg = ride(original);
  const other = { ...leg.departures![1]!, departs: leg.from.time, arrives: leg.to.time };
  const picked = retimeItinerary({ ...original, steps: original.steps.map((step) => step === leg ? { ...leg, departures: [leg.departures![0]!, other] } : step) }, new Map([[0, departureChoiceKey(other)]]), ETA_NOW);
  expect(ride(picked).runSeed?.tripId).toBe('bus-other');
  expect(ride(picked).runRef).toBeUndefined();
  expect(ride(picked).tripId).toBeUndefined();
});

it('does not call the resolver or invent a service date for legacy predictions', async () => {
  const itinerary = rideGuideItinerary(request({ departures: [{ minutes: 12, live: true, tripId: 'bus-a' }] }), 2)!;
  expect(await enrichRideGuideItinerary(itinerary)).toBe(itinerary);
  expect(resolve()).not.toHaveBeenCalled();
});

it.each(['unknown', 'wrong-date', 'wrong-stop', 'corrupt-time'] as const)('keeps the chosen schedule-only ride on %s rather than substituting a guessed run', async (kind) => {
  const itinerary = rideGuideItinerary(request(), 2)!;
  const payload = response();
  if (payload.status !== 'resolved') throw new Error('fixture');
  if (kind === 'wrong-date') payload.runRef.serviceDate = '20261123';
  if (kind === 'wrong-stop') payload.runRef.alightStopId = 'other';
  if (kind === 'corrupt-time') payload.stops[1]!.arrives = 'invalid';
  resolve().mockResolvedValue({ data: kind === 'unknown' ? { version: 1, status: 'unknown', reason: 'ambiguous' } : payload });
  expect(await enrichRideGuideItinerary(itinerary)).toBe(itinerary);
});

it('bounds an unavailable resolver and ignores a late completion', async () => {
  jest.useFakeTimers();
  let complete!: (value: { data: ResolveRideGuideRunResponse }) => void;
  resolve().mockImplementation(() => new Promise((done) => { complete = done; }));
  const itinerary = rideGuideItinerary(request(), 2)!;
  const pending = enrichRideGuideItinerary(itinerary);
  await jest.advanceTimersByTimeAsync(2800);
  expect(await pending).toBe(itinerary);
  complete({ data: response() });
  expect(ride(itinerary).runRef).toBeUndefined();
});

it('rejects retained A work after an A→B→A generation change', async () => {
  let complete!: (value: { data: ResolveRideGuideRunResponse }) => void;
  resolve().mockImplementation(() => new Promise((done) => { complete = done; }));
  let epoch = 0;
  const pending = enrichRideGuideItinerary(rideGuideItinerary(request(), 2)!, { isCurrent: () => epoch === 0 });
  epoch = 2;
  complete({ data: response() });
  expect(await pending).toBeNull();
});

it('rejects an SDK account change while exact resolution is pending', async () => {
  let complete!: (value: { data: ResolveRideGuideRunResponse }) => void;
  resolve().mockImplementation(() => new Promise((done) => { complete = done; }));
  const pending = enrichRideGuideItinerary(rideGuideItinerary(request(), 2)!);
  Object.assign(auth, { currentUser: { uid: 'bob' } });
  complete({ data: response() });
  expect(await pending).toBeNull();
});
