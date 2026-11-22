import { HttpsError } from 'firebase-functions/v2/https';

import { AGENCY_CONFIGS, type AgencyId } from './gtfsAgencies';
import { loadAgencyStaticData } from './gtfsStaticData';
import type { ResolveRideGuideRunRequest, ResolveRideGuideRunResponse } from './tripLiveTypes';
import { resolveRideGuideSelection } from './tripRunSchedule';

const MAX_SELECTED_STOPS = 512;
const RESOLVE_BUDGET_MS = 2_500;
function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new HttpsError('invalid-argument', `${name} is required and must be at most ${max} characters.`);
  return value;
}
function integer(value: unknown, name: string, max = 0xffff_ffff): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new HttpsError('invalid-argument', `${name} must be a valid nonnegative integer.`);
  return value;
}

export function parseResolveRideGuideRunRequest(value: unknown): ResolveRideGuideRunRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpsError('invalid-argument', 'A versioned selected departure is required.');
  const data = value as Record<string, unknown>;
  const agencyId = text(data.agencyId, 'agencyId', 32);
  if (data.version !== 1 || !Object.hasOwn(AGENCY_CONFIGS, agencyId)) throw new HttpsError('invalid-argument', 'Selected departure version or agency is unsupported.');
  const serviceDate = text(data.serviceDate, 'serviceDate', 8);
  const date = `${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6)}`;
  const at = Date.parse(`${date}T12:00:00Z`);
  if (!/^\d{8}$/.test(serviceDate) || !Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== date) throw new HttpsError('invalid-argument', 'serviceDate must be a valid YYYYMMDD.');
  const startTime = data.startTime === undefined ? undefined : text(data.startTime, 'startTime', 9);
  if (startTime !== undefined && (!/^\d{2,3}:[0-5]\d:[0-5]\d$/.test(startTime) || Number(startTime.split(':')[0]) > 167)) throw new HttpsError('invalid-argument', 'startTime must be a GTFS clock time.');
  return {
    version: 1, agencyId: agencyId as AgencyId, routeId: text(data.routeId, 'routeId'), tripId: text(data.tripId, 'tripId', 512), serviceDate,
    boardStopId: text(data.boardStopId, 'boardStopId'), alightStopId: text(data.alightStopId, 'alightStopId'),
    ...(startTime === undefined ? {} : { startTime }),
    ...(data.directionId === undefined ? {} : { directionId: integer(data.directionId, 'directionId', 1) }),
    ...(data.boardOccurrence === undefined ? {} : { boardOccurrence: integer(data.boardOccurrence, 'boardOccurrence', 10_000) }),
    ...(data.alightOccurrence === undefined ? {} : { alightOccurrence: integer(data.alightOccurrence, 'alightOccurrence', 10_000) }),
    ...(data.boardStopSequence === undefined ? {} : { boardStopSequence: integer(data.boardStopSequence, 'boardStopSequence') }),
    ...(data.alightStopSequence === undefined ? {} : { alightStopSequence: integer(data.alightStopSequence, 'alightStopSequence') }),
  };
}

/** The caller prepares one agency first; this never plans alternatives or fetches live feeds. */
export async function resolveRideGuideRun(request: ResolveRideGuideRunRequest, {
  resolve = resolveRideGuideSelection,
  staticData = loadAgencyStaticData,
  budgetMs = RESOLVE_BUDGET_MS,
}: { resolve?: typeof resolveRideGuideSelection; staticData?: typeof loadAgencyStaticData; budgetMs?: number } = {}): Promise<ResolveRideGuideRunResponse> {
  const unknown = (reason: 'not-found' | 'unavailable' | 'unsupported-run'): ResolveRideGuideRunResponse => ({ version: 1, status: 'unknown', reason });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<ResolveRideGuideRunResponse>((done) => { timer = setTimeout(() => done(unknown('unavailable')), budgetMs); });
  const work = (async (): Promise<ResolveRideGuideRunResponse> => {
    const run = await resolve(request);
    if (!run) return unknown('not-found');
    const board = run.stops.findIndex((stop) => stop.stopId === run.runRef.boardStopId && stop.occurrence === run.runRef.boardOccurrence);
    const alight = run.stops.findIndex((stop) => stop.stopId === run.runRef.alightStopId && stop.occurrence === run.runRef.alightOccurrence);
    if (board < 0 || alight <= board || alight - board + 1 > MAX_SELECTED_STOPS) return unknown('unsupported-run');
    const { stopsById } = staticData(request.agencyId);
    const selected = run.stops.slice(board, alight + 1);
    if (selected.some((stop) => {
      const meta = stopsById.get(stop.stopId);
      return !meta || typeof meta.name !== 'string' || !meta.name || meta.name.length > 500
        || !Number.isFinite(meta.lat) || !Number.isFinite(meta.lon) || Math.abs(meta.lat) > 90 || Math.abs(meta.lon) > 180;
    })) return unknown('unsupported-run');
    return { version: 1, status: 'resolved', runRef: run.runRef, departs: run.departs, arrives: run.arrives,
      stops: selected.map((stop) => { const meta = stopsById.get(stop.stopId)!; return { ...stop, name: meta.name, location: { lat: meta.lat, lng: meta.lon } }; }) };
  })().catch(() => unknown('unavailable'));
  try { return await Promise.race([work, deadline]); } finally { if (timer) clearTimeout(timer); }
}
