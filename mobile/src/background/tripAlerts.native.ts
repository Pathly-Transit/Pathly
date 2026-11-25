import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { AppState, Platform } from 'react-native';

import { guidanceForNavigation, type ActiveTripRuntime, type NavigationFix } from '../data/enrouteNavigation';
import { readNavigationDocument } from '../data/navigationStorage';
import { tripNotificationContent } from '../data/tripAnnouncements';
import { tripDisruptionFor } from '../data/tripDisruptions';
import { presentTripDisruption } from '../data/tripDisruptionStorage';
import type { TripLiveRequest, TripLiveResponse } from '../data/tripLiveTypes';
import type { Itinerary } from '../data/tripPlanning';
import { projectNavigationTiming, projectTripTiming, tripLiveRequests } from '../data/tripTiming';
import { auth, callable } from '../lib/firebase';
import { clearTripNotification, notifyTripDisruptionAccepted, showTripNotificationAccepted } from '../lib/notifications';
import { advanceTripAlerts, parseBackgroundLiveStatus, sameTripAlertOwner, tripAlertState, type TripAlertOwner, type TripAlertState } from './tripAlertState';
import { queueTripAlertWork, readTripAlertState, TRIP_ALERT_STATE_KEY, writeTripAlertState } from './tripAlertStorage';

export const BACKGROUND_TRIP_TASK = 'pathly.trip-alerts.location.v1';
export const BACKGROUND_TRIP_STATUS_INTERVAL_MS = 30_000;
const BACKGROUND_STATUS_TIMEOUT_MS = 2_500;
const loadTripStatus = callable<TripLiveRequest, TripLiveResponse>('getTripLiveStatus');
export type BackgroundTripSyncStatus = 'active' | 'waiting-permission' | 'background-denied' | 'unavailable';
let configuration = 0;
let currentOwner: TripAlertOwner | null = null;
let latestRuntime: ActiveTripRuntime | null = null;
let liveRequest: { key: string; promise: Promise<TripLiveResponse | null> } | null = null;

