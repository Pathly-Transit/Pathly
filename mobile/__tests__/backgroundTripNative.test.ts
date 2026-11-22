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
import { auth } from '../src/lib/firebase';

type TaskEvent = { data?: { locations?: Location.LocationObject[] }; error?: unknown };
var mockTask: (event: TaskEvent) => Promise<void>;
var mockRunning = false;
var mockEvents: string[] = [];
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
jest.mock('../src/lib/firebase', () => ({ ...jest.requireActual('../src/lib/firebase'), auth: { currentUser: { uid: 'alice' }, authStateReady: async () => undefined } }));
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
  setOwner('alice', 'trip-a');
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, canAskAgain: true });
  (Location.getBackgroundPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true, canAskAgain: true });
  (Location.getForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  (Notifications.scheduleNotificationAsync as jest.Mock).mockResolvedValue('notification');
  (Notifications.dismissNotificationAsync as jest.Mock).mockImplementation(async () => { mockEvents.push('dismiss'); });
});
afterEach(async () => { await stopBackgroundTripAlerts(); setAppState('active'); });

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

it('stops and clears operational state when trip notifications are disabled', async () => {
  await syncBackgroundTripAlerts(runtime(), false);
  await AsyncStorage.setItem('pathly.preferences.v1.alice', JSON.stringify({ tripGuidance: { notification: false } }));
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
