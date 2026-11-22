import AsyncStorage from '@react-native-async-storage/async-storage';
import { waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import { advanceTripAlerts } from '../src/background/tripAlertState';
import { readTripAlertState, writeTripAlertState } from '../src/background/tripAlertStorage';
import { BACKGROUND_TRIP_TASK, stopBackgroundTripAlerts, syncBackgroundTripAlerts } from '../src/background/tripAlerts.native';
import { createTripSelectionIdentity, initialNavigationCursor, normalizeItinerary, type ActiveTripRuntime } from '../src/data/enrouteNavigation';
import { readNavigationDocument } from '../src/data/navigationStorage';
import { rideGuideItinerary, type RideGuideRequest } from '../src/data/rideGuide';
import type { TripLiveResponse, TripRunRef } from '../src/data/tripLiveTypes';
import type { TransitStep } from '../src/data/tripPlanning';
import { tripDisruptionFor } from '../src/data/tripDisruptions';
import { presentTripDisruption } from '../src/data/tripDisruptionStorage';
import { auth } from '../src/lib/firebase';

type TaskEvent = { data?: { locations?: Location.LocationObject[] }; error?: unknown };
var mockTask: (event: TaskEvent) => Promise<void>;
var mockRunning = false;
var mockEvents: string[] = [];
var mockLoadStatus = jest.fn();
jest.mock('expo-task-manager', () => ({
  isAvailableAsync: jest.fn(async () => true),
  isTaskDefined: jest.fn(() => false),
  defineTask: jest.fn((_name, callback) => { mockTask = callback; }),
}));
jest.mock('expo-location', () => ({
  Accuracy: { High: 4 },
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getBackgroundPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
  requestBackgroundPermissionsAsync: jest.fn(async () => ({ granted: true })),
  hasStartedLocationUpdatesAsync: jest.fn(async () => mockRunning),
  startLocationUpdatesAsync: jest.fn(async () => { mockEvents.push('start'); mockRunning = true; }),
  stopLocationUpdatesAsync: jest.fn(async () => { mockEvents.push('stop'); mockRunning = false; }),
}));
jest.mock('../src/lib/firebase', () => {
  const actual = jest.requireActual('../src/lib/firebase');
  return { ...actual, auth: { currentUser: { uid: 'alice' }, authStateReady: async () => undefined },
    callable: (name: string, ...args: unknown[]) => name === 'getTripLiveStatus' ? (...input: unknown[]) => mockLoadStatus(...input) : actual.callable(name, ...args) };
});
jest.mock('../src/data/navigationStorage', () => ({ readNavigationDocument: jest.fn() }));

function runtime(uid = 'alice', sessionId = 'trip-a'): ActiveTripRuntime {
  const now = Date.now();
  const request: RideGuideRequest = {
    routeId: 'suffolk:51', directionIndex: 0, agency: 'Suffolk County Transit', agencyId: 'suffolk', routeIdAtAgency: '51',
    directionId: 0, mode: 'bus', routeName: 'Route 51', shortName: '51', color: '#C43D4B', headsign: 'Harbor',
    stops: [
      { name: 'Start', stopId: 'a', lat: 40.8, lon: -73.1, offsetMinutes: 0 },
      { name: 'Middle', stopId: 'b', lat: 40.81, lon: -73.1, offsetMinutes: 5 },
      { name: 'Harbor', stopId: 'c', lat: 40.82, lon: -73.1, offsetMinutes: 10 },
    ],
    departures: [{ minutes: 0, live: false }], selectedDeparture: 0, capturedAt: now, notices: [],
    walk: { minutes: 0, path: [{ lat: 40.8, lon: -73.1 }, { lat: 40.8, lon: -73.1 }] },
  };
  const itinerary = rideGuideItinerary(request, 2)!;
  const plan = normalizeItinerary(itinerary);
  return {
    uid, sessionId, itinerary, plan, selection: createTripSelectionIdentity(itinerary), evidence: null,
    startedAt: now - 10_000, updatedAt: now,
    origin: { kind: 'coordinate', label: 'Start', point: { lat: 40.8, lng: -73.1 }, savedAt: now },
    destination: { kind: 'coordinate', label: 'Harbor', point: { lat: 40.82, lng: -73.1 }, savedAt: now },
    cursor: initialNavigationCursor(plan, now),
  };
}
function setOwner(uid: string, sessionId: string) {
  Object.defineProperty(auth, 'currentUser', { configurable: true, value: { uid } });
  (readNavigationDocument as jest.Mock).mockImplementation(async (requested: string) => ({ active: requested === uid ? { sessionId } : null }));
}
function nativeRuntime() {
  const trip = runtime();
  trip.itinerary = { ...trip.itinerary, id: 'native-planned' };
  const stepIndex = trip.itinerary.steps.findIndex((step) => step.kind === 'transit');
  const step = trip.itinerary.steps[stepIndex] as TransitStep;
  const ref: TripRunRef = { version: 1, agencyId: 'suffolk', routeId: '51', tripId: 'selected-run', serviceDate: '20261122',
    scheduleVersion: 'routing-v1:test', startTime: '09:00:00', boardStopId: 'a', alightStopId: 'c', boardOccurrence: 0, alightOccurrence: 0,
    boardStopSequence: 10, alightStopSequence: 30, directionId: 0 };
  step.runRef = ref;
  trip.plan = normalizeItinerary(trip.itinerary);
  trip.selection = createTripSelectionIdentity(trip.itinerary);
  const board = trip.plan.checkpoints.find((point) => point.kind === 'board')!;
  trip.cursor = { checkpointOrdinal: board.ordinal, stepIndex, phase: 'riding', lastAdvancedAt: Date.now() - 1000 };
  setOwner(trip.uid, trip.sessionId);
  (readNavigationDocument as jest.Mock).mockImplementation(async (uid: string) => ({ active: uid === trip.uid ? {
    sessionId: trip.sessionId, selection: trip.selection, nativeSnapshot: { version: 1, kind: 'native', itinerary: trip.itinerary },
  } : null }));
  return { trip, step, stepIndex, ref };
}
function liveResponse(fixture: ReturnType<typeof nativeRuntime>, status: 'predicted' | 'cancelled' | 'skips-stop' = 'predicted', delayMinutes = 5): TripLiveResponse {
  const now = Date.now();
  return { version: 1, fetchedAt: now, legs: [{ legKey: String(fixture.stepIndex), runRef: fixture.ref, state: 'fresh', status,
    observedAt: now, expiresAt: now + 90_000,
    ...(status === 'predicted' ? { departs: new Date(Date.parse(fixture.step.from.time) + delayMinutes * 60_000).toISOString(),
      arrives: new Date(Date.parse(fixture.step.to.time) + delayMinutes * 60_000).toISOString() } : {}),
  }] };
}
const majorPosts = () => (Notifications.scheduleNotificationAsync as jest.Mock).mock.calls.filter(([value]) => value.content.data?.kind === 'active-trip-change');
const setAppState = (state: string) => Object.defineProperty(AppState, 'currentState', { configurable: true, value: state });
function positions(point: { lat: number; lng: number }, at: number): Location.LocationObject[] {
  return [at - 1, at].map((timestamp) => ({ timestamp, coords: { latitude: point.lat, longitude: point.lng, accuracy: 5,
    altitude: null, altitudeAccuracy: null, heading: null, speed: null } }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  setAppState('active');
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  await stopBackgroundTripAlerts();
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockEvents = [];
  mockRunning = false;
  mockLoadStatus.mockReset();
  mockLoadStatus.mockResolvedValue({ data: { version: 1, fetchedAt: Date.now(), legs: [] } });
  setOwner('alice', 'trip-a');
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, canAskAgain: true });
  (Location.getBackgroundPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, canAskAgain: true });
  (Location.getForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  (Notifications.scheduleNotificationAsync as jest.Mock).mockResolvedValue('notification');
  (Notifications.dismissNotificationAsync as jest.Mock).mockImplementation(async () => { mockEvents.push('dismiss'); });
});
afterEach(async () => { await stopBackgroundTripAlerts(); setAppState('active'); jest.restoreAllMocks(); jest.useRealTimers(); });

