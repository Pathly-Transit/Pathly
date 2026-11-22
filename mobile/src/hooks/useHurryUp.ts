import type { ActiveTripRuntime, NavigationFix } from '../data/enrouteNavigation';
import { hurryUpFor, hurryUpMessage } from '../data/hurryUp';
import { useClock } from './useClock';

/**
 * Walking to a stop with too little time to spare, on the active trip: the copy for the trip
 * page's inline banner. Routine lateness stays silent; only major disruptions can notify.
 * Runs for the whole trip (HomeScreen), whichever page is open.
 */
export function useHurryUp(session: ActiveTripRuntime | null, fix: NavigationFix | null, located: boolean): { title: string; body: string } | null {
  const now = useClock(30_000);
  const hurry = session && fix && located ? hurryUpFor(session.plan, session.cursor, fix.point, now) : null;
  return hurry ? hurryUpMessage(hurry) : null;
}
