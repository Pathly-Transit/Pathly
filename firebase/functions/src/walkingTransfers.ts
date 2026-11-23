import { haversineMeters } from './geo';
import type { Journey } from './transitRouter';
import {
  TRANSFER_DETOUR,
  WALK_METERS_PER_SECOND,
  WALK_TRANSFER_SLACK_SECONDS,
  type TransitNetwork,
} from './transitNetwork';
import type { LatLng } from './tripPlanning';
import { hasWalkingData, walkingPath } from './walkingGraph';

/** A physical street walk, independent of the rider's walking preference. */
export type TransferWalk =
  | { kind: 'measured'; meters: number; path: LatLng[] }
  // A bounded unsuccessful lookup is not proof that no longer walk exists.
  | { kind: 'notWithin'; checkedMeters: number };

export const TRANSFER_WALK_METERS = 10 * 60 * WALK_METERS_PER_SECOND;
export const LESS_WALKING_TRANSFER_METERS = 5 * 60 * WALK_METERS_PER_SECOND;
/** Directed entries (two per physical pair); bounded across requests on a warm instance. */
export const MAX_TRANSFER_WALK_CACHE_ENTRIES = 8192;

export type TransferResolver = {
  resolve: (stop: number, direction: 'forward' | 'backward') => readonly { stop: number; seconds: number }[];
  validate: (journeys: readonly Journey[], maxChecks?: number) => { changed: boolean; checks: number };
  isValidated: (journey: Journey) => boolean;
};

const walkKey = (from: number, to: number) => `${from}>${to}`;
// Baseline, recovery, and concurrent request resolvers can share one physical cache. Their
// resolved edge lists must all observe a measurement or eviction made by any of those owners.
const physicalGenerations = new WeakMap<Map<string, TransferWalk>, number>();

/**
 * Discover walks only at stops a search reaches. Unknown street walks use a lower-bound time
 * during routing, then must be measured before a journey can be returned. Physical results may
 * be shared with recovery and later requests; eligibility always belongs to this request.
 */
