import { useEffect, useRef } from 'react';

import type { ActiveTripRuntime, NavigationFix } from '../data/enrouteNavigation';
import { hurryUpFor, hurryUpMessage } from '../data/hurryUp';
import { useUserPreferences } from '../data/userPreferences';
import { notifyNow } from '../lib/notifications';
import { useClock } from './useClock';

/**
 * Walking to a stop with too little time to spare, on the active trip: the copy for the trip
 * page's banner, and once per boarding a notification, so it reaches a rider who has put the phone
 * away. Runs for the whole trip (HomeScreen), whichever page is open.
 */
export function useHurryUp(session: ActiveTripRuntime | null, fix: NavigationFix | null, located: boolean): { title: string; body: string } | null {
  const now = useClock(30_000);
  const { notifications } = useUserPreferences().preferences;
  const alertsOn = notifications.enabled && notifications.tripReminders;
  const hurry = session && fix && located ? hurryUpFor(session.plan, session.cursor, fix.point, now) : null;
  const copy = hurry ? hurryUpMessage(hurry) : null;
  const nudged = useRef(new Set<string>());
  const key = hurry ? `${session?.sessionId}:${hurry.key}` : null;
  useEffect(() => {
    if (!key || !copy || !alertsOn || nudged.current.has(key)) return;
    nudged.current.add(key);
    void notifyNow(copy.title, copy.body);
    // Once per boarding: the copy's changing minutes don't nudge again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertsOn, key]);
  return copy;
}
