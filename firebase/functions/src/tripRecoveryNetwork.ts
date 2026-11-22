import { createHash } from 'node:crypto';
import { agencyConfig } from './gtfsAgencies';
import { fetchRealtimeFeed, type RealtimeFeed } from './gtfsRealtime';
import { NO_DROP_OFF, NO_PICKUP, type RoutingTimetable } from './routingTimetable';
import { TransitNetwork, type ServiceDay } from './transitNetwork';
import { observeSelectedRun } from './tripLiveSelection';
import { isSameTrip } from './tripLive';
import type { TripLegObservation, TripRunRef } from './tripLiveTypes';
import type { TripRecoveryRequest } from './tripPlanning';
import { gtfsClock, resolveSelectedRun, scheduledRun, scheduleVersionForTimetable } from './tripRunSchedule';

export type RecoveryCoverage = { state: 'complete' | 'partial'; scope: 'candidate-routes'; reasons: string[]; updatedRuns: number };
type Route = { agencyId: TripRunRef['agencyId']; routeId: string };
type LiveRun = { trip: number; date: number; stops: TripLegObservation[] };
export type RecoveryNetwork = {
  network: TransitNetwork;
  baselineTrips: Map<number, number>;
  liveStops: Map<number, TripLegObservation[]>;
  bannedRuns: Set<string>;
  coverage: RecoveryCoverage;
};
const MAX_ROUTES = 12;
const MAX_RUNS = 64;
const FEED_BUDGET_MS = 2_500;
const cache = new WeakMap<TransitNetwork, Map<string, { expires: number; result: RecoveryNetwork }>>();
const feedGenerations = new WeakMap<RealtimeFeed, string>();
const tripIndexes = new WeakMap<RoutingTimetable, Map<string, number[]>>();
function tripIndex(table: RoutingTimetable): Map<string, number[]> {
  let index = tripIndexes.get(table);
  if (index) return index;
  index = new Map();
  table.tripIds.forEach((id, position) => {
    const alias = table.agencyId === 'subway' ? /_(\d{6}_[A-Za-z0-9]+\.\.[NS])(?:\d+R)?$/.exec(id)?.[1] : undefined;
    for (const key of new Set([id, ...(alias ? [alias] : [])])) index!.set(key, [...(index!.get(key) ?? []), position]);
  });
  tripIndexes.set(table, index);
  return index;
}
function feedGeneration(feed: RealtimeFeed): string {
  let key = feedGenerations.get(feed);
  if (!key) { key = createHash('sha256').update(JSON.stringify(feed.entities)).digest('hex'); feedGenerations.set(feed, key); }
  return key;
}
const keyOf = (ref: Pick<TripRunRef, 'agencyId' | 'tripId' | 'serviceDate'>) => `${ref.agencyId}|${ref.tripId}|${ref.serviceDate}`;

async function feedsFor(route: Route): Promise<RealtimeFeed[]> {
  const config = agencyConfig(route.agencyId);
  if (config.liveFeedSecret && !process.env[config.liveFeedSecret]) throw new Error('Feed unavailable');
  return Promise.all(config.feedRequestsForRoute(route.routeId).map(({ url, headers }) => fetchRealtimeFeed(url, headers)));
}

