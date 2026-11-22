import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type { RideFix } from '../data/rideDetection';
import { firstWalkPath, IDLE_WALK, nextWalkFollowState, type WalkFollowState } from '../data/tripAutoStart';
import type { TripVehicle } from '../data/tripMap';
import type { Itinerary } from '../data/tripPlanning';
import { useOnBoardVehicle } from './useTripRide';

const NO_VEHICLES: readonly TripVehicle[] = [];

/**
 * Trip Details, open on a trip not yet started: calls `onDetected` once if the rider is clearly
 * already taking it, either walking its first walk away from the start (tripAutoStart.ts) or riding
 * one of its vehicles (rideDetection.ts, through useOnBoardVehicle). Only real GPS counts.
 */
export function useAutoStartFollow({ enabled, fix, itinerary, onDetected, vehicles }: {
  enabled: boolean;
  fix: RideFix | null;
  itinerary: Itinerary;
  onDetected: () => void;
  vehicles: readonly TripVehicle[];
}): void {
  const onBoard = useOnBoardVehicle(enabled ? vehicles : NO_VEHICLES, enabled ? fix : null);
  // Another trip opened: the evidence starts over. Each new fix is folded in once, while rendering.
  const path = firstWalkPath(itinerary);
  const pathKey = path ? `${itinerary.id}:${path.length}:${path[0]!.lat},${path[0]!.lng}` : itinerary.id;
  const [evidence, setEvidence] = useState<{ key: string; fixAt: number | null; walk: WalkFollowState }>({ key: pathKey, fixAt: null, walk: IDLE_WALK });
  let current = evidence.key === pathKey ? evidence : { key: pathKey, fixAt: null, walk: IDLE_WALK };
  if (enabled && fix && path && fix.at !== current.fixAt) {
    current = { key: pathKey, fixAt: fix.at, walk: nextWalkFollowState(current.walk, path, fix) };
  }
  if (current !== evidence) setEvidence(current);
  const walk = current.walk;

  const fired = useRef(false);
  const detect = useEffectEvent(() => {
    if (fired.current) return;
    fired.current = true;
    onDetected();
  });
  const following = walk.phase === 'confirmed' || onBoard !== null;
  useEffect(() => {
    if (enabled && following) detect();
  }, [enabled, following]);
}