it('registers the headless task and scopes native location updates to the saved active trip', async () => {
  expect(mockTask).toBeInstanceOf(Function);
  expect(await syncBackgroundTripAlerts(runtime(), false)).toBe('active');
  expect(Location.startLocationUpdatesAsync).toHaveBeenCalledWith(BACKGROUND_TRIP_TASK, expect.objectContaining({
    distanceInterval: 15, showsBackgroundLocationIndicator: true, foregroundService: expect.objectContaining({ killServiceOnDestroy: true }),
  }));
  const saved = await readTripAlertState();
  expect(saved).toMatchObject({ uid: 'alice', sessionId: 'trip-a' });
  expect(saved).not.toHaveProperty('itinerary');
  setOwner('bob', 'trip-b');
  setAppState('background');
  await mockTask({ data: { locations: positions({ lat: 40.81, lng: -73.1 }, Date.now()) } });
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  expect(mockRunning).toBe(false);
});

it('does not consume a background permission attempt while notification permission is pending', async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, canAskAgain: true });
  expect(await syncBackgroundTripAlerts(runtime(), true)).toBe('waiting-permission');
  expect(Location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  (Location.getBackgroundPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, canAskAgain: true });
  expect(await syncBackgroundTripAlerts(runtime(), true)).toBe('active');
  expect(Location.requestBackgroundPermissionsAsync).toHaveBeenCalledTimes(1);
});

