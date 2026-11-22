import { createHash } from 'node:crypto';

import type { AgencyId } from './gtfsAgencies';
import { gtfsServiceDaysFor } from './gtfsServiceTime';
import { agencySnapshotVersion, loadRouteStopTimes, readRoutingTimetableFile } from './gtfsStaticData';
import { decodeRoutingTimetable, encodeRoutingTimetable, NO_DROP_OFF, NO_PICKUP, serviceRunsOn, type RoutingTimetable } from './routingTimetable';
import type { ResolvedTripRun, TripRunRef } from './tripLiveTypes';

const versions = new WeakMap<RoutingTimetable, string>();
type Schedule = { timetable: RoutingTimetable; version: string };
const schedules = new Map<AgencyId, { sourceVersion: string | null; promise: Promise<Schedule | null> }>();

/** Canonical timetable content, including bundled/legacy routing.bin; no derived-format migration. */
export function scheduleVersionForTimetable(timetable: RoutingTimetable): string {
  let version = versions.get(timetable);
  if (!version) {
    version = `routing-v1:${createHash('sha256').update(encodeRoutingTimetable(timetable)).digest('hex')}`;
    versions.set(timetable, version);
  }
  return version;
}

/** A prepared planner may share its already decoded agency; stale work cannot replace a newer root. */
export function rememberRunSchedule(agencyId: AgencyId, timetable: RoutingTimetable, sourceVersion: string | null): void {
  if (agencySnapshotVersion(agencyId) !== sourceVersion) return;
  schedules.set(agencyId, { sourceVersion, promise: Promise.resolve({ timetable, version: scheduleVersionForTimetable(timetable) }) });
}

async function scheduleFor(agencyId: AgencyId): Promise<Schedule | null> {
  const sourceVersion = agencySnapshotVersion(agencyId);
  const existing = schedules.get(agencyId);
  if (existing?.sourceVersion === sourceVersion) return existing.promise;
  const entry = {
    sourceVersion,
    promise: readRoutingTimetableFile(agencyId).then((file) => {
      if (!file || agencySnapshotVersion(agencyId) !== sourceVersion) return null;
      const timetable = decodeRoutingTimetable(file);
      return { timetable, version: scheduleVersionForTimetable(timetable) };
    }),
  };
  schedules.set(agencyId, entry);
  void entry.promise.then((result) => {
    if (!result && schedules.get(agencyId) === entry) schedules.delete(agencyId);
  }, () => { if (schedules.get(agencyId) === entry) schedules.delete(agencyId); });
  return entry.promise;
}

export function gtfsClock(seconds: number): string {
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function serviceDay(date: string) {
  if (!/^\d{8}$/.test(date)) return null;
  const noon = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)), 12);
  if (!Number.isFinite(noon)) return null;
  const day = gtfsServiceDaysFor(noon, [0])[0]!;
  return day.dateKey === date ? day : null;
}

