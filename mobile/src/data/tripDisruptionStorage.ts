import AsyncStorage from '@react-native-async-storage/async-storage';

export const TRIP_DISRUPTION_STORAGE_PREFIX = 'pathly.trip-changes.v1.';
type Owner = { uid: string; sessionId: string };
type Ledger = { sessionId: string; expiresAt: number; entries: { key: string; dismissed: boolean }[] };
const queues = new Map<string, Promise<unknown>>();
const storageKey = (owner: Owner) => `${TRIP_DISRUPTION_STORAGE_PREFIX}${owner.uid}`;

async function read(owner: Owner, now = Date.now()): Promise<Ledger> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(owner));
    const value = raw && raw.length < 500_000 ? JSON.parse(raw) as Ledger : null;
    if (value?.sessionId === owner.sessionId && value.expiresAt > now && value.expiresAt <= now + 24 * 60 * 60_000
      && Array.isArray(value.entries) && value.entries.length <= 64
      && value.entries.every((entry) => typeof entry.key === 'string' && entry.key.length <= 12_000 && typeof entry.dismissed === 'boolean')) return value;
  } catch { /* A corrupt ledger never prevents the route from updating. */ }
  return { sessionId: owner.sessionId, expiresAt: now + 24 * 60 * 60_000, entries: [] };
}

function queue<Result>(owner: Owner, work: () => Promise<Result>): Promise<Result> {
  const key = storageKey(owner);
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}

export async function tripDisruptionDismissed(owner: Owner, key: string): Promise<boolean> {
  return (await read(owner)).entries.some((entry) => entry.key === key && entry.dismissed);
}

/** Foreground cards and the background worker share one claim per incident. */
export function presentTripDisruption(owner: Owner, key: string, deliver: () => Promise<boolean>): Promise<boolean> {
  return queue(owner, async () => {
    const ledger = await read(owner);
    if (ledger.entries.some((entry) => entry.key === key)) return false;
    if (!await deliver()) return false;
    await AsyncStorage.setItem(storageKey(owner), JSON.stringify({ ...ledger, entries: [...ledger.entries.slice(-63), { key, dismissed: false }] }));
    return true;
  });
}

export function dismissTripDisruption(owner: Owner, key: string): Promise<void> {
  return queue(owner, async () => {
    const ledger = await read(owner);
    const entries = [...ledger.entries.filter((entry) => entry.key !== key).slice(-63), { key, dismissed: true }];
    await AsyncStorage.setItem(storageKey(owner), JSON.stringify({ ...ledger, entries }));
  });
}
