import { NO_DROP_OFF, NO_PICKUP } from './routingTimetable';
import type { ServiceDay, TransitMode, TransitNetwork } from './transitNetwork';

/**
 * Round-based public transit routing (RAPTOR: Delling, Pajor and Werneck, "Round-Based Public
 * Transit Routing", 2012) over the merged network (transitNetwork.ts). Round k finds the earliest
 * arrival at every stop using exactly k vehicles, so one search yields the fastest trip for each
 * number of rides: the trade-off between speed and changes riders pick from.
 *
 * Times are seconds after the base service day's GTFS midnight. A trip runs on one of the given
 * service days (yesterday's late-night trips, today's, tomorrow's early ones), each shifted by
 * that day's offset. `forward` plans "leave at", `backward` plans "arrive by".
 */

const INF = 0x3fffffff;
const NEG_INF = -INF;

export type StopTime = { stop: number; seconds: number };

export type RideLeg = {
  kind: 'ride';
  pattern: number;
  trip: number;
  /** Index into the search's service days. */
  day: number;
  boardPosition: number;
  alightPosition: number;
  boardStop: number;
  alightStop: number;
  departs: number;
  arrives: number;
};
export type WalkLeg = { kind: 'walk'; from: number | null; to: number | null; seconds: number };
export type Journey = { legs: (RideLeg | WalkLeg)[]; departs: number; arrives: number; rides: number };

export type SearchOptions = {
  days: readonly ServiceDay[];
  maxRounds: number;
  modes: ReadonlySet<TransitMode>;
  bannedRoutes?: ReadonlySet<number>;
  bannedTrips?: ReadonlySet<number>;
  bannedRuns?: ReadonlySet<string>;
  /** Forward recovery can prefer the existing line on its first ride without banning later transfers. */
  firstRoutes?: ReadonlySet<number>;
  /** How long after leaving (or before arriving) a trip may take at most, in seconds. */
  horizonSeconds: number;
};

/** One round's labels per stop, plus how each was reached. */
class RoundLabels {
  /** Forward: arrival by a vehicle / on foot. Backward: departure on a vehicle / leaving on foot. */
  readonly byRide: Int32Array;
  readonly byWalk: Int32Array;
  readonly pattern: Int32Array;
  readonly trip: Int32Array;
  readonly day: Int8Array;
  readonly boardPosition: Int16Array;
  readonly alightPosition: Int16Array;
  /** Forward: where the ride was boarded. Backward: where it's left. */
  readonly rideEnd: Int32Array;
  /** Whether the ride continued from the previous round's walk label (1) or ride label (0). */
  readonly via: Uint8Array;
  readonly walkOther: Int32Array;
  readonly walkSeconds: Int32Array;

  constructor(size: number) {
    this.byRide = new Int32Array(size);
    this.byWalk = new Int32Array(size);
    this.pattern = new Int32Array(size);
    this.trip = new Int32Array(size);
    this.day = new Int8Array(size);
    this.boardPosition = new Int16Array(size);
    this.alightPosition = new Int16Array(size);
    this.rideEnd = new Int32Array(size);
    this.via = new Uint8Array(size);
    this.walkOther = new Int32Array(size);
    this.walkSeconds = new Int32Array(size);
  }

  reset(empty: number): void {
    this.byRide.fill(empty);
    this.byWalk.fill(empty);
  }
}

export class TransitRouter {
  private readonly rounds: RoundLabels[] = [];
  private readonly best: Int32Array;
  private readonly marked: Uint8Array;
  private readonly rideMarked: Uint8Array;
  private readonly queuePosition: Int32Array;
  private readonly patternAllowed: Uint8Array;
  private readonly egressSeconds: Int32Array;
  private active: Uint8Array[] = [];
  private options!: SearchOptions;

  constructor(private readonly network: TransitNetwork, maxRounds: number) {
    const size = network.stopCount;
    for (let round = 0; round <= maxRounds; round += 1) this.rounds.push(new RoundLabels(size));
    this.best = new Int32Array(size);
    this.marked = new Uint8Array(size);
    this.rideMarked = new Uint8Array(size);
    this.queuePosition = new Int32Array(network.patternCount).fill(-1);
    this.patternAllowed = new Uint8Array(network.patternCount);
    this.egressSeconds = new Int32Array(size).fill(-1);
  }