async function currentUid(): Promise<string | null> {
  await auth.authStateReady();
  return auth.currentUser?.uid ?? null;
}
async function backgroundPreferences(uid: string): Promise<{ progress: boolean; disruptions: boolean }> {
  try {
    const raw = await AsyncStorage.getItem(`pathly.preferences.v1.${uid}`);
    const value = raw ? JSON.parse(raw) : null;
    const enabled = value?.notifications?.enabled !== false;
    return { progress: enabled && value?.notifications?.tripReminders !== false && value?.tripGuidance?.notification !== false,
      disruptions: enabled && value?.notifications?.disruptions !== false };
  } catch { return { progress: false, disruptions: false }; }
}
async function preferencesEnabled(uid: string): Promise<boolean> {
  const preferences = await backgroundPreferences(uid);
  return preferences.progress || preferences.disruptions;
}
async function runtimeCurrent(owner: TripAlertOwner): Promise<boolean> {
  if (await currentUid() !== owner.uid || !await preferencesEnabled(owner.uid)) return false;
  return (await readNavigationDocument(owner.uid)).active?.sessionId === owner.sessionId;
}
async function isCurrent(owner: TripAlertOwner): Promise<boolean> {
  return await runtimeCurrent(owner) && sameTripAlertOwner(await readTripAlertState(), owner);
}
async function stopNative() {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TRIP_TASK)) await Location.stopLocationUpdatesAsync(BACKGROUND_TRIP_TASK);
  } catch { /* A matching native build may not be installed. */ }
}
async function dismissProgress(owner?: TripAlertOwner) {
  await clearTripNotification(owner);
}
export function stopBackgroundTripAlerts(owner?: TripAlertOwner): Promise<void> {
  if (owner && currentOwner && !sameTripAlertOwner(currentOwner, owner)) return Promise.resolve();
  configuration += 1; // Invalidate permission/channel work before any await.
  currentOwner = null;
  latestRuntime = null;
  liveRequest = null;
  return queueTripAlertWork(async () => {
    const saved = await readTripAlertState();
    if (owner && saved && !sameTripAlertOwner(saved, owner)) return;
    await AsyncStorage.removeItem(TRIP_ALERT_STATE_KEY);
    await stopNative();
    // Shares the task's queue: a deferred old post finishes before this final dismissal.
    await dismissProgress(owner ?? saved ?? undefined);
  }).catch(() => undefined);
}
/** Whether the trip's tracking may go on: location while using the app on Android (a foreground service), always on iOS. */
async function trackingAllowed(): Promise<boolean> {
  return Platform.OS === 'android' ? (await Location.getForegroundPermissionsAsync()).granted : (await Location.getBackgroundPermissionsAsync()).granted;
}
async function access(owner: TripAlertOwner, request: boolean, version: number): Promise<BackgroundTripSyncStatus> {
  if (!await TaskManager.isAvailableAsync()) return 'unavailable';
  if (AppState.currentState !== 'active') return 'waiting-permission';
  if (!(await Notifications.getPermissionsAsync()).granted || !(await Location.getForegroundPermissionsAsync()).granted) return 'waiting-permission';
  // Android: the trip's tracking runs as a foreground service (its "Pathly trip alerts" notification),
  // started while Pathly is open, which keeps location while the phone is locked with the
  // while-using permission alone. The app asks for no background location there (app.config.js).
  if (Platform.OS === 'android') return 'active';
  const permission = await Location.getBackgroundPermissionsAsync();
  if (permission.granted) return 'active';
  if (!permission.canAskAgain) return 'background-denied';
  if (!request) return 'waiting-permission';
  if (version !== configuration || AppState.currentState !== 'active' || !await runtimeCurrent(owner)) return 'unavailable';
  return (await Location.requestBackgroundPermissionsAsync()).granted ? 'active' : 'background-denied';
}
export async function syncBackgroundTripAlerts(runtime: ActiveTripRuntime, requestPermission: boolean): Promise<BackgroundTripSyncStatus> {
  const generation = configuration;
  const owner = { uid: runtime.uid, sessionId: runtime.sessionId };
  try {
    // Do not stop the service simply because React delivered a late update while suspended.
    if (AppState.currentState !== 'active') return 'waiting-permission';
    const status = await access(owner, requestPermission, generation);
    if (generation !== configuration || !await runtimeCurrent(owner)) return 'unavailable';
    if (status !== 'active') {
      if (sameTripAlertOwner(currentOwner, owner)) await stopBackgroundTripAlerts(owner);
      return status;
    }
    // A stale account's late permission result must not replace B's pending runtime.
    latestRuntime = runtime;
    return await queueTripAlertWork(async () => {
      if (generation !== configuration || !await runtimeCurrent(owner)) return 'unavailable';
      const newest = latestRuntime;
      if (!newest || !sameTripAlertOwner(newest, owner)) return 'unavailable';
      const previous = await readTripAlertState();
      const sameOwner = sameTripAlertOwner(previous, owner);
      if (previous && !sameOwner) { await stopNative(); await dismissProgress(previous); }
      const prepared = tripAlertState(newest, sameOwner ? previous : null);
      await writeTripAlertState(prepared);
      currentOwner = owner;
      if (generation !== configuration || !await isCurrent(owner)) return 'unavailable';
      if (prepared.cursor.phase === 'arrived') { await stopNative(); return 'active'; }
      if (!await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TRIP_TASK)) {
        if (AppState.currentState !== 'active') return 'waiting-permission';
        await Location.startLocationUpdatesAsync(BACKGROUND_TRIP_TASK, {
          accuracy: Location.Accuracy.High, timeInterval: 5_000, distanceInterval: 15,
          deferredUpdatesInterval: 5_000, pausesUpdatesAutomatically: false,
          showsBackgroundLocationIndicator: true,
          foregroundService: { notificationTitle: 'Pathly trip alerts', notificationBody: 'Updating your active trip. End the trip in Pathly to stop location tracking.', killServiceOnDestroy: true },
        });
      }
      if (generation !== configuration || !await runtimeCurrent(owner)) { await stopNative(); return 'unavailable'; }
      return 'active';
    });
  } catch {
    // No state belonging to this failed setup may keep collecting GPS.
    if (generation === configuration) await stopBackgroundTripAlerts(owner);
    return 'unavailable';
  }
}
export async function resumeBackgroundTripFixes(owner: TripAlertOwner): Promise<NavigationFix[]> {
  try {
    const state = await readTripAlertState();
    return state && sameTripAlertOwner(state, owner) && await currentUid() === owner.uid ? state.latestFixes : [];
  } catch { return []; }
}

