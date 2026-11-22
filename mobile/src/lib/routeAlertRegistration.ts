import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { httpsCallable } from 'firebase/functions';
import { AppState, Platform } from 'react-native';

import { functions } from './firebase';

const STORAGE_KEY = 'pathly.pushInstallation.v1';
type Installation = { installationId: string; capability: string; revision: number; ownerUid: string | null; token: string | null; retiredTokens: string[]; pending: boolean };
// Deliberately bypass callable's admin request logger: installation capabilities must never be logged.
const updateInstallation = httpsCallable<Omit<Installation, 'pending'>, { applied: boolean }>(functions, 'updatePushInstallation', { timeout: 5_000 });
let installation: Installation | null | undefined;
let loading: Promise<void> | undefined;
let mutations: Promise<unknown> = Promise.resolve();
let desiredOwner: string | null | undefined;
let generation = 0;
let sending: Promise<boolean> | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let nativeUnregisterWork: Promise<void> = Promise.resolve();

function unregisterNative(): void {
  nativeUnregisterWork = nativeUnregisterWork.catch(() => undefined).then(async () => {
    await Notifications.unregisterForNotificationsAsync?.();
  }).catch(() => undefined);
}

async function load(): Promise<void> {
  loading ??= AsyncStorage.getItem(STORAGE_KEY).then((json) => {
    const value = json ? JSON.parse(json) as Installation : null;
    if (value) value.retiredTokens ??= [];
    installation = value && /^[a-zA-Z0-9-]{20,80}$/.test(value.installationId) && /^[a-f0-9]{64}$/.test(value.capability)
      && Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.pending === 'boolean'
      && (value.ownerUid === null || (typeof value.ownerUid === 'string' && value.ownerUid.length <= 128))
      && (value.token === null || (typeof value.token === 'string' && value.token.length <= 240))
      && Array.isArray(value.retiredTokens) && value.retiredTokens.length <= 4 && value.retiredTokens.every((token) => typeof token === 'string' && token.length <= 240) ? value : null;
  }).catch(() => { installation = null; });
  await loading;
}

function scheduleRetry(): void {
  if (retry) clearTimeout(retry);
  if (!installation?.pending) return;
  retry = setTimeout(() => {
    retry = undefined;
    if (AppState.currentState === 'active') void flush();
    else scheduleRetry();
  }, 30_000);
}

/** Only lightweight local journal writes are serialized; slow network work never delays revocation. */
function intent(ownerUid: string | null, token: string | null, version: number): Promise<boolean> {
  const work = mutations.catch(() => undefined).then(async () => {
    await load();
    if (version !== generation || (ownerUid && ownerUid !== desiredOwner)) return false;
    if (!installation) {
      if (!ownerUid) return false;
      const random = await Crypto.getRandomBytesAsync(32);
      if (version !== generation || ownerUid !== desiredOwner) return false;
      installation = { installationId: Crypto.randomUUID(), capability: [...random].map((n) => n.toString(16).padStart(2, '0')).join(''), revision: 0, ownerUid: null, token: null, retiredTokens: [], pending: false };
    }
    // Carry the first retired tokens across offline retries, including legacy migration when
    // revoke reaches the server before the first new-style registration did.
    const retiredTokens = [...new Set([...installation.retiredTokens, ...(installation.token && installation.token !== token ? [installation.token] : [])])].filter((old) => old !== token).slice(0, 4);
    const next: Installation = { ...installation, revision: installation.revision + 1, ownerUid, token, retiredTokens, pending: true };
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      // A storage fault must not keep somebody signed in. Cleanup can still be sent now; a
      // later signed-out launch retries from the previous durable installation capability.
      if (ownerUid) throw error;
    }
    installation = next;
    return true;
  });
  mutations = work;
  return work;
}