it('ignores operating-system mock locations when progressing a background trip', async () => {
  const trip = runtime();
  await syncBackgroundTripAlerts(trip, false);
  const before = await readTripAlertState();
  const next = trip.plan.checkpoints[1]!;
  setAppState('background');
  await mockTask({ data: { locations: positions(next.point, Date.now()).map((position) => ({ ...position, mocked: true })) } });
  const after = await readTripAlertState();
  expect(after?.cursor).toEqual(before?.cursor);
  expect(after?.latestFixes).toEqual([]);
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  expect(mockRunning).toBe(true);
});

it('invalidates a pending permission grant before a trip ends', async () => {
  const permission = deferred<{ granted: boolean }>();
  (Location.getBackgroundPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, canAskAgain: true });
  (Location.requestBackgroundPermissionsAsync as jest.Mock).mockReturnValueOnce(permission.promise);
  const setup = syncBackgroundTripAlerts(runtime(), true);
  await waitFor(() => expect(Location.requestBackgroundPermissionsAsync).toHaveBeenCalledTimes(1));
  await stopBackgroundTripAlerts({ uid: 'alice', sessionId: 'trip-a' });
  permission.resolve({ granted: true });
  expect(await setup).toBe('unavailable');
  expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  expect(await readTripAlertState()).toBeNull();
});

it('does not begin a new monitor if the app backgrounds during its final service check', async () => {
  const started = deferred<boolean>();
  (Location.hasStartedLocationUpdatesAsync as jest.Mock).mockReturnValueOnce(started.promise);
  const setup = syncBackgroundTripAlerts(runtime(), false);
  await waitFor(() => expect(Location.hasStartedLocationUpdatesAsync).toHaveBeenCalledTimes(1));
  setAppState('background');
  started.resolve(false);
  expect(await setup).toBe('waiting-permission');
  expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  expect(mockRunning).toBe(false);
});

