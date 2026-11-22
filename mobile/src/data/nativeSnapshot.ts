import { createTripSelectionIdentity, distanceMeters, sameTripSelection, type TripEndpointReference, type TripSelectionIdentity } from './enrouteNavigation';
import { parseNavigationSnapshotStep } from './rideSnapshot';
import type { FareLine, Itinerary, ResumePlanRequest, TransitStep, TripFare } from './tripPlanning';

/** Only Pathly-owned selected native runs qualify; never used for legacy provider itineraries. */
export type NativeSnapshotV1 = { version: 1; kind: 'native'; itinerary: Itinerary };
type Context = { origin: TripEndpointReference; destination: TripEndpointReference; request: ResumePlanRequest; selection: TripSelectionIdentity };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const boundedText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500;
const cents = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000_000;
function fareLines(value: unknown): FareLine[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50 || value.some((line) => !record(line) || !boundedText(line.label)
    || !boundedText(line.text) || (line.note !== undefined && !boundedText(line.note)))) return null;
  return value.map((line) => ({ label: line.label, text: line.text, ...(line.note === undefined ? {} : { note: line.note }) }));
}
function nativeFare(value: unknown): TripFare | undefined {
  if (!record(value) || !boundedText(value.text) || !cents(value.cents) || typeof value.currency !== 'string'
    || !/^[A-Z]{3}$/.test(value.currency) || typeof value.estimated !== 'boolean') return undefined;
  const lines = fareLines(value.lines);
  if (lines === null) return undefined;
  const fare: TripFare = { text: value.text, cents: value.cents, currency: value.currency, estimated: value.estimated, ...(lines ? { lines } : {}) };
  for (const key of ['reduced', 'student', 'college', 'fairFares'] as const) {
    if (value[key] === undefined) continue;
    const rider = value[key];
    if (!record(rider) || !boundedText(rider.text) || !cents(rider.cents)) return undefined;
    const riderLines = fareLines(rider.lines);
    if (riderLines === null) return undefined;
    fare[key] = { text: rider.text, cents: rider.cents, ...(riderLines ? { lines: riderLines } : {}) };
  }
  return fare;
}

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
  const liveRecovery = saved.id.startsWith('recovery:');
  if (transits.length < 1 || transits.length > 12 || transits.some((step) => !step.runRef)
    || saved.transfers !== transits.length - 1 || end < start
    || Math.abs(Math.max(0, end - start) - saved.durationSeconds * 1000) > 1) return null;
  if (liveRecovery) {
    // Search can use a delayed run whose original GTFS times overlap the preceding run.
    // Preserve both authoritative schedules; only live observations may claim feasibility/ETA.
    const firstIndex = steps.findIndex((step) => step.kind === 'transit');
    const lastIndex = steps.findLastIndex((step) => step.kind === 'transit');
    const access = steps.slice(0, firstIndex).reduce((sum, step) => sum + step.durationSeconds, 0);
    const egress = steps.slice(lastIndex + 1).reduce((sum, step) => sum + step.durationSeconds, 0);
    if (Math.abs(Date.parse(transits[0]!.from.time) - access * 1000 - start) > 1
      || Math.abs(Date.parse(transits.at(-1)!.to.time) + egress * 1000 - end) > 1) return null;
  }
  let previous = start;
  for (const step of steps) {
    if (step.kind === 'walk') continue;
    if (!liveRecovery && (Date.parse(step.from.time) < previous || Date.parse(step.to.time) > end)) return null;
    previous = Date.parse(step.to.time);
  }
  const first = steps[0]!;
  const last = steps.at(-1)!;
  const firstPoint = first.kind === 'walk' ? first.path[0]! : first.from.location;
  const lastPoint = last.kind === 'walk' ? last.path.at(-1)! : last.to.location;
  if ((context.origin.kind === 'coordinate' && distanceMeters(context.origin.point, firstPoint) > 50)
    || (context.destination.kind === 'coordinate' && distanceMeters(context.destination.point, lastPoint) > 50)) return null;
  const fare = nativeFare(saved.fare);
  const itinerary: Itinerary = {
    id: saved.id, departureTime: saved.departureTime, arrivalTime: saved.arrivalTime,
    durationSeconds: saved.durationSeconds, transfers: transits.length - 1, steps,
    ...(fare ? { fare } : {}),
  };
  return sameTripSelection(context.selection, createTripSelectionIdentity(itinerary)) ? { version: 1, kind: 'native', itinerary } : null;
}
