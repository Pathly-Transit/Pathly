import { createTripSelectionIdentity, distanceMeters, sameTripSelection, type TripEndpointReference, type TripSelectionIdentity } from './enrouteNavigation';
import { parseNavigationSnapshotStep } from './rideSnapshot';
import type { Itinerary, ResumePlanRequest, TransitStep } from './tripPlanning';

/** Only Pathly-owned selected native runs qualify; never used for legacy provider itineraries. */
export type NativeSnapshotV1 = { version: 1; kind: 'native'; itinerary: Itinerary };
type Context = { origin: TripEndpointReference; destination: TripEndpointReference; request: ResumePlanRequest; selection: TripSelectionIdentity };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Mutable feed state and alternative departures are deliberately not restored from disk. */
export function parseNativeSnapshot(value: unknown, context: Context): NativeSnapshotV1 | null {
  if (!record(value) || value.version !== 1 || value.kind !== 'native' || !record(value.itinerary) || !context.selection.native) return null;
  try { if (JSON.stringify(value).length > 2_000_000) return null; } catch { return null; }
  const saved = value.itinerary;
  if (typeof saved.id !== 'string' || saved.id.length === 0 || saved.id.startsWith('ride:')
    || !instant(saved.departureTime) || !instant(saved.arrivalTime)
    || typeof saved.durationSeconds !== 'number' || !Number.isFinite(saved.durationSeconds) || saved.durationSeconds < 0
    || !Array.isArray(saved.steps) || saved.steps.length < 1 || saved.steps.length > 32) return null;
  const parsed = saved.steps.map(parseNavigationSnapshotStep);
  if (parsed.some((step) => !step)) return null;
  const steps = parsed as Itinerary['steps'];
  const transits = steps.filter((step): step is TransitStep => step.kind === 'transit');
  const start = Date.parse(saved.departureTime);
  const end = Date.parse(saved.arrivalTime);
  if (transits.length < 1 || transits.length > 12 || transits.some((step) => !step.runRef)
    || saved.transfers !== transits.length - 1 || end < start || Math.abs(end - start - saved.durationSeconds * 1000) > 1) return null;
  let previous = start;
  for (const step of steps) {
    if (step.kind === 'walk') continue;
    if (Date.parse(step.from.time) < previous || Date.parse(step.to.time) > end) return null;
    previous = Date.parse(step.to.time);
  }
  const first = steps[0]!;
  const last = steps.at(-1)!;
  const firstPoint = first.kind === 'walk' ? first.path[0]! : first.from.location;
  const lastPoint = last.kind === 'walk' ? last.path.at(-1)! : last.to.location;
  if ((context.origin.kind === 'coordinate' && distanceMeters(context.origin.point, firstPoint) > 50)
    || (context.destination.kind === 'coordinate' && distanceMeters(context.destination.point, lastPoint) > 50)) return null;
  const itinerary: Itinerary = {
    id: saved.id, departureTime: saved.departureTime, arrivalTime: saved.arrivalTime,
    durationSeconds: saved.durationSeconds, transfers: transits.length - 1, steps,
  };
  return sameTripSelection(context.selection, createTripSelectionIdentity(itinerary)) ? { version: 1, kind: 'native', itinerary } : null;
}
