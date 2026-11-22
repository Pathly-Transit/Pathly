import AsyncStorage from '@react-native-async-storage/async-storage';

import { parseTripAlertState, sameTripAlertOwner, type TripAlertOwner, type TripAlertState } from './tripAlertState';

export const TRIP_ALERT_STATE_KEY = 'pathly.background-trip-alerts.v1';
let work: Promise<unknown> = Promise.resolve();
export function queueTripAlertWork<T>(action: () => Promise<T>): Promise<T> {
  const next = work.catch(() => undefined).then(action);
  work = next;
  return next;
}
export const readTripAlertState = async () => parseTripAlertState(await AsyncStorage.getItem(TRIP_ALERT_STATE_KEY));
export const writeTripAlertState = (state: TripAlertState) => AsyncStorage.setItem(TRIP_ALERT_STATE_KEY, JSON.stringify(state));

/** Keep delivery and its claim in one queue; failed notification-only attempts remain retryable. */
export function deliverTripApproach(owner: TripAlertOwner, stepIndex: number, deliver: (firstWarning: boolean) => Promise<boolean>): Promise<{ firstWarning: boolean; accepted: boolean } | null> {
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= 100) return Promise.resolve(null);
  return queueTripAlertWork(async () => {
    let state: TripAlertState | null;
    try { state = await readTripAlertState(); } catch { state = null; }
    if (state && (!sameTripAlertOwner(state, owner) || !state.plan.segments.some((segment) => segment.kind === 'transit' && segment.stepIndex === stepIndex))) return null;
    const firstWarning = !state || !state.alertedSteps.includes(stepIndex);
    let accepted = false;
    try { accepted = await deliver(firstWarning); } catch { /* A failed delivery is not a claim. */ }
    if (accepted && firstWarning && state) {
      try {
        const latest = await readTripAlertState();
        if (latest && sameTripAlertOwner(latest, owner)) await writeTripAlertState({ ...latest, alertedSteps: [...new Set([...latest.alertedSteps, stepIndex])] });
      } catch { /* A storage failure must not replay the speech/haptic we just initiated. */ }
    }
    return { firstWarning, accepted };
  });
}

/** Foreground and background share the same per-leg claim, preventing a repeat on return. */
export function claimTripApproach(owner: TripAlertOwner, stepIndex: number): Promise<boolean> {
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= 100) return Promise.resolve(false);
  return queueTripAlertWork(async () => {
    const state = await readTripAlertState();
    if (!state) return true; // Foreground-only operation when native background support is absent.
    if (!sameTripAlertOwner(state, owner) || state.alertedSteps.includes(stepIndex)
      || !state.plan.segments.some((segment) => segment.kind === 'transit' && segment.stepIndex === stepIndex)) return false;
    await writeTripAlertState({ ...state, alertedSteps: [...state.alertedSteps, stepIndex] });
    return true;
  }).catch(() => true); // Storage failure must not suppress a foreground safety warning.
}