async function selectedItinerary(state: TripAlertState): Promise<Itinerary | null> {
  const active = (await readNavigationDocument(state.uid)).active;
  return active?.sessionId === state.sessionId && active.selection?.fingerprint === state.plan.selection.fingerprint
    && active.selection.itineraryId === state.plan.itineraryId ? active.nativeSnapshot?.itinerary ?? active.rideSnapshot?.itinerary ?? null : null;
}

async function refreshLiveStatus(state: TripAlertState, itinerary: Itinerary, now: number, valid: () => Promise<boolean>): Promise<TripAlertState> {
  if (state.lastStatusAttemptAt !== undefined && now - state.lastStatusAttemptAt < BACKGROUND_TRIP_STATUS_INTERVAL_MS) return state;
  const legs = tripLiveRequests(itinerary);
  if (legs.length === 0) return state;
  const attempted = { ...state, lastStatusAttemptAt: now };
  // Persist before awaiting the network so a headless restart observes the same throttle.
  await writeTripAlertState(attempted);
  if (!await valid()) return attempted;
  const request: TripLiveRequest = { version: 1, legs };
  const key = JSON.stringify([state.uid, state.sessionId, state.plan.selection.fingerprint, request]);
  if (liveRequest?.key !== key) {
    const pending = { key, promise: loadTripStatus(request).then(({ data }) => parseBackgroundLiveStatus(data)).catch(() => null) };
    liveRequest = pending;
    void pending.promise.finally(() => { if (liveRequest === pending) liveRequest = null; }).catch(() => undefined);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), BACKGROUND_STATUS_TIMEOUT_MS); });
  const response = await Promise.race([liveRequest.promise, timeout]);
  if (timer) clearTimeout(timer);
  return { ...attempted, ...(response ? { liveStatus: response } : {}) };
}

