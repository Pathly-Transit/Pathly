import type { NavigationCursor } from './enrouteNavigation';
import type { Itinerary, TransitStep } from './tripPlanning';
import type { TripLegObservation, TripLiveResponse } from './tripLiveTypes';
import { sameTripRunRef, tripRunRefKey } from './tripRunRef';

/** Smaller timing changes stay in the itinerary without an interruption. */
export const MAJOR_TRIP_DELAY_SECONDS = 15 * 60;
export type TripDisruption = {
  key: string;
  stepIndex: number;
  kind: 'cancelled' | 'skips-stop' | 'major-delay';
  title: string;
  body: string;
  arrivalTime: string | null;
  delaySeconds?: number;
};

export function freshTripObservation(observation: TripLegObservation, now: number): boolean {
  return observation.state === 'fresh' && observation.observedAt !== null && observation.expiresAt !== null
    && observation.observedAt <= now + 30_000 && observation.observedAt >= now - 90_000
    && observation.expiresAt > now && observation.expiresAt - observation.observedAt <= 90_000;
}

/** Only evidence for the exact remaining run can interrupt an already-started trip. */
export function tripDisruptionFor(itinerary: Itinerary, response: TripLiveResponse | null, cursor: NavigationCursor,
  now: number, arrivalTime: string | null = null): TripDisruption | null {
  if (cursor.phase === 'arrived') return null;
  const found: TripDisruption[] = [];
  for (const observation of response?.legs ?? []) {
    const stepIndex = Number(observation.legKey);
    const step = itinerary.steps[stepIndex];
    if (!Number.isSafeInteger(stepIndex) || stepIndex < cursor.stepIndex || step?.kind !== 'transit'
      || !sameTripRunRef(step.runRef, observation.runRef) || !freshTripObservation(observation, now)) continue;
    const onBoard = cursor.phase === 'riding' && stepIndex === cursor.stepIndex;
    const vehicle = step.mode === 'bus' ? 'bus' : step.mode === 'ferry' ? 'ferry' : 'train';
    const base = { key: `${tripRunRefKey(observation.runRef)}:${observation.status}`, stepIndex, arrivalTime };
    const name = step.line.shortName ?? step.line.name;
    if (observation.status === 'cancelled') {
      found.push({ ...base, kind: 'cancelled', title: onBoard ? `Service interrupted on your ${vehicle}` : 'Your service was cancelled',
        body: onBoard ? `Service on ${name} is interrupted. Follow staff instructions; Pathly is checking your onward route.`
          : `${name} is cancelled. Pathly is updating your onward route.` });
    } else if (observation.status === 'skips-stop' && (!onBoard || observation.alightSkipped === true)) {
      found.push({ ...base, kind: 'skips-stop', title: 'Your service is skipping a stop',
        body: `${name} will not call at ${onBoard ? step.to.name : observation.boardSkipped ? step.from.name : step.to.name}. Pathly is checking your onward route.` });
    } else if (observation.status === 'predicted') {
      const delay = arrivalDelay(step, observation, onBoard);
      if (delay >= MAJOR_TRIP_DELAY_SECONDS) found.push({ ...base, key: `${tripRunRefKey(observation.runRef)}:major-delay`, kind: 'major-delay',
        title: 'A major delay affects your trip', body: `${name} is about ${Math.round(delay / 60)} minutes late. Your arrival and connections are being updated.`, delaySeconds: delay });
    }
  }
  return found.find((notice) => notice.kind !== 'major-delay') ?? found[0] ?? null;
}

function arrivalDelay(step: TransitStep, observation: TripLegObservation, onBoard: boolean): number {
  if (observation.arrives && !observation.arrivalNoData) return (Date.parse(observation.arrives) - Date.parse(step.to.time)) / 1000;
  if (!onBoard && observation.departs && !observation.departureNoData) return (Date.parse(observation.departs) - Date.parse(step.from.time)) / 1000;
  return 0;
}