/** Resolve one trip without constructing the all-agency routing/transfer graph. */
export function scheduledRun(timetable: RoutingTimetable, ref: TripRunRef): ResolvedTripRun | null {
  if (ref.version !== 1 || ref.agencyId !== timetable.agencyId || ref.scheduleVersion !== scheduleVersionForTimetable(timetable)) return null;
  if (![ref.boardOccurrence, ref.alightOccurrence].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const day = serviceDay(ref.serviceDate);
  if (!day) return null;
  const trip = timetable.tripIds.indexOf(ref.tripId);
  if (trip < 0) return null;
  const service = timetable.services[timetable.tripService[trip]!];
  if (!service || !serviceRunsOn(service, Number(ref.serviceDate), day.dayOfWeek)) return null;
  let tripBase = 0;
  let stopBase = 0;
  let profileBase = 0;
  for (const pattern of timetable.patterns) {
    if (trip < tripBase + pattern.tripCount) {
      if (timetable.routes[pattern.route]?.id !== ref.routeId || (ref.directionId !== undefined && pattern.direction >= 0 && ref.directionId !== pattern.direction)) return null;
      const profile = profileBase + timetable.tripProfile[trip]! * pattern.stopCount;
      const start = timetable.tripStart[trip]!;
      if (ref.startTime !== gtfsClock(start + timetable.profileDep[profile]!)) return null;
      const occurrences = new Map<string, number>();
      const stops: ResolvedTripRun['stops'] = [];
      for (let position = 0; position < pattern.stopCount; position += 1) {
        const stopId = timetable.stopIds[timetable.patternStops[stopBase + position]!]!;
        const occurrence = occurrences.get(stopId) ?? 0;
        occurrences.set(stopId, occurrence + 1);
        const sequenceStart = timetable.tripSequenceStart?.[trip];
        const stopSequence = sequenceStart === undefined ? undefined : timetable.tripStopSequence?.[sequenceStart + position];
        stops.push({ stopId, occurrence, ...(stopSequence !== undefined && stopSequence >= 0 ? { stopSequence } : {}), arrives: new Date(day.startMs + (start + timetable.profileArr[profile + position]!) * 1000).toISOString(), departs: new Date(day.startMs + (start + timetable.profileDep[profile + position]!) * 1000).toISOString() });
      }
      const board = stops.findIndex((stop) => stop.stopId === ref.boardStopId && stop.occurrence === ref.boardOccurrence);
      const alight = stops.findIndex((stop) => stop.stopId === ref.alightStopId && stop.occurrence === ref.alightOccurrence);
      if (board < 0 || alight <= board || (timetable.patternFlags[stopBase + board]! & NO_PICKUP) !== 0 || (timetable.patternFlags[stopBase + alight]! & NO_DROP_OFF) !== 0) return null;
      if ((ref.boardStopSequence !== undefined && stops[board]!.stopSequence !== undefined && ref.boardStopSequence !== stops[board]!.stopSequence)
        || (ref.alightStopSequence !== undefined && stops[alight]!.stopSequence !== undefined && ref.alightStopSequence !== stops[alight]!.stopSequence)) return null;
      return { runRef: ref, departs: stops[board]!.departs, arrives: stops[alight]!.arrives, stops };
    }
    tripBase += pattern.tripCount;
    stopBase += pattern.stopCount;
    profileBase += pattern.profileCount * pattern.stopCount;
  }
  return null;
}

/**
 * The caller prepares agencies BEFORE its bounded status phase. This resolver never hydrates or
 * switches static roots, and obtains real stop_sequence from existing route files, including v4.
 */
export async function resolveSelectedRun(ref: TripRunRef): Promise<ResolvedTripRun | null> {
  const sourceVersion = agencySnapshotVersion(ref.agencyId);
  const schedule = await scheduleFor(ref.agencyId);
  if (!schedule || sourceVersion !== agencySnapshotVersion(ref.agencyId)) return null;
  const run = scheduledRun(schedule.timetable, ref);
  if (!run) return null;
  const rows = run.stops.every((stop) => stop.stopSequence !== undefined) ? undefined : (await loadRouteStopTimes(ref.agencyId, ref.routeId)).byTrip.get(ref.tripId);
  if (sourceVersion !== agencySnapshotVersion(ref.agencyId)) return null;
  if (rows?.length) {
    const ordered = [...rows].sort((a, b) => a.stopSequence - b.stopSequence);
    const normalized = ordered.filter((row, index) => index === 0 || row.stopId !== ordered[index - 1]!.stopId);
    if (normalized.length === run.stops.length && normalized.every((row, index) => row.stopId === run.stops[index]!.stopId && Number.isSafeInteger(row.stopSequence) && row.stopSequence >= 0)) {
      run.stops = run.stops.map((stop, index) => ({ ...stop, stopSequence: normalized[index]!.stopSequence }));
    }
  }
  const board = run.stops.find((stop) => stop.stopId === ref.boardStopId && stop.occurrence === ref.boardOccurrence)!;
  const alight = run.stops.find((stop) => stop.stopId === ref.alightStopId && stop.occurrence === ref.alightOccurrence)!;
  if ((ref.boardStopSequence !== undefined && ref.boardStopSequence !== board.stopSequence) || (ref.alightStopSequence !== undefined && ref.alightStopSequence !== alight.stopSequence)) return null;
  run.runRef = { ...ref, ...(board.stopSequence === undefined ? {} : { boardStopSequence: board.stopSequence }), ...(alight.stopSequence === undefined ? {} : { alightStopSequence: alight.stopSequence }) };
  return run;
}

export function resetRunSchedulesForTests(): void { schedules.clear(); }
