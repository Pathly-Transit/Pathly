import type { TripRunRef } from './tripLiveTypes';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const ordinal = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;

/** Validate persisted/network references before they may identify a selected run. */
export function parseTripRunRef(value: unknown): TripRunRef | null {
  if (!record(value) || value.version !== 1
    || !text(value.agencyId) || !text(value.routeId) || !text(value.tripId) || !text(value.scheduleVersion)
    || !text(value.boardStopId) || !text(value.alightStopId)
    || typeof value.serviceDate !== 'string' || !/^\d{8}$/.test(value.serviceDate)
    || typeof value.startTime !== 'string' || !/^\d{2,3}:[0-5]\d:[0-5]\d$/.test(value.startTime)
    || !ordinal(value.boardOccurrence) || !ordinal(value.alightOccurrence)
    || (value.boardStopSequence !== undefined && !ordinal(value.boardStopSequence))
    || (value.alightStopSequence !== undefined && !ordinal(value.alightStopSequence))
    || (value.directionId !== undefined && value.directionId !== 0 && value.directionId !== 1)) return null;
  const date = `${value.serviceDate.slice(0, 4)}-${value.serviceDate.slice(4, 6)}-${value.serviceDate.slice(6, 8)}`;
  const instant = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== date
    || (value.boardStopSequence !== undefined && value.alightStopSequence !== undefined && value.alightStopSequence <= value.boardStopSequence)
    || (value.boardStopId === value.alightStopId && value.alightOccurrence <= value.boardOccurrence)) return null;
  return {
    version: 1, agencyId: value.agencyId, routeId: value.routeId, tripId: value.tripId,
    serviceDate: value.serviceDate, scheduleVersion: value.scheduleVersion, startTime: value.startTime,
    boardStopId: value.boardStopId, alightStopId: value.alightStopId,
    boardOccurrence: value.boardOccurrence, alightOccurrence: value.alightOccurrence,
    ...(value.boardStopSequence === undefined ? {} : { boardStopSequence: value.boardStopSequence }),
    ...(value.alightStopSequence === undefined ? {} : { alightStopSequence: value.alightStopSequence }),
    ...(value.directionId === undefined ? {} : { directionId: value.directionId }),
  };
}

/** Includes the service day, timetable and stop visits; a line or clock time is insufficient. */
export function tripRunRefKey(ref: TripRunRef): string {
  return JSON.stringify([ref.version, ref.agencyId, ref.scheduleVersion, ref.serviceDate, ref.tripId, ref.startTime,
    ref.routeId, ref.directionId ?? null, ref.boardStopId, ref.boardOccurrence, ref.boardStopSequence ?? null,
    ref.alightStopId, ref.alightOccurrence, ref.alightStopSequence ?? null]);
}

export function sameTripRunRef(a: TripRunRef | null | undefined, b: TripRunRef | null | undefined): boolean {
  return Boolean(a && b && tripRunRefKey(a) === tripRunRefKey(b));
}
