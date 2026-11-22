import type { ActiveTripRuntime, NavigationFix } from '../data/enrouteNavigation';
import type { TripAlertOwner } from './tripAlertState';

/** Browser/Expo Go fallback: normal foreground navigation remains available. */
export type BackgroundTripSyncStatus = 'active' | 'waiting-permission' | 'background-denied' | 'unavailable';
export const syncBackgroundTripAlerts = async (_runtime: ActiveTripRuntime, _requestPermission: boolean): Promise<BackgroundTripSyncStatus> => 'unavailable';
export const stopBackgroundTripAlerts = async (_owner?: TripAlertOwner): Promise<void> => undefined;
export const resumeBackgroundTripFixes = async (_owner: TripAlertOwner): Promise<NavigationFix[]> => [];