it('serializes a deferred old post before end dismissal and a new owner service', async () => {
  const trip = runtime();
  await syncBackgroundTripAlerts(trip, false);
  const next = trip.plan.checkpoints[1]!;
  const posted = deferred<string>();
  (Notifications.scheduleNotificationAsync as jest.Mock).mockImplementationOnce(async () => {
    mockEvents.push('posting');
    await posted.promise;
    mockEvents.push('posted');
    return 'notification';
  });
  setAppState('background');
  const task = mockTask({ data: { locations: positions(next.point, Date.now()) } });
  await waitFor(() => expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1));
  const end = stopBackgroundTripAlerts({ uid: 'alice', sessionId: 'trip-a' });
  setOwner('bob', 'trip-b');
  setAppState('active');
  const replacement = syncBackgroundTripAlerts(runtime('bob', 'trip-b'), false);
  posted.resolve('notification');
  await Promise.all([task, end, replacement]);
  expect((await readTripAlertState())?.uid).toBe('bob');
  expect(mockRunning).toBe(true);
  expect(mockEvents.lastIndexOf('stop')).toBeLessThan(mockEvents.lastIndexOf('start'));
  expect(mockEvents.indexOf('posted')).toBeLessThan(mockEvents.lastIndexOf('dismiss'));
});

it('retries a failed approach notification without stopping GPS or claiming an undelivered warning', async () => {
  const trip = runtime();
  const middle = trip.plan.checkpoints.find((point) => point.kind === 'transit-stop')!;
  trip.cursor = { checkpointOrdinal: middle.ordinal, stepIndex: middle.stepIndex, phase: 'riding', lastAdvancedAt: Date.now() - 1000 };
  await syncBackgroundTripAlerts(trip, false);
  const now = Date.now();
  const saved = (await readTripAlertState())!;
  expect(advanceTripAlerts(saved, positions(middle.point, now).map((value) => ({ point: middle.point, capturedAt: value.timestamp, accuracyMeters: 5, source: 'real' })), now).notification?.alert).toBe(true);
  (Notifications.scheduleNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('OS unavailable'));
  setAppState('background');
  await mockTask({ data: { locations: positions(middle.point, now) } });
  expect((await readTripAlertState())?.alertedSteps).toEqual([]);
  expect(mockRunning).toBe(true);
  await mockTask({ data: { locations: positions(middle.point, now + 2) } });
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
  expect((await readTripAlertState())?.alertedSteps).toEqual([middle.stepIndex]);
  await mockTask({ data: { locations: positions(middle.point, now + 4) } });
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
});

it('stops and clears operational state when progress and disruption notifications are both disabled', async () => {
  await syncBackgroundTripAlerts(runtime(), false);
  await AsyncStorage.setItem('pathly.preferences.v1.alice', JSON.stringify({ tripGuidance: { notification: false }, notifications: { disruptions: false } }));
  setAppState('background');
  await mockTask({ data: { locations: [] } });
  expect(mockRunning).toBe(false);
  expect(await readTripAlertState()).toBeNull();
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalled();
});

it('does not restart a finished monitor when an older foreground cursor resyncs', async () => {
  const trip = runtime();
  await syncBackgroundTripAlerts(trip, false);
  const saved = (await readTripAlertState())!;
  const destination = saved.plan.checkpoints.at(-1)!;
  await writeTripAlertState({ ...saved, cursor: { checkpointOrdinal: destination.ordinal,
    stepIndex: destination.stepIndex, phase: 'arrived', lastAdvancedAt: Date.now() }, evidence: null });
  await syncBackgroundTripAlerts(trip, false);
  expect((await readTripAlertState())?.cursor.phase).toBe('arrived');
  expect(Location.startLocationUpdatesAsync).toHaveBeenCalledTimes(1);
  expect(mockRunning).toBe(false);
});

it('does not let a stale A sync poison B setup while background permission is pending', async () => {
  const permission = deferred<{ granted: boolean }>();
  (Location.getBackgroundPermissionsAsync as jest.Mock).mockReturnValueOnce(permission.promise);
  setOwner('bob', 'trip-b');
  const replacement = syncBackgroundTripAlerts(runtime('bob', 'trip-b'), false);
  await waitFor(() => expect(Location.getBackgroundPermissionsAsync).toHaveBeenCalledTimes(1));
  expect(await syncBackgroundTripAlerts(runtime('alice', 'trip-a'), false)).toBe('unavailable');
  permission.resolve({ granted: true });
  expect(await replacement).toBe('active');
  expect((await readTripAlertState())?.uid).toBe('bob');
  expect(mockRunning).toBe(true);
});