if (!TaskManager.isTaskDefined(BACKGROUND_TRIP_TASK)) {
  TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(BACKGROUND_TRIP_TASK, async ({ data, error }) => {
    const scheduledOwner = currentOwner;
    const version = configuration;
    await queueTripAlertWork(async () => {
      try {
        const state = await readTripAlertState();
        if (version !== configuration || (scheduledOwner && state && !sameTripAlertOwner(scheduledOwner, state))) return;
        if (error || !state || !await isCurrent(state) || !await trackingAllowed()
          || !(await Notifications.getPermissionsAsync()).granted) {
          // Stop while still in the queue, before a replacement session can start its service.
          await AsyncStorage.removeItem(TRIP_ALERT_STATE_KEY);
          await stopNative();
          await dismissProgress(state ?? scheduledOwner ?? undefined);
          return;
        }
        if (AppState.currentState === 'active') return;
        const fixes: NavigationFix[] = (data?.locations ?? []).map((position) => ({ point: { lat: position.coords.latitude, lng: position.coords.longitude },
          capturedAt: position.timestamp, accuracyMeters: position.coords.accuracy, source: position.mocked ? 'mock' : 'real' }));
        const update = advanceTripAlerts(state, fixes);
        if (version !== configuration || !await isCurrent(state)) return;
        const acceptedFix = (update.state.latestFixes.at(-1)?.capturedAt ?? -1) > (state.latestFixes.at(-1)?.capturedAt ?? -1);
        const itinerary = acceptedFix && !update.finished ? await selectedItinerary(update.state) : null;
        let nextState = itinerary ? await refreshLiveStatus(update.state, itinerary, Date.now(), async () => version === configuration
          && AppState.currentState !== 'active' && await isCurrent(state) && Boolean(await selectedItinerary(update.state))) : update.state;
        if (version !== configuration || !await isCurrent(state) || AppState.currentState === 'active'
          || (itinerary && !await selectedItinerary(nextState))) return;
        await writeTripAlertState(nextState);
        if (update.finished) await stopNative();
        if (!acceptedFix) return;
        const projectionNow = () => itinerary ? projectTripTiming(itinerary, nextState.liveStatus ?? null, Date.now(), { cursor: nextState.cursor }) : null;
        const progressContent = () => {
          const projection = projectionNow();
          const plan = projection ? projectNavigationTiming(nextState.plan, projection) : nextState.plan;
          return tripNotificationContent(guidanceForNavigation(plan, nextState.cursor));
        };
        const current = async () => version === configuration && AppState.currentState !== 'active' && await isCurrent(state)
          && version === configuration && (!itinerary || Boolean(await selectedItinerary(nextState)))
          && version === configuration && AppState.currentState !== 'active' && auth.currentUser?.uid === state.uid;
        const preferences = await backgroundPreferences(state.uid);
        const projection = projectionNow();
        const matched = projection && nextState.liveStatus ? { ...nextState.liveStatus,
          legs: projection.legs.flatMap((leg) => leg.observation ? [leg.observation] : []) } : null;
        const disruption = itinerary && projection ? tripDisruptionFor(itinerary, matched, nextState.cursor, Date.now(), projection.arrivalTime) : null;
        if (preferences.disruptions && disruption && await current()) {
          await presentTripDisruption(state, disruption.key, () => notifyTripDisruptionAccepted(disruption.key, disruption.title, disruption.body, async () => {
            if (!await current() || !(await backgroundPreferences(state.uid)).disruptions) return false;
            const fresh = projectionNow();
            const response = fresh && nextState.liveStatus ? { ...nextState.liveStatus,
              legs: fresh.legs.flatMap((leg) => leg.observation ? [leg.observation] : []) } : null;
            return Boolean(itinerary && tripDisruptionFor(itinerary, response, nextState.cursor, Date.now(), fresh?.arrivalTime)?.key === disruption.key);
          }));
        }
        if (!preferences.progress || !await current()) return;
        const content = progressContent();
        const contentKey = JSON.stringify(content);
        if (!update.notification && nextState.lastProgressContent === contentKey) return;
        try {
          const scheduled = await showTripNotificationAccepted(content.title, content.body, update.approachStep !== null, {
            owner: state, requestPermission: false,
            isCurrent: async () => await current() && (await backgroundPreferences(state.uid)).progress && JSON.stringify(progressContent()) === contentKey,
          });
          // Persist successfully scheduled warnings; OS presentation still needs device checks.
          // Foreground claims wait for this same operation.
          if (scheduled && version === configuration && await isCurrent(state)) {
            nextState = { ...nextState, lastProgressContent: contentKey,
              ...(update.approachStep !== null ? { alertedSteps: [...new Set([...nextState.alertedSteps, update.approachStep])] } : {}) };
            await writeTripAlertState(nextState);
          }
        } catch { /* Keep monitoring; an unclaimed approach can retry on the next fresh fix. */ }
      } catch {
        if (version === configuration) { await stopNative(); await dismissProgress(scheduledOwner ?? undefined); }
      }
    });
  });
}