async function flush(): Promise<boolean> {
  if (sending) return sending;
  sending = (async () => {
    await mutations.catch(() => undefined);
    let accepted = false;
    while (installation?.pending) {
      const snapshot = installation;
      if (snapshot.ownerUid && snapshot.ownerUid !== desiredOwner) return false;
      try {
        const { pending: _pending, ...request } = snapshot;
        const result = await updateInstallation(request);
        if (installation.revision !== snapshot.revision) continue;
        if (result.data.applied !== true) {
          // A stale/rejected server revision is not a successful registration. Keep the
          // journal pending rather than reporting readiness on the next foreground refresh.
          scheduleRetry();
          return false;
        }
        // Serialize the acknowledgement with newer local intents, too: an old response must
        // never overwrite a newer pending revoke in persistent storage.
        const acknowledge = mutations.catch(() => undefined).then(async () => {
          if (installation?.revision !== snapshot.revision) return;
          const next = { ...snapshot, pending: false };
          await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          installation = next;
        });
        mutations = acknowledge;
        await acknowledge;
        accepted = result.data.applied === true;
      } catch {
        scheduleRetry();
        return false;
      }
    }
    return accepted;
  })().finally(() => { sending = null; });
  return sending;
}

async function refreshOwner(uid: string, ask: boolean, version = generation): Promise<boolean> {
  if (Platform.OS === 'web' || desiredOwner !== uid) return false;
  try {
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Service alerts', importance: Notifications.AndroidImportance.HIGH });
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && ask && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
    if (version !== generation || desiredOwner !== uid) return false;
    if (!permission.granted) {
      await load();
      if (installation?.ownerUid) await intent(null, null, version);
      void flush();
      return false;
    }
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    // A delayed native unregister must finish before B obtains a new token; otherwise it can
    // invalidate B's token after a seemingly successful account switch.
    await nativeUnregisterWork;
    if (version !== generation || desiredOwner !== uid) return false;
    const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    if (version !== generation || desiredOwner !== uid) return false;
    await load();
    if (installation?.ownerUid === uid && installation.token === token) return installation.pending ? await flush() : true;
    if (!(await intent(uid, token, version))) return false;
    return await flush();
  } catch {
    // No credentials/capabilities are logged. A pending journal entry retries on foreground/network recovery.
    return false;
  }
}

/** Updates ownership immediately; journal revocation survives logout, app restart and offline failures. */
export async function setRouteAlertOwner(user: { uid: string; isAnonymous?: boolean } | null): Promise<void> {
  if (Platform.OS === 'web') return;
  const nextOwner = user && !user.isAnonymous ? user.uid : null;
  desiredOwner = nextOwner;
  const version = ++generation;
  if (!nextOwner) unregisterNative();
  await load();
  if (version !== generation) return;
  if (installation?.ownerUid && installation.ownerUid !== nextOwner) {
    await intent(null, null, version);
    if (version !== generation) return;
    // Native unregister is best effort: OS/network delivery cannot be retroactively revoked offline.
    if (nextOwner) unregisterNative();
    void flush();
  }
  if (installation?.pending) void flush();
  if (nextOwner && version === generation) void refreshOwner(nextOwner, false, version);
}

/** Called before Firebase sign-out. Persists cleanup without waiting on the network request. */
export async function unregisterRouteAlerts(): Promise<void> {
  await setRouteAlertOwner(null);
}

export function registerForRouteAlerts(uid: string): Promise<boolean> {
  return refreshOwner(uid, true);
}

/** Permission/token changes and reconnecting/returning to the app reconcile without prompting. */
export function observeRouteAlertRegistration(): () => void {
  if (Platform.OS === 'web') return () => undefined;
  const reconcile = () => {
    if (desiredOwner) void refreshOwner(desiredOwner, false);
    else void load().then(() => flush());
  };
  const app = AppState.addEventListener('change', (state) => { if (state === 'active') reconcile(); });
  const token = Notifications.addPushTokenListener?.(reconcile);
  return () => { app.remove(); token?.remove(); if (retry) clearTimeout(retry); retry = undefined; };
}

/** Unit-test isolation; persistent storage is managed separately by the test. */
export function resetRouteAlertRegistrationForTests(): void {
  if (retry) clearTimeout(retry);
  retry = undefined; installation = undefined; loading = undefined; desiredOwner = undefined;
  generation += 1; mutations = Promise.resolve(); sending = null;
  nativeUnregisterWork = Promise.resolve();
}
