import { useEffect, useLayoutEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { resumeBackgroundTripFixes, stopBackgroundTripAlerts, syncBackgroundTripAlerts } from '../background/tripAlerts';
import type { ActiveTripRuntime, NavigationFix } from '../data/enrouteNavigation';
import type { TripAlertOwner } from '../background/tripAlertState';

/** Native background monitoring has the same lifetime and opt-out as the active trip. */
export function useBackgroundTripAlerts(runtime: ActiveTripRuntime | null, enabled: boolean, advance: (fix: NavigationFix) => Promise<unknown>, options: { hydrating?: boolean; recovery?: TripAlertOwner | null } = {}) {
  const latest = useRef({ runtime, enabled, advance });
  const resync = useRef<(() => Promise<void>) | null>(null);
  useLayoutEffect(() => { latest.current = { runtime, enabled, advance }; }, [runtime, enabled, advance]);
  const uid = runtime?.uid ?? options.recovery?.uid;
  const sessionId = runtime?.sessionId ?? options.recovery?.sessionId;
  const hydrating = options.hydrating === true;
  useEffect(() => {
    // A cold launch must not discard the task's evidence while exact route hydration is pending.
    // Recovery retains the same saved owner; its worker still validates auth/session/preferences.
    if (hydrating && enabled) return;
    if (!uid || !sessionId || !enabled) { void stopBackgroundTripAlerts(); return; }
    let cancelled = false;
    let requested = false;
    let initialReconciled = false;
    let working = false;
    let pendingResume = false;
    const sync = async (reconcile: boolean) => {
      if (working) { pendingResume ||= reconcile; return; }
      const current = latest.current;
      if (cancelled || !current.enabled || current.runtime?.uid !== uid || current.runtime.sessionId !== sessionId) return;
      working = true;
      try {
        if (reconcile || !initialReconciled) {
          for (const fix of await resumeBackgroundTripFixes({ uid, sessionId })) {
            const active = latest.current;
            if (cancelled || !active.enabled || active.runtime?.uid !== uid || active.runtime.sessionId !== sessionId) return;
            await active.advance(fix);
          }
          initialReconciled = true;
        }
        const newest = latest.current.runtime;
        if (cancelled || !newest || newest.uid !== uid || newest.sessionId !== sessionId) return;
        const result = await syncBackgroundTripAlerts(newest, !requested);
        // A pending foreground/notification grant is not an attempted background permission prompt.
        if (result === 'active' || result === 'background-denied') requested = true;
        const updated = latest.current;
        if (!cancelled && updated.enabled && updated.runtime && updated.runtime !== newest
          && updated.runtime.uid === uid && updated.runtime.sessionId === sessionId) {
          await syncBackgroundTripAlerts(updated.runtime, false);
        }
      } catch {
        // A failed disk/progress write must not reject an AppState callback. Fresh foreground
        // fixes keep using the normal coordinator and its exact-route safeguards.
      } finally {
        working = false;
        if (pendingResume && !cancelled) { pendingResume = false; void sync(true); }
      }
    };
    resync.current = () => sync(false);
    void sync(true);
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') void sync(true); });
    return () => { cancelled = true; resync.current = null; listener.remove(); void stopBackgroundTripAlerts({ uid, sessionId }); };
  }, [enabled, hydrating, sessionId, uid]);
  useEffect(() => {
    if (runtime && enabled) void resync.current?.();
  }, [enabled, runtime]);
}