/** Append one-run patterns: updated trips may overtake each other without violating RAPTOR's pattern invariant. */
function appendRuns(table: RoutingTimetable, runs: readonly LiveRun[], baseTripOffset: number, baseStartMs: number, days: readonly ServiceDay[]): RoutingTimetable {
  if (!runs.length) return table;
  const out = {
    ...table, patterns: [...table.patterns], tripIds: [...table.tripIds], services: [...table.services],
    patternStops: [...table.patternStops], patternFlags: [...table.patternFlags], patternPathIndex: [...table.patternPathIndex],
    pathLat: [...table.pathLat], pathLon: [...table.pathLon], tripStart: [...table.tripStart], tripProfile: [...table.tripProfile],
    tripService: [...table.tripService], tripHeadsign: [...table.tripHeadsign], profileArr: [...table.profileArr], profileDep: [...table.profileDep],
  };
  for (const run of runs) {
    const localTrip = run.trip - baseTripOffset;
    let tripBase = 0, stopBase = 0, pathBase = 0;
    const pattern = table.patterns.find((entry) => {
      if (localTrip < tripBase + entry.tripCount) return true;
      tripBase += entry.tripCount; stopBase += entry.stopCount; pathBase += entry.pathPoints; return false;
    })!;
    const day = days.find((entry) => entry.date === run.date)!;
    const seconds = (iso: string) => Math.round((Date.parse(iso) - baseStartMs) / 1000) - day.offset;
    const known = run.stops.map((stop) => ({ arr: stop.arrives ? seconds(stop.arrives) : undefined, dep: stop.departs ? seconds(stop.departs) : undefined }));
    let previous = known.find((entry) => entry.arr !== undefined || entry.dep !== undefined)?.arr
      ?? known.find((entry) => entry.dep !== undefined)?.dep ?? 0;
    out.patterns.push({ ...pattern, tripCount: 1, profileCount: 1 });
    out.tripIds.push(table.tripIds[localTrip]!);
    out.tripStart.push(0); out.tripProfile.push(0); out.tripHeadsign.push(table.tripHeadsign[localTrip]!);
    out.tripService.push(out.services.length);
    out.services.push({ id: `live:${table.tripIds[localTrip]}:${run.date}`, days: 0, start: run.date, end: run.date, added: [run.date], removed: [] });
    for (let position = 0; position < pattern.stopCount; position += 1) {
      const observation = run.stops[position]!;
      const arr = known[position]!.arr;
      const dep = known[position]!.dep;
      out.patternStops.push(table.patternStops[stopBase + position]!);
      // Unknown/skipped/NO_DATA visits cannot be used as boarding or alighting evidence. Filler
      // times only keep internal arrays causal; they are never exposed as live predictions.
      out.patternFlags.push(table.patternFlags[stopBase + position]!
        | (arr === undefined || observation.status !== 'predicted' ? NO_DROP_OFF : 0)
        | (dep === undefined || observation.status !== 'predicted' ? NO_PICKUP : 0));
      const arrival = arr ?? previous;
      const departure = dep ?? arrival;
      out.profileArr.push(arrival); out.profileDep.push(departure); previous = departure;
      out.patternPathIndex.push(table.patternPathIndex[stopBase + position]!);
    }
    for (let point = pathBase; point < pathBase + pattern.pathPoints; point += 1) {
      out.pathLat.push(table.pathLat[point]!); out.pathLon.push(table.pathLon[point]!);
    }
  }
  // The overlay is internal, and public identities resolve against the untouched baseline.
  const { tripSequenceStart: _starts, tripStopSequence: _sequences, ...plain } = out;
  return { ...plain, patternStops: new Int32Array(out.patternStops), patternFlags: new Uint8Array(out.patternFlags), patternPathIndex: new Uint32Array(out.patternPathIndex), pathLat: new Int32Array(out.pathLat), pathLon: new Int32Array(out.pathLon), tripStart: new Int32Array(out.tripStart), tripProfile: new Uint32Array(out.tripProfile), tripService: new Uint32Array(out.tripService), tripHeadsign: new Int32Array(out.tripHeadsign), profileArr: new Int32Array(out.profileArr), profileDep: new Int32Array(out.profileDep) };
}