  private prepare(options: SearchOptions, active: Uint8Array[]): void {
    if (options.maxRounds >= this.rounds.length) throw new Error('more rounds than the router was built for');
    this.options = options;
    this.active = active;
    const { network } = this;
    for (let pattern = 0; pattern < network.patternCount; pattern += 1) {
      const route = network.patternRoute[pattern]!;
      this.patternAllowed[pattern] = options.modes.has(network.routes[route]!.mode) && !options.bannedRoutes?.has(route) ? 1 : 0;
    }
  }

  private isTripUsable(trip: number, day: number): boolean {
    return this.active[day]![this.network.tripService[trip]!] === 1 && !this.options.bannedTrips?.has(trip)
      && !this.options.bannedRuns?.has(`${trip}@${this.options.days[day]!.date}`);
  }

  /** The first trip of `pattern` leaving `position` at or after `time`, over every service day. */
  private earliestTrip(pattern: number, position: number, time: number): { trip: number; day: number; departs: number } | null {
    const { network } = this;
    const first = network.patternTripStart[pattern]!;
    const last = network.patternTripStart[pattern + 1]!;
    let found: { trip: number; day: number; departs: number } | null = null;
    for (let day = 0; day < this.options.days.length; day += 1) {
      const offset = this.options.days[day]!.offset;
      let low = first;
      let high = last;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (network.departure(middle, position) + offset < time) low = middle + 1;
        else high = middle;
      }
      for (let trip = low; trip < last; trip += 1) {
        const departs = network.departure(trip, position) + offset;
        if (found && departs >= found.departs) break;
        if (this.isTripUsable(trip, day)) {
          found = { trip, day, departs };
          break;
        }
      }
    }
    return found;
  }

  /** The last trip of `pattern` reaching `position` at or before `time`, over every service day. */
  private latestTrip(pattern: number, position: number, time: number): { trip: number; day: number; arrives: number } | null {
    const { network } = this;
    const first = network.patternTripStart[pattern]!;
    const last = network.patternTripStart[pattern + 1]!;
    let found: { trip: number; day: number; arrives: number } | null = null;
    for (let day = 0; day < this.options.days.length; day += 1) {
      const offset = this.options.days[day]!.offset;
      let low = first;
      let high = last;
      // First trip arriving after `time`; the ones before it all arrive in time.
      while (low < high) {
        const middle = (low + high) >> 1;
        if (network.arrival(middle, position) + offset <= time) low = middle + 1;
        else high = middle;
      }
      for (let trip = low - 1; trip >= first; trip -= 1) {
        const arrives = network.arrival(trip, position) + offset;
        if (found && arrives <= found.arrives) break;
        if (this.isTripUsable(trip, day)) {
          found = { trip, day, arrives };
          break;
        }
      }
    }
    return found;
  }

  private resetRounds(empty: number): void {
    for (let round = 0; round <= this.options.maxRounds; round += 1) this.rounds[round]!.reset(empty);
    this.best.fill(empty);
  }

  /**
   * Earliest arrivals leaving at `departs`: the fastest journey for each number of rides, each
   * faster than any with fewer rides.
   */
  forward(departs: number, access: readonly StopTime[], egress: readonly StopTime[], options: SearchOptions, active: Uint8Array[]): Journey[] {
    this.prepare(options, active);
    const { network, best, marked, rideMarked, queuePosition, patternAllowed, egressSeconds } = this;
    const { maxRounds } = options;
    const horizon = departs + options.horizonSeconds;
    this.resetRounds(INF);
    for (const { stop, seconds } of egress) egressSeconds[stop] = egressSeconds[stop]! < 0 ? seconds : Math.min(egressSeconds[stop]!, seconds);

    let markedList: number[] = [];
    const start = this.rounds[0]!;
    for (const { stop, seconds } of access) {
      const time = departs + seconds;
      if (time < start.byWalk[stop]!) {
        start.byWalk[stop] = time;
        start.walkOther[stop] = -1;
        start.walkSeconds[stop] = seconds;
        if (time < best[stop]!) best[stop] = time;
        if (!marked[stop]) {
          marked[stop] = 1;
          markedList.push(stop);
        }
      }
    }

    let target = INF;
    const destination: { arrives: number; stop: number }[] = [{ arrives: INF, stop: -1 }];
    const { patternStopStart, patternStops, patternFlags, patternTripStart, tripStart, tripProfileOffset, profileArr, profileDep, stopChangeSeconds, stopPatternStart, stopPatternPattern, stopPatternPosition, transferStart, transferTo, transferSeconds, timedTransfers, tripPattern, tripService } = network;

    for (let round = 1; round <= maxRounds && markedList.length > 0; round += 1) {
      const previous = this.rounds[round - 1]!;
      const current = this.rounds[round]!;
      const queue: number[] = [];
      for (const stop of markedList) {
        marked[stop] = 0;
        for (let slot = stopPatternStart[stop]!; slot < stopPatternStart[stop + 1]!; slot += 1) {
          const pattern = stopPatternPattern[slot]!;
          if (!patternAllowed[pattern] || (round === 1 && options.firstRoutes && !options.firstRoutes.has(network.patternRoute[pattern]!))) continue;
          const position = stopPatternPosition[slot]!;
          const queued = queuePosition[pattern]!;
          if (queued < 0) {
            queuePosition[pattern] = position;
            queue.push(pattern);
          } else if (position < queued) {
            queuePosition[pattern] = position;
          }
        }
      }
      markedList = [];
      const rideList: number[] = [];

      for (const pattern of queue) {
        const from = queuePosition[pattern]!;
        queuePosition[pattern] = -1;
        const base = patternStopStart[pattern]!;
        const count = patternStopStart[pattern + 1]! - base;
        let trip = -1;
        let day = 0;
        let offset = 0;
        let startTime = 0;
        let profile = 0;
        let boardPosition = -1;
        let boardStop = -1;
        let via = 0;
        for (let position = from; position < count; position += 1) {
          const stop = patternStops[base + position]!;
          const flags = patternFlags[base + position]!;
          if (trip >= 0 && (flags & NO_DROP_OFF) === 0) {
            const arrives = startTime + profileArr[profile + position]! + offset;
            if (arrives < best[stop]! && arrives < target && arrives <= horizon) {
              current.byRide[stop] = arrives;
              best[stop] = arrives;
              current.pattern[stop] = pattern;
              current.trip[stop] = trip;
              current.day[stop] = day;
              current.boardPosition[stop] = boardPosition;
              current.alightPosition[stop] = position;
              current.rideEnd[stop] = boardStop;
              current.via[stop] = via;
              if (!rideMarked[stop]) {
                rideMarked[stop] = 1;
                rideList.push(stop);
              }
            }
          }
          if ((flags & NO_PICKUP) !== 0) continue;
          const byRide = previous.byRide[stop]!;
          const rideReady = byRide < INF ? byRide + stopChangeSeconds[stop]! : INF;
          const walkReady = previous.byWalk[stop]!;
          const ready = walkReady <= rideReady ? walkReady : rideReady;
          if (ready >= INF) continue;
          const currentDeparts = trip >= 0 ? startTime + profileDep[profile + position]! + offset : INF;
          if (ready > currentDeparts) continue;
          let found = this.earliestTrip(pattern, position, ready);
          let foundVia = walkReady <= rideReady ? 1 : 0;
          // A timed transfer the feed promises to hold: no change time needed.
          if (byRide < INF) {
            const held = timedTransfers.get(previous.trip[stop]!);
            if (held) {
              for (const [heldTrip, heldStop] of held) {
                if (heldStop !== stop || tripPattern[heldTrip] !== pattern) continue;
                for (let heldDay = 0; heldDay < options.days.length; heldDay += 1) {
                  const heldDeparts = tripStart[heldTrip]! + profileDep[tripProfileOffset[heldTrip]! + position]! + options.days[heldDay]!.offset;
                  if (heldDeparts >= byRide && this.isTripUsable(heldTrip, heldDay) && (!found || heldDeparts < found.departs)) {
                    found = { trip: heldTrip, day: heldDay, departs: heldDeparts };
                    foundVia = 0;
                  }
                }
              }
            }
          }
          if (found && found.departs < currentDeparts) {
            trip = found.trip;
            day = found.day;
            offset = options.days[day]!.offset;
            startTime = tripStart[trip]!;
            profile = tripProfileOffset[trip]!;
            boardPosition = position;
            boardStop = stop;
            via = foundVia;
          }
        }
      }

      for (const stop of rideList) {
        rideMarked[stop] = 0;
        if (!marked[stop]) {
          marked[stop] = 1;
          markedList.push(stop);
        }
        const arrived = current.byRide[stop]!;
        for (let slot = transferStart[stop]!; slot < transferStart[stop + 1]!; slot += 1) {
          const seconds = transferSeconds[slot]!;
          if (seconds < 0) continue;
          const to = transferTo[slot]!;
          const time = arrived + seconds;
          if (time < best[to]! && time < target && time < current.byWalk[to]!) {
            current.byWalk[to] = time;
            current.walkOther[to] = stop;
            current.walkSeconds[to] = seconds;
            best[to] = time;
            if (!marked[to]) {
              marked[to] = 1;
              markedList.push(to);
            }
          }
        }
      }

      let reached = { arrives: INF, stop: -1 };
      for (const { stop } of egress) {
        const arrived = current.byRide[stop]!;
        if (arrived >= INF) continue;
        const arrives = arrived + egressSeconds[stop]!;
        if (arrives < reached.arrives) reached = { arrives, stop };
      }
      destination.push(reached);
      if (reached.arrives < target) target = reached.arrives;
    }
    for (const stop of markedList) marked[stop] = 0;
    for (const { stop } of egress) egressSeconds[stop] = -1;

    const journeys: Journey[] = [];
    let fastest = INF;
    destination.forEach((reached, round) => {
      if (round === 0 || reached.stop < 0 || reached.arrives >= fastest) return;
      fastest = reached.arrives;
      journeys.push(this.forwardJourney(round, reached.stop, egress));
    });
    return journeys;
  }

  private forwardJourney(round: number, stop: number, egress: readonly StopTime[]): Journey {
    const legs: (RideLeg | WalkLeg)[] = [];
    const egressSeconds = Math.min(...egress.filter((entry) => entry.stop === stop).map((entry) => entry.seconds));
    legs.push({ kind: 'walk', from: stop, to: null, seconds: egressSeconds });
    let current = stop;
    let usingWalk = false;
    for (let k = round; k >= 1; ) {
      const labels = this.rounds[k]!;
      if (usingWalk) {
        const other = labels.walkOther[current]!;
        legs.push({ kind: 'walk', from: other, to: current, seconds: labels.walkSeconds[current]! });
        current = other;
        usingWalk = false;
        continue;
      }
      const pattern = labels.pattern[current]!;
      const trip = labels.trip[current]!;
      const day = labels.day[current]!;
      const offset = this.options.days[day]!.offset;
      const boardPosition = labels.boardPosition[current]!;
      const alightPosition = labels.alightPosition[current]!;
      const boardStop = labels.rideEnd[current]!;
      legs.push({
        kind: 'ride',
        pattern,
        trip,
        day,
        boardPosition,
        alightPosition,
        boardStop,
        alightStop: current,
        departs: this.network.departure(trip, boardPosition) + offset,
        arrives: this.network.arrival(trip, alightPosition) + offset,
      });
      usingWalk = labels.via[current] === 1;
      current = boardStop;
      k -= 1;
    }
    // Round 0's walk label is the walk from the origin.
    legs.push({ kind: 'walk', from: null, to: current, seconds: this.rounds[0]!.walkSeconds[current]! });
    legs.reverse();
    return finishJourney(legs);
  }

  /**
   * Latest departures arriving by `arrives`: for each number of rides, the journey leaving
   * latest, each leaving later than any with fewer rides.
   */
  backward(arrives: number, access: readonly StopTime[], egress: readonly StopTime[], options: SearchOptions, active: Uint8Array[]): Journey[] {
    this.prepare(options, active);
    const { network, best, marked, rideMarked, queuePosition, patternAllowed, egressSeconds } = this;
    const { maxRounds } = options;
    const horizon = arrives - options.horizonSeconds;
    this.resetRounds(NEG_INF);
    // egressSeconds here holds each stop's walk from the origin (the access walks).
    for (const { stop, seconds } of access) egressSeconds[stop] = egressSeconds[stop]! < 0 ? seconds : Math.min(egressSeconds[stop]!, seconds);

    let markedList: number[] = [];
    const start = this.rounds[0]!;
    for (const { stop, seconds } of egress) {
      const time = arrives - seconds;
      if (time > start.byWalk[stop]!) {
        start.byWalk[stop] = time;
        start.walkOther[stop] = -1;
        start.walkSeconds[stop] = seconds;
        if (time > best[stop]!) best[stop] = time;
        if (!marked[stop]) {
          marked[stop] = 1;
          markedList.push(stop);
        }
      }
    }

    let target = NEG_INF;
    const origin: { departs: number; stop: number }[] = [{ departs: NEG_INF, stop: -1 }];
    const { patternStopStart, patternStops, patternFlags, tripStart, tripProfileOffset, profileArr, profileDep, stopChangeSeconds, stopPatternStart, stopPatternPattern, stopPatternPosition, transferStart, transferTo, transferSeconds } = network;

    for (let round = 1; round <= maxRounds && markedList.length > 0; round += 1) {
      const previous = this.rounds[round - 1]!;
      const current = this.rounds[round]!;
      const queue: number[] = [];
      for (const stop of markedList) {
        marked[stop] = 0;
        for (let slot = stopPatternStart[stop]!; slot < stopPatternStart[stop + 1]!; slot += 1) {
          const pattern = stopPatternPattern[slot]!;
          if (!patternAllowed[pattern]) continue;
          const position = stopPatternPosition[slot]!;
          const queued = queuePosition[pattern]!;
          if (queued < 0) {
            queuePosition[pattern] = position;
            queue.push(pattern);
          } else if (position > queued) {
            queuePosition[pattern] = position;
          }
        }
      }
      markedList = [];
      const rideList: number[] = [];

      for (const pattern of queue) {
        const from = queuePosition[pattern]!;
        queuePosition[pattern] = -1;
        const base = patternStopStart[pattern]!;
        let trip = -1;
        let day = 0;
        let offset = 0;
        let startTime = 0;
        let profile = 0;
        let alightPosition = -1;
        let alightStop = -1;
        let via = 0;
        for (let position = from; position >= 0; position -= 1) {
          const stop = patternStops[base + position]!;
          const flags = patternFlags[base + position]!;
          if (trip >= 0 && (flags & NO_PICKUP) === 0) {
            const departs = startTime + profileDep[profile + position]! + offset;
            if (departs > best[stop]! && departs > target && departs >= horizon) {
              current.byRide[stop] = departs;
              best[stop] = departs;
              current.pattern[stop] = pattern;
              current.trip[stop] = trip;
              current.day[stop] = day;
              current.boardPosition[stop] = position;
              current.alightPosition[stop] = alightPosition;
              current.rideEnd[stop] = alightStop;
              current.via[stop] = via;
              if (!rideMarked[stop]) {
                rideMarked[stop] = 1;
                rideList.push(stop);
              }
            }
          }
          if ((flags & NO_DROP_OFF) !== 0) continue;
          const byRide = previous.byRide[stop]!;
          const rideReady = byRide > NEG_INF ? byRide - stopChangeSeconds[stop]! : NEG_INF;
          const walkReady = previous.byWalk[stop]!;
          const ready = walkReady >= rideReady ? walkReady : rideReady;
          if (ready <= NEG_INF) continue;
          const currentArrives = trip >= 0 ? startTime + profileArr[profile + position]! + offset : NEG_INF;
          if (ready < currentArrives) continue;
          const found = this.latestTrip(pattern, position, ready);
          if (found && found.arrives > currentArrives) {
            trip = found.trip;
            day = found.day;
            offset = options.days[day]!.offset;
            startTime = tripStart[trip]!;
            profile = tripProfileOffset[trip]!;
            alightPosition = position;
            alightStop = stop;
            via = walkReady >= rideReady ? 1 : 0;
          }
        }
      }

      for (const stop of rideList) {
        rideMarked[stop] = 0;
        if (!marked[stop]) {
          marked[stop] = 1;
          markedList.push(stop);
        }
        const leaves = current.byRide[stop]!;
        for (let slot = transferStart[stop]!; slot < transferStart[stop + 1]!; slot += 1) {
          const seconds = transferSeconds[slot]!;
          if (seconds < 0) continue;
          const to = transferTo[slot]!;
          const time = leaves - seconds;
          if (time > best[to]! && time > target && time > current.byWalk[to]!) {
            current.byWalk[to] = time;
            current.walkOther[to] = stop;
            current.walkSeconds[to] = seconds;
            best[to] = time;
            if (!marked[to]) {
              marked[to] = 1;
              markedList.push(to);
            }
          }
        }
      }

      let reached = { departs: NEG_INF, stop: -1 };
      for (const { stop } of access) {
        const leaves = current.byRide[stop]!;
        if (leaves <= NEG_INF) continue;
        const departs = leaves - egressSeconds[stop]!;
        if (departs > reached.departs) reached = { departs, stop };
      }
      origin.push(reached);
      if (reached.departs > target) target = reached.departs;
    }
    for (const stop of markedList) marked[stop] = 0;
    for (const { stop } of access) egressSeconds[stop] = -1;

    const journeys: Journey[] = [];
    let latest = NEG_INF;
    origin.forEach((reached, round) => {
      if (round === 0 || reached.stop < 0 || reached.departs <= latest) return;
      latest = reached.departs;
      journeys.push(this.backwardJourney(round, reached.stop, access));
    });
    return journeys;
  }

  private backwardJourney(round: number, stop: number, access: readonly StopTime[]): Journey {
    const legs: (RideLeg | WalkLeg)[] = [];
    const accessSeconds = Math.min(...access.filter((entry) => entry.stop === stop).map((entry) => entry.seconds));
    legs.push({ kind: 'walk', from: null, to: stop, seconds: accessSeconds });
    let current = stop;
    let usingWalk = false;
    for (let k = round; k >= 1; ) {
      const labels = this.rounds[k]!;
      if (usingWalk) {
        const other = labels.walkOther[current]!;
        legs.push({ kind: 'walk', from: current, to: other, seconds: labels.walkSeconds[current]! });
        current = other;
        usingWalk = false;
        continue;
      }
      const pattern = labels.pattern[current]!;
      const trip = labels.trip[current]!;
      const day = labels.day[current]!;
      const offset = this.options.days[day]!.offset;
      const boardPosition = labels.boardPosition[current]!;
      const alightPosition = labels.alightPosition[current]!;
      const alightStop = labels.rideEnd[current]!;
      legs.push({
        kind: 'ride',
        pattern,
        trip,
        day,
        boardPosition,
        alightPosition,
        boardStop: current,
        alightStop,
        departs: this.network.departure(trip, boardPosition) + offset,
        arrives: this.network.arrival(trip, alightPosition) + offset,
      });
      usingWalk = labels.via[current] === 1;
      current = alightStop;
      k -= 1;
    }
    legs.push({ kind: 'walk', from: current, to: null, seconds: this.rounds[0]!.walkSeconds[current]! });
    return finishJourney(legs);
  }
}

/** Times the walks around the rides: leave just in time for the first, walk on as soon as one arrives. */
function finishJourney(legs: (RideLeg | WalkLeg)[]): Journey {
  const rides = legs.filter((leg): leg is RideLeg => leg.kind === 'ride');
  const first = rides[0]!;
  const last = rides.at(-1)!;
  const accessWalk = legs[0]!.kind === 'walk' ? legs[0]!.seconds : 0;
  const egressWalk = legs.at(-1)!.kind === 'walk' ? (legs.at(-1) as WalkLeg).seconds : 0;
  return { legs, departs: first.departs - accessWalk, arrives: last.arrives + egressWalk, rides: rides.length };
}
