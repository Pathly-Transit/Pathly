import { projectPointToPath } from './enrouteNavigation';
import type { RideFix } from './rideDetection';
import type { Itinerary, LatLng } from './tripPlanning';

/**
 * Decides, on this device, whether a rider looking at a trip is already walking it, so Trip
 * Details can start following without GO. As strict as ride detection (rideDetection.ts): standing
 * at the start, pacing near it, or crossing the path once must never count. Only steady progress
 * along the first walk, away from its start, over a minute and a good distance, does.
 */
export const WALK_MAX_ACCURACY_METERS = 50;
/** How far off the walking path a fix may be and still count as on it. */
export const WALK_MAX_OFF_PATH_METERS = 40;
export const WALK_CONFIRM_SAMPLES = 3;
export const WALK_CONFIRM_MS = 60_000;
export const WALK_MIN_PROGRESS_METERS = 150;
/** GPS wobble allowed backward between fixes before the walk counts as abandoned. */
const WALK_BACKTRACK_METERS = 30;

export type WalkFollowState =
  | { phase: 'idle' }
  | { phase: 'candidate'; since: number; samples: number; startAlong: number; lastAlong: number }
  | { phase: 'confirmed' };

export const IDLE_WALK: WalkFollowState = { phase: 'idle' };

/** The trip's first walk, which a rider on their way would be on; none when the trip starts on board. */
export function firstWalkPath(itinerary: Itinerary): readonly LatLng[] | null {
  const first = itinerary.steps[0];
  return first?.kind === 'walk' && first.path.length >= 2 ? first.path : null;
}

/** Folds one GPS fix into the walk evidence. */
export function nextWalkFollowState(state: WalkFollowState, path: readonly LatLng[], fix: RideFix): WalkFollowState {
  if (state.phase === 'confirmed') return state;
  // A poor fix adds no evidence either way.
  if (fix.accuracyMeters === null || fix.accuracyMeters > WALK_MAX_ACCURACY_METERS) return state;
  const projection = projectPointToPath({ lat: fix.lat, lng: fix.lon }, path);
  if (!projection || projection.distanceMeters > WALK_MAX_OFF_PATH_METERS) return IDLE_WALK;
  const along = projection.alongMeters;
  if (state.phase === 'idle') return { phase: 'candidate', since: fix.at, samples: 1, startAlong: along, lastAlong: along };
  if (along < state.lastAlong - WALK_BACKTRACK_METERS) return { phase: 'candidate', since: fix.at, samples: 1, startAlong: along, lastAlong: along };
  const next = { ...state, samples: state.samples + 1, lastAlong: Math.max(state.lastAlong, along) };
  const confirmed = next.samples >= WALK_CONFIRM_SAMPLES
    && fix.at - next.since >= WALK_CONFIRM_MS
    && next.lastAlong - next.startAlong >= WALK_MIN_PROGRESS_METERS;
  return confirmed ? { phase: 'confirmed' } : next;
}