/** Triggered recovery only; routine ETA polling never constructs or searches this network. */
export async function recoveryNetwork(base: TransitNetwork, days: readonly ServiceDay[], baseStartMs: number, routes: readonly Route[], request: TripRecoveryRequest, nowMs: number, lookup = feedsFor): Promise<RecoveryNetwork> {
  const reasons = new Set<string>();
  const allRoutes = [...new Map(routes.map((route) => [`${route.agencyId}:${route.routeId}`, route])).values()];
  if (allRoutes.length > MAX_ROUTES) reasons.add('route-limit');
  const selected = allRoutes.slice(0, MAX_ROUTES).filter((wanted) => {
    const exists = base.routes.some((route) => route.agencyId === wanted.agencyId && route.routeId === wanted.routeId);
    if (!exists) reasons.add('missing-route');
    return exists;
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<RealtimeFeed[]>((resolve) => { timer = setTimeout(() => { reasons.add('feed-timeout'); resolve([]); }, FEED_BUDGET_MS); });
  const byRoute = await Promise.all(selected.map(async (route) => ({ route, feeds: await Promise.race([lookup(route).catch(() => { reasons.add('feed-unavailable'); return []; }), deadline]) })));
  if (timer) clearTimeout(timer);
  if (byRoute.some((entry) => entry.feeds.length === 0)) reasons.add('unsupported-feed');
  const generation = JSON.stringify([days.map((day) => day.date), request, byRoute.map(({ route, feeds }) => [route, feeds.map((feed) => [feed.fetchedAt, feed.observedAt, feedGeneration(feed)])])]);
  const entries = cache.get(base) ?? new Map(); cache.set(base, entries);
  const cached = entries.get(generation);
  if (cached && cached.expires > nowMs) return cached.result;
  const excluded = new Set(request.excludedRuns.map(keyOf));
  const bans = new Set<string>();
  const changed: LiveRun[] = [];
  const seen = new Set<string>();
  let expires = nowMs + 25_000;
  let considered = 0;
  const active = base.activeServices(days);
  for (const { route, feeds } of byRoute) {
    const part = base.parts.find((entry) => entry.agencyId === route.agencyId);
    if (!part) { reasons.add('missing-agency'); continue; }
    const localTrips = part.timetable.tripIds;
    for (const feed of feeds) for (const entity of feed.entities) {
      const update = entity.tripUpdate;
      if (!update || entity.isDeleted) continue;
      if (!update.trip.startDate) { reasons.add('undated-feed'); continue; }
      const date = Number(update.trip.startDate);
      if (!days.some((day) => day.date === date)) continue;
      const dayIndex = days.findIndex((day) => day.date === date);
      const matches = (tripIndex(part.timetable).get(update.trip.tripId ?? '') ?? []).filter((local) => {
        const trip = part.tripOffset + local;
        const pattern = base.tripPattern[trip]!;
        return base.routes[base.patternRoute[pattern]!]!.routeId === route.routeId
          && active[dayIndex]![base.tripService[trip]!] === 1
          && (!update.trip.startTime || update.trip.startTime === gtfsClock(base.departure(trip, 0)))
          && (!Object.hasOwn(update.trip, 'directionId') || update.trip.directionId === base.patternDirection[pattern]);
      });
      if (matches.length !== 1) { if (!update.trip.routeId || update.trip.routeId === route.routeId) reasons.add(matches.length ? 'ambiguous-run' : 'unmatched-run'); continue; }
      const local = matches[0]!;
      const trip = part.tripOffset + local;
      const pattern = base.tripPattern[trip]!;
      if (base.routes[base.patternRoute[pattern]!]!.routeId !== route.routeId) continue;
      const count = base.patternStopCount(pattern), start = base.patternStopStart[pattern]!;
      const first = base.patternStops[start]!, last = base.patternStops[start + count - 1]!;
      const lastId = base.stopId(last);
      let occurrence = 0;
      for (let position = 0; position < count - 1; position += 1) if (base.stopId(base.patternStops[start + position]!) === lastId) occurrence += 1;
      const ref: TripRunRef = { version: 1, agencyId: route.agencyId, routeId: route.routeId, tripId: localTrips[local]!, serviceDate: update.trip.startDate, scheduleVersion: scheduleVersionForTimetable(part.timetable), startTime: gtfsClock(base.departure(trip, 0)), boardStopId: base.stopId(first), alightStopId: lastId, boardOccurrence: 0, alightOccurrence: occurrence, ...(base.patternDirection[pattern]! >= 0 ? { directionId: base.patternDirection[pattern]! } : {}) };
      const key = keyOf(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      if (considered >= MAX_RUNS) { reasons.add('run-limit'); break; }
      considered += 1;
      let run = scheduledRun(part.timetable, ref);
      if (!run) continue;
      if (run.stops.some((stop) => stop.stopSequence === undefined)) run = await resolveSelectedRun(ref).catch(() => null) ?? run;
      const oneFeed = feeds.map((source) => ({ ...source, entities: source.entities.filter((candidate) => {
        const liveId = candidate.tripUpdate?.trip.tripId ?? '';
        return (liveId === ref.tripId || (ref.agencyId === 'subway' && isSameTrip(ref.tripId, liveId))) && candidate.tripUpdate?.trip.startDate === update.trip.startDate;
      }) }));
      const summary = observeSelectedRun(oneFeed, run, key, nowMs);
      if (summary.state !== 'fresh') { reasons.add(summary.reason ?? 'unknown-feed'); continue; }
      if (summary.expiresAt !== null) expires = Math.min(expires, summary.expiresAt);
      if (summary.status === 'cancelled') { bans.add(`${trip}@${date}`); continue; }
      if (changed.length >= MAX_RUNS) { reasons.add('run-limit'); break; }
      const stops = run.stops.map((stop, position) => observeSelectedRun(oneFeed, { ...run, runRef: { ...ref, boardStopId: stop.stopId, alightStopId: stop.stopId, boardOccurrence: stop.occurrence, alightOccurrence: stop.occurrence }, departs: stop.departs, arrives: stop.arrives }, `${key}:${position}`, nowMs));
      const usable = stops.filter((stop) => stop.status === 'predicted' && stop.departs && stop.arrives);
      if (usable.length < 2) { reasons.add('sparse-prediction'); continue; }
      if (usable.length !== stops.length) reasons.add('partial-stop-prediction');
      let previous = -Infinity;
      let causal = true;
      for (const stop of stops) if (stop.status === 'predicted') {
        const arrival = stop.arrives ? Date.parse(stop.arrives) : previous;
        const departure = stop.departs ? Date.parse(stop.departs) : arrival;
        if (arrival < previous || departure < arrival) causal = false;
        previous = departure;
      }
      if (!causal) { reasons.add('inconsistent-prediction'); continue; }
      bans.add(`${trip}@${date}`);
      if (!excluded.has(key)) changed.push({ trip, date, stops });
    }
  }
  for (const ref of request.excludedRuns) {
    const part = base.parts.find((entry) => entry.agencyId === ref.agencyId);
    const local = part?.timetable.tripIds.indexOf(ref.tripId) ?? -1;
    if (part && local >= 0 && ref.scheduleVersion === scheduleVersionForTimetable(part.timetable)) bans.add(`${part.tripOffset + local}@${Number(ref.serviceDate)}`);
    else reasons.add('excluded-schedule-mismatch');
  }
  const parts = base.parts.map((part) => ({ agencyId: part.agencyId, version: part.version, timetable: appendRuns(part.timetable, changed.filter((run) => run.trip >= part.tripOffset && run.trip < part.tripOffset + part.timetable.tripIds.length), part.tripOffset, baseStartMs, days) }));
  const network = changed.length ? new TransitNetwork(parts) : base;
  if (network !== base && network.transferSeconds.length === base.transferSeconds.length
    && network.transferTo.every((stop, index) => stop === base.transferTo[index])) network.transferSeconds.set(base.transferSeconds);
  const baselineTrips = new Map<number, number>();
  const liveStops = new Map<number, TripLegObservation[]>();
  const mappedBans = new Set<string>();
  for (const part of network.parts) {
    const original = base.parts.find((entry) => entry.agencyId === part.agencyId)!;
    for (let local = 0; local < original.timetable.tripIds.length; local += 1) {
      baselineTrips.set(part.tripOffset + local, original.tripOffset + local);
      for (const day of days) if (bans.has(`${original.tripOffset + local}@${day.date}`)) mappedBans.add(`${part.tripOffset + local}@${day.date}`);
    }
    const additions = changed.filter((run) => run.trip >= original.tripOffset && run.trip < original.tripOffset + original.timetable.tripIds.length);
    additions.forEach((run, index) => { const trip = part.tripOffset + original.timetable.tripIds.length + index; baselineTrips.set(trip, run.trip); liveStops.set(trip, run.stops); });
  }
  const result = { network, baselineTrips, liveStops, bannedRuns: mappedBans, coverage: { state: reasons.size ? 'partial' as const : 'complete' as const, scope: 'candidate-routes' as const, reasons: [...reasons], updatedRuns: changed.length } };
  entries.set(generation, { expires, result });
  while (entries.size > 2) entries.delete(entries.keys().next().value!);
  return result;
}