it('updates ongoing arrival silently and polls selected runs at most every 30 seconds on real wakes', async () => {
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const fixture = nativeRuntime();
  mockLoadStatus.mockResolvedValue({ data: liveResponse(fixture) });
  await syncBackgroundTripAlerts(fixture.trip, false);
  setAppState('background');
  await mockTask({ data: { locations: positions(fixture.step.from.location, now) } });
  expect(mockLoadStatus).toHaveBeenCalledTimes(1);
  expect(mockLoadStatus).toHaveBeenCalledWith({ version: 1, legs: [{ legKey: String(fixture.stepIndex), runRef: fixture.ref }] });
  const first = (Notifications.scheduleNotificationAsync as jest.Mock).mock.calls.at(-1)![0];
  expect(first.content.body).toContain('Arrive');
  expect(first.content.sound).not.toBe('default');
  expect(majorPosts()).toHaveLength(0);
  expect((await readTripAlertState())?.liveStatus?.legs[0]?.arrives).toBe(liveResponse(fixture).legs[0]?.arrives);
  now += 5_000;
  await mockTask({ data: { locations: positions(fixture.step.from.location, now) } });
  expect(mockLoadStatus).toHaveBeenCalledTimes(1);
  now += 26_000;
  await mockTask({ data: { locations: positions(fixture.step.from.location, now) } });
  expect(mockLoadStatus).toHaveBeenCalledTimes(2);
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
});

it('keeps disruption-only monitoring separate from progress and presents one major incident', async () => {
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const fixture = nativeRuntime();
  await AsyncStorage.setItem('pathly.preferences.v1.alice', JSON.stringify({ notifications: { enabled: true, disruptions: true }, tripGuidance: { notification: false } }));
  mockLoadStatus.mockResolvedValue({ data: liveResponse(fixture, 'cancelled') });
  expect(await syncBackgroundTripAlerts(fixture.trip, false)).toBe('active');
  setAppState('background');
  await mockTask({ data: { locations: positions(fixture.step.from.location, now) } });
  expect(majorPosts()).toHaveLength(1);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  now += 5_000;
  await mockTask({ data: { locations: positions(fixture.step.from.location, now) } });
  expect(majorPosts()).toHaveLength(1);
  expect(mockRunning).toBe(true);
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
});

it('does not notify about stale, unmatched or boarding-only skipped evidence while aboard', async () => {
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const fixture = nativeRuntime();
  const stale = liveResponse(fixture, 'cancelled');
  stale.legs[0]!.observedAt = now - 91_000;
  stale.legs[0]!.expiresAt = now - 1_000;
  mockLoadStatus.mockResolvedValueOnce({ data: stale });
  await syncBackgroundTripAlerts(fixture.trip, false);
  setAppState('background');
  await mockTask({ data: { locations: positions(fixture.step.from.location, now) } });
  expect(majorPosts()).toHaveLength(0);
  expect((Notifications.scheduleNotificationAsync as jest.Mock).mock.calls.at(-1)![0].content.body).toContain('Arrival updating');
  now += 31_000;
  const wrong = liveResponse(fixture, 'cancelled');
  wrong.legs[0]!.runRef = { ...fixture.ref, tripId: 'another-run' };
  mockLoadStatus.mockResolvedValueOnce({ data: wrong });
  await mockTask({ data: { locations: positions(fixture.step.from.location, now) } });
  expect(majorPosts()).toHaveLength(0);
  now += 31_000;
  const boardOnly = liveResponse(fixture, 'skips-stop');
  boardOnly.legs[0]!.boardSkipped = true;
  mockLoadStatus.mockResolvedValueOnce({ data: boardOnly });
  await mockTask({ data: { locations: positions(fixture.step.from.location, now) } });
  expect(majorPosts()).toHaveLength(0);
});

