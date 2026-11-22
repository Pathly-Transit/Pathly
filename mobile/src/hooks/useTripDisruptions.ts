import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { ActiveTripRuntime } from '../data/enrouteNavigation';
import { readNavigationDocument } from '../data/navigationStorage';
import { tripDisruptionFor, type TripDisruption } from '../data/tripDisruptions';
import { dismissTripDisruption, presentTripDisruption, tripDisruptionDismissed } from '../data/tripDisruptionStorage';
import type { TripLiveResponse } from '../data/tripLiveTypes';
import type { TripTimingProjection } from '../data/tripTiming';
import { formatTripClock } from '../data/tripPlanning';
import { useUserPreferences } from '../data/userPreferences';
import { auth } from '../lib/firebase';
import { notifyTripDisruptionAccepted } from '../lib/notifications';
import { useAppActive } from './useAppActive';

/** Routine predictions never enter this path. Only an already-started trip can own a notice. */
export function useTripDisruptions(active: ActiveTripRuntime | null, statuses: TripLiveResponse | null,
  timing: TripTimingProjection | null, now: number) {
  const appActive = useAppActive();
  const { preferences } = useUserPreferences();
  const enabled = preferences.notifications.enabled && preferences.notifications.disruptions;
  const ownerKey = active ? JSON.stringify([active.uid, active.sessionId]) : null;
  const latest = useRef({ active, enabled, ownerKey });
  const dismissed = useRef(new Set<string>());
  useLayoutEffect(() => { dismissed.current.clear(); }, [ownerKey]);
  useLayoutEffect(() => { latest.current = { active, enabled, ownerKey }; }, [active, enabled, ownerKey]);
  const [shown, setShown] = useState<{ ownerKey: string; notice: TripDisruption } | null>(null);
  const candidate = useMemo(() => active ? tripDisruptionFor(active.itinerary, statuses, active.cursor, now, timing?.arrivalTime ?? null) : null,
    [active, now, statuses, timing]);

  useEffect(() => {
    if (!active || !ownerKey || !candidate) return undefined;
    let cancelled = false;
    const owner = { uid: active.uid, sessionId: active.sessionId };
    const isCurrent = () => !cancelled && latest.current.ownerKey === ownerKey && auth.currentUser?.uid === owner.uid;
    void (async () => {
      if (dismissed.current.has(candidate.key) || await tripDisruptionDismissed(owner, candidate.key) || !isCurrent() || dismissed.current.has(candidate.key)) return;
      setShown({ ownerKey, notice: candidate });
      await presentTripDisruption(owner, candidate.key, async () => {
        if (!isCurrent()) return false;
        // Reading the card is the one presentation; putting the phone away must not repeat it.
        if (AppState.currentState === 'active') return true;
        if (!latest.current.enabled) return false;
        const current = async () => isCurrent() && latest.current.enabled && AppState.currentState !== 'active'
          && (await readNavigationDocument(owner.uid)).active?.sessionId === owner.sessionId;
        const arrival = candidate.arrivalTime ? ` New arrival ${formatTripClock(candidate.arrivalTime)}.` : '';
        return notifyTripDisruptionAccepted(`${ownerKey}:${candidate.key}`, candidate.title, candidate.body + arrival, current);
      });
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, ownerKey, candidate, appActive]);

  const dismiss = useCallback(() => {
    if (!active || shown?.ownerKey !== ownerKey) return;
    dismissed.current.add(shown.notice.key);
    void dismissTripDisruption(active, shown.notice.key).catch(() => undefined);
    setShown(null);
  }, [active, ownerKey, shown]);
  const notice = shown?.ownerKey === ownerKey ? { ...shown.notice, arrivalTime: timing?.arrivalTime ?? shown.notice.arrivalTime } : null;
  return { notice, dismiss };
}
