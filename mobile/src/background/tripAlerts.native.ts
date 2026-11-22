import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Alert, AppState, Platform } from 'react-native';

import type { ActiveTripRuntime, NavigationFix } from '../data/enrouteNavigation';
import { readNavigationDocument } from '../data/navigationStorage';
import { auth } from '../lib/firebase';
import { clearTripNotification, showTripNotificationAccepted } from '../lib/notifications';
import { advanceTripAlerts, sameTripAlertOwner, tripAlertState, type TripAlertOwner } from './tripAlertState';
import { queueTripAlertWork, readTripAlertState, TRIP_ALERT_STATE_KEY, writeTripAlertState } from './tripAlertStorage';

export const BACKGROUND_TRIP_TASK = 'pathly.trip-alerts.location.v1';
export type BackgroundTripSyncStatus = 'active' | 'waiting-permission' | 'background-denied' | 'unavailable';
let configuration = 0;
let currentOwner: TripAlertOwner | null = null;
let latestRuntime: ActiveTripRuntime | null = null;

async function currentUid(): Promise<string | null> {
  await auth.authStateReady();
  return auth.currentUser?.uid ?? null;
}
async function preferencesEnabled(uid: string): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(`pathly.preferences.v1.${uid}`);
    const value = raw ? JSON.parse(raw) : null;
    return value?.notifications?.enabled !== false && value?.notifications?.tripReminders !== false && value?.tripGuidance?.notification !== false;
  } catch { return false; }
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
  return queueTripAlertWork(async () => {
    const saved = await readTripAlertState();
    if (owner && saved && !sameTripAlertOwner(saved, owner)) return;
    await AsyncStorage.removeItem(TRIP_ALERT_STATE_KEY);
    await stopNative();
    // Shares the task's queue: a deferred old post finishes before this final dismissal.
    await dismissProgress(owner ?? saved ?? undefined);
  }).catch(() => undefined);
}
async function access(owner: TripAlertOwner, request: boolean, version: number): Promise<BackgroundTripSyncStatus> {
  if (!await TaskManager.isAvailableAsync()) return 'unavailable';
  if (AppState.currentState !== 'active') return 'waiting-permission';
  if (!(await Notifications.getPermissionsAsync()).granted || !(await Location.getForegroundPermissionsAsync()).granted) return 'waiting-permission';
  const permission = await Location.getBackgroundPermissionsAsync();
  if (permission.granted) return 'active';
  if (!permission.canAskAgain) return 'background-denied';
  if (!request) return 'waiting-permission';
  if (Platform.OS === 'android') {
    const proceed = await new Promise<boolean>((resolve) => Alert.alert('Trip alerts while your phone is locked',
      'Allow location all the time on the next screen so Pathly can update your trip alerts while you use another app. Location tracking stops when you end the trip or turn trip notifications off.',
      [{ text: 'Not now', style: 'cancel', onPress: () => resolve(false) }, { text: 'Continue', onPress: () => resolve(true) }],
      { cancelable: true, onDismiss: () => resolve(false) }));
    if (!proceed) return 'background-denied';
  }
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

if (!TaskManager.isTaskDefined(BACKGROUND_TRIP_TASK)) {
  TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(BACKGROUND_TRIP_TASK, async ({ data, error }) => {
    const scheduledOwner = currentOwner;
    const version = configuration;
    await queueTripAlertWork(async () => {
      try {
        const state = await readTripAlertState();
        if (version !== configuration || (scheduledOwner && state && !sameTripAlertOwner(scheduledOwner, state))) return;
        if (error || !state || !await isCurrent(state) || !(await Location.getBackgroundPermissionsAsync()).granted
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
        await writeTripAlertState(update.state);
        if (update.finished) await stopNative();
        if (!update.notification || version !== configuration || !await isCurrent(state) || AppState.currentState === 'active') return;
        try {
          const scheduled = await showTripNotificationAccepted(update.notification.title, update.notification.body, update.notification.alert, {
            owner: state, requestPermission: false,
            isCurrent: async () => version === configuration && await isCurrent(state) && version === configuration && AppState.currentState !== 'active',
          });
          // Persist successfully scheduled warnings; OS presentation still needs device checks.
          // Foreground claims wait for this same operation.
          if (scheduled && update.approachStep != null && version === configuration && await isCurrent(state)) {
            await writeTripAlertState({ ...update.state, alertedSteps: [...new Set([...update.state.alertedSteps, update.approachStep])] });
          }
        } catch { /* Keep monitoring; an unclaimed approach can retry on the next fresh fix. */ }
      } catch {
        if (version === configuration) { await stopNative(); await dismissProgress(scheduledOwner ?? undefined); }
      }
    });
  });
}