it('honors disruption opt-out while continuing silent arrival updates', async () => {
  const fixture = nativeRuntime();
  await AsyncStorage.setItem('pathly.preferences.v1.alice', JSON.stringify({ notifications: { enabled: true, disruptions: false } }));
  mockLoadStatus.mockResolvedValue({ data: liveResponse(fixture, 'predicted', 20) });
  await syncBackgroundTripAlerts(fixture.trip, false);
  setAppState('background');
  await mockTask({ data: { locations: positions(fixture.step.from.location, Date.now()) } });
  expect(mockLoadStatus).toHaveBeenCalledTimes(1);
  expect(majorPosts()).toHaveLength(0);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
});

it('discards a delayed status result after End and persists the poll throttle before requesting', async () => {
  const fixture = nativeRuntime();
  const pending = deferred<{ data: TripLiveResponse }>();
  mockLoadStatus.mockReturnValueOnce(pending.promise);
  await syncBackgroundTripAlerts(fixture.trip, false);
  setAppState('background');
  const task = mockTask({ data: { locations: positions(fixture.step.from.location, Date.now()) } });
  await waitFor(() => expect(mockLoadStatus).toHaveBeenCalledTimes(1));
  expect((await readTripAlertState())?.lastStatusAttemptAt).toEqual(expect.any(Number));
  const end = stopBackgroundTripAlerts(fixture.trip);
  pending.resolve({ data: liveResponse(fixture, 'cancelled') });
  await Promise.all([task, end]);
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  expect(await readTripAlertState()).toBeNull();
});

it('does not fetch or post a late owner response when the app foregrounds or the account changes', async () => {
  const fixture = nativeRuntime();
  await syncBackgroundTripAlerts(fixture.trip, false);
  await mockTask({ data: { locations: positions(fixture.step.from.location, Date.now()) } });
  expect(mockLoadStatus).not.toHaveBeenCalled();
  const pending = deferred<{ data: TripLiveResponse }>();
  mockLoadStatus.mockReturnValueOnce(pending.promise);
  setAppState('background');
  const task = mockTask({ data: { locations: positions(fixture.step.from.location, Date.now() + 1) } });
  await waitFor(() => expect(mockLoadStatus).toHaveBeenCalledTimes(1));
  setOwner('bob', 'trip-b');
  setAppState('active');
  pending.resolve({ data: liveResponse(fixture, 'cancelled') });
  await task;
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  expect(majorPosts()).toHaveLength(0);
});

it('shares an already presented foreground incident with the background worker', async () => {
  const fixture = nativeRuntime();
  const response = liveResponse(fixture, 'cancelled');
  const incident = tripDisruptionFor(fixture.trip.itinerary, response, fixture.trip.cursor, Date.now())!;
  expect(await presentTripDisruption(fixture.trip, incident.key, async () => true)).toBe(true);
  mockLoadStatus.mockResolvedValue({ data: response });
  await syncBackgroundTripAlerts(fixture.trip, false);
  setAppState('background');
  await mockTask({ data: { locations: positions(fixture.step.from.location, Date.now()) } });
  expect(majorPosts()).toHaveLength(0);
});

it('bounds a slow status read and shares its still-pending request on a later wake', async () => {
  jest.useFakeTimers();
  const fixture = nativeRuntime();
  const pending = deferred<{ data: TripLiveResponse }>();
  mockLoadStatus.mockReturnValue(pending.promise);
  await syncBackgroundTripAlerts(fixture.trip, false);
  setAppState('background');
  const first = mockTask({ data: { locations: positions(fixture.step.from.location, Date.now()) } });
  await waitFor(() => expect(mockLoadStatus).toHaveBeenCalledTimes(1));
  await jest.advanceTimersByTimeAsync(2_500);
  await first;
  expect(mockRunning).toBe(true);
  await jest.advanceTimersByTimeAsync(30_000);
  const second = mockTask({ data: { locations: positions(fixture.step.from.location, Date.now()) } });
  await jest.advanceTimersByTimeAsync(2_500);
  await second;
  expect(mockLoadStatus).toHaveBeenCalledTimes(1);
  pending.resolve({ data: liveResponse(fixture, 'cancelled') });
  await Promise.resolve();
  expect((await readTripAlertState())?.liveStatus).toBeUndefined();
  expect(majorPosts()).toHaveLength(0);
});
