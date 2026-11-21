import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

export { registerForRouteAlerts } from './routeAlertRegistration';

/** The one trip-progress notification, updated in place as the trip moves along. */
export const TRIP_NOTIFICATION_ID = 'pathly-trip-progress';
const TRIP_CHANNEL = 'trip-progress';
const TRIP_ALERT_CHANNEL = 'trip-alerts';

// Notifications that arrive while Pathly is open still show as a banner and play a sound, except
// the trip's own progress notification: the open trip screen already shows (and speaks) each step.
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const trip = notification.request.identifier === TRIP_NOTIFICATION_ID;
      return { shouldPlaySound: !trip, shouldSetBadge: false, shouldShowBanner: !trip, shouldShowList: true };
    },
  });
}

let tripChannelsReady: Promise<void> | null = null;
let tripNotificationVersion = 0;
let tripNotificationWork: Promise<void> = Promise.resolve();
export type TripNotificationOwner = { uid: string; sessionId: string };
let tripNotificationOwner: string | null = null;
let tripNotificationPendingOwner: string | null = null;
let tripPermissionWork: Promise<boolean> | null = null;
const ownerKey = (owner: TripNotificationOwner) => JSON.stringify([owner.uid, owner.sessionId]);

/** OS mutations are ordered: a late native post must finish before its dismissal. */
function queueTripNotification(work: () => Promise<void>): Promise<void> {
  const next = tripNotificationWork.catch(() => undefined).then(work);
  tripNotificationWork = next;
  return next;
}

/** Android: routine steps update quietly; the stop before getting off (and arrival) alerts. */
function tripChannels(): Promise<void> {
  tripChannelsReady ??= Promise.all([
    Notifications.setNotificationChannelAsync(TRIP_CHANNEL, {
      name: 'Trip progress',
      importance: Notifications.AndroidImportance.LOW,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      showBadge: false,
    }),
    Notifications.setNotificationChannelAsync(TRIP_ALERT_CHANNEL, {
      name: 'Trip alerts',
      description: 'The stop before yours, and arriving',
      importance: Notifications.AndroidImportance.HIGH,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      vibrationPattern: [0, 250, 150, 250],
    }),
  ]).then(() => undefined).catch((error) => {
    tripChannelsReady = null;
    throw error;
  });
  return tripChannelsReady;
}

function defaultChannel(): Promise<unknown> {
  return Notifications.setNotificationChannelAsync('default', { name: 'Service alerts', importance: Notifications.AndroidImportance.HIGH });
}

/** Interactive permission preparation belongs outside both OS-post and approach-ledger queues. */
export async function prepareTripNotificationPermissions(request = true, isCurrent: () => boolean | Promise<boolean> = () => true): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    if (!await isCurrent()) return false;
    if (Platform.OS === 'android') await tripChannels();
    if (!await isCurrent()) return false;
    if (!request || AppState.currentState !== 'active') return (await Notifications.getPermissionsAsync()).granted;
    tripPermissionWork ??= notificationsAllowed().finally(() => { tripPermissionWork = null; });
    return await tripPermissionWork;
  } catch { return false; }
}

/**
 * Shows the trip's progress in the notification shade and on the lock screen, replacing the last
 * update. `alert` (the stop before getting off, arriving) sounds and pops up; other steps update
 * quietly. Android keeps it from being swiped away until the trip ends. Native only; never throws.
 */
export async function showTripNotificationAccepted(title: string, body: string, alert: boolean, options: {
  owner?: TripNotificationOwner;
  requestPermission?: boolean;
  isCurrent?: () => boolean | Promise<boolean>;
} = {}): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try { if (options.isCurrent && !await options.isCurrent()) return false; } catch { return false; }
  const version = ++tripNotificationVersion;
  const requestedOwner = options.owner ? ownerKey(options.owner) : null;
  tripNotificationPendingOwner = requestedOwner;
  let accepted = false;
  const current = async () => version === tripNotificationVersion && (!options.isCurrent || await options.isCurrent());
  try {
    // Android needs a channel before its first notification permission prompt can appear.
    if (!await current() || !(await prepareTripNotificationPermissions(options.requestPermission !== false, current)) || !await current()) return false;
    await queueTripNotification(async () => {
      if (!await current()) return;
      await Notifications.scheduleNotificationAsync({
        identifier: TRIP_NOTIFICATION_ID,
        content: {
          title,
          body,
          sticky: true,
          autoDismiss: false,
          sound: alert ? 'default' : undefined,
          // iOS: routine steps go straight to the list without lighting the screen.
          interruptionLevel: alert ? 'active' : 'passive',
        },
        trigger: Platform.OS === 'android' ? { channelId: alert ? TRIP_ALERT_CHANNEL : TRIP_CHANNEL } : null,
      });
      tripNotificationOwner = requestedOwner;
      accepted = true;
    });
  } catch {
    // The notification is a convenience; never let it break navigation.
  }
  return accepted;
}

/** Backwards-compatible convenience API; callers needing a delivery claim use acceptance above. */
export async function showTripNotification(title: string, body: string, alert: boolean): Promise<void> {
  await showTripNotificationAccepted(title, body, alert);
}

/** Removes the trip's progress notification (the trip ended). */
export async function clearTripNotification(owner?: TripNotificationOwner): Promise<void> {
  if (Platform.OS === 'web') return;
  const matches = () => !owner || tripNotificationOwner === null || tripNotificationOwner === ownerKey(owner);
  if (!matches()) return;
  // Invalidate pending permission/channel work before waiting for any native operation.
  // An old owner's cleanup must not cancel B's pending permission/channel/post work.
  if (!owner || tripNotificationPendingOwner === ownerKey(owner)) tripNotificationVersion += 1;
  try {
    await queueTripNotification(async () => {
      if (!matches()) return;
      const clearedOwner = tripNotificationOwner;
      await Notifications.dismissNotificationAsync(TRIP_NOTIFICATION_ID);
      if (tripNotificationOwner === clearedOwner) tripNotificationOwner = null;
    });
  } catch {
    // Already gone.
  }
}

/** Asks once; later calls only report what the rider chose. */
async function notificationsAllowed(request = true): Promise<boolean> {
  if (Platform.OS === 'web') {
    if (typeof Notification === 'undefined') return false;
    if (request && Notification.permission === 'default') return (await Notification.requestPermission()) === 'granted';
    return Notification.permission === 'granted';
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!request || !current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/**
 * Shows a notification right away (the GO "hurry up" nudge). Silently does nothing when the rider
 * hasn't allowed notifications; the in-app banner says the same thing.
 */
export async function notifyNow(title: string, body: string): Promise<void> {
  try {
    if (Platform.OS === 'android') await defaultChannel();
    if (!(await notificationsAllowed())) return;
    if (Platform.OS === 'web') {
      new Notification(title, { body, icon: '/favicon.png' });
      return;
    }
    await Notifications.scheduleNotificationAsync({ content: { title, body, sound: 'default' }, trigger: Platform.OS === 'android' ? { channelId: 'default' } : null });
  } catch {
    // A notification is a convenience; never let it break navigation.
  }
}