export function createWalkingTransfers(
  network: TransitNetwork,
  walks: Map<string, TransferWalk>,
  lessWalking = false,
): TransferResolver {
  const budget = lessWalking ? LESS_WALKING_TRANSFER_METERS : TRANSFER_WALK_METERS;
  const graph = hasWalkingData();
  const candidates = new Map<number, readonly { stop: number; meters: number }[]>();
  const resolved = new Map<string, { generation: number; edges: readonly { stop: number; seconds: number }[] }>();
  const served = (stop: number) => stop >= 0 && stop < network.stopCount
    && network.stopPatternStart[stop]! < network.stopPatternStart[stop + 1]!;
  const sameStation = (from: number, to: number) => network.stopParent[from]! >= 0
    && network.stopParent[from] === network.stopParent[to];
  const metersBetween = (from: number, to: number) => haversineMeters(
    network.stopLat[from]!, network.stopLon[from]!, network.stopLat[to]!, network.stopLon[to]!,
  );
  const secondsFor = (from: number, to: number, meters: number, minimum: number) => Math.max(
    minimum,
    Math.round(meters / WALK_METERS_PER_SECOND) + WALK_TRANSFER_SLACK_SECONDS + network.stationAccessSeconds(from, to),
  );

  function remember(from: number, to: number, forward: TransferWalk, backward: TransferWalk): void {
    const key = walkKey(from, to);
    const reverse = walkKey(to, from);
    // Refresh the pair together. Eviction must not retain a different answer in the other
    // search direction or retain two independently growing stores for the same street walk.
    walks.delete(key);
    walks.delete(reverse);
    walks.set(key, forward);
    walks.set(reverse, backward);
    while (walks.size > MAX_TRANSFER_WALK_CACHE_ENTRIES) {
      const oldest = walks.keys().next().value!;
      walks.delete(oldest);
      const separator = oldest.indexOf('>');
      if (separator >= 0) walks.delete(`${oldest.slice(separator + 1)}>${oldest.slice(0, separator)}`);
    }
    physicalGenerations.set(walks, (physicalGenerations.get(walks) ?? 0) + 1);
  }

  function cost(from: number, to: number, straight = metersBetween(from, to)): { seconds: number; validated: boolean } | null {
    if (from === to || !served(from) || !served(to) || !Number.isFinite(straight) || straight > budget) return null;
    const published = network.publishedTransferSeconds(from, to);
    if (published !== undefined && published < 0) return null;
    const minimum = published ?? 0;
    const known = walks.get(walkKey(from, to));
    if (known?.kind === 'measured') return known.meters <= budget
      ? { seconds: secondsFor(from, to, known.meters, minimum), validated: true }
      : null;
    if (known?.kind === 'notWithin' && known.checkedMeters >= budget) return null;

    // GTFS platforms in one parent station retain their published passage semantics: station
    // interiors need not appear in the outdoor street graph. Without any graph, use the same
    // conservative estimate and distance policy for every agency and direction.
    if (!graph || sameStation(from, to)) {
      const meters = straight * TRANSFER_DETOUR;
      return meters <= budget ? { seconds: secondsFor(from, to, meters, minimum), validated: true } : null;
    }
    return { seconds: secondsFor(from, to, straight, minimum), validated: false };
  }

  function resolve(stop: number, direction: 'forward' | 'backward'): readonly { stop: number; seconds: number }[] {
    if (!served(stop)) return [];
    const key = `${stop}:${direction}`;
    const generation = physicalGenerations.get(walks) ?? 0;
    const cached = resolved.get(key);
    if (cached?.generation === generation) return cached.edges;
    let nearby = candidates.get(stop);
    if (!nearby) {
      nearby = network.stopsNear(network.stopLat[stop]!, network.stopLon[stop]!, budget);
      candidates.set(stop, nearby);
    }
    const possible = new Map(nearby.map((entry) => [entry.stop, entry.meters]));
    for (const edge of network.publishedTransfers(stop, direction)) {
      if (!possible.has(edge.stop)) possible.set(edge.stop, metersBetween(stop, edge.stop));
    }
    const edges: { stop: number; seconds: number }[] = [];
    for (const [other, meters] of possible) {
      const evaluated = direction === 'forward' ? cost(stop, other, meters) : cost(other, stop, meters);
      if (evaluated) edges.push({ stop: other, seconds: evaluated.seconds });
    }
    resolved.set(key, { generation, edges });
    return edges;
  }

  function validate(journeys: readonly Journey[], maxChecks = Infinity): { changed: boolean; checks: number } {
    let checks = 0;
    let changed = false;
    const limit = Number.isFinite(maxChecks) ? Math.max(0, Math.floor(maxChecks)) : Infinity;
    for (const journey of journeys) for (const leg of journey.legs) {
      if (leg.kind !== 'walk' || leg.from === null || leg.to === null) continue;
      const evaluated = cost(leg.from, leg.to);
      if (!evaluated || evaluated.validated || checks >= limit) continue;
      // Always check the normal ceiling, even for lessWalking. A successful 600 m lookup is
      // useful to the next normal request; a failed 390 m lookup must not forbid it globally.
      const walk = walkingPath(network.stopLat[leg.from]!, network.stopLon[leg.from]!,
        network.stopLat[leg.to]!, network.stopLon[leg.to]!, TRANSFER_WALK_METERS);
      checks += 1;
      if (walk) {
        const path = walk.path.map((point) => ({ lat: point.lat, lng: point.lon }));
        remember(leg.from, leg.to, { kind: 'measured', meters: walk.meters, path },
          { kind: 'measured', meters: walk.meters, path: [...path].reverse() });
      } else {
        const result: TransferWalk = { kind: 'notWithin', checkedMeters: TRANSFER_WALK_METERS };
        remember(leg.from, leg.to, result, result);
      }
      changed = true;
    }
    return { changed, checks };
  }

  function isValidated(journey: Journey): boolean {
    return journey.legs.every((leg) => {
      if (leg.kind !== 'walk' || leg.from === null || leg.to === null) return true;
      const evaluated = cost(leg.from, leg.to);
      return evaluated !== null && evaluated.validated && leg.seconds >= evaluated.seconds;
    });
  }

  return { resolve, validate, isValidated };
}
