import type { LatLng, TransitStep, TripStep } from './tripPlanning';

/**
 * A station's ways in and out, as the backend serves them with route stops and trip legs
 * (firebase/functions/src/stationEntrances.ts): subway and PATH stations only. No source names an
 * entrance's street, so each says which side of the station it's on (`corner`), when it isn't
 * right at the station's own point.
 */
export type EntranceKind = 'stair' | 'elevator' | 'escalator' | 'stair-escalator' | 'ramp' | 'street' | 'passage' | 'station-house' | 'walkway' | 'entrance';
export type EntranceAccess = 'both' | 'entry' | 'exit';
export type EntranceCorner = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
export type StationEntrance = { lat: number; lon: number; kind: EntranceKind; access: EntranceAccess; corner?: EntranceCorner };

const KIND_NAMES: Record<EntranceKind, string> = {
  stair: 'Stair',
  elevator: 'Elevator',
  escalator: 'Escalator',
  'stair-escalator': 'Stair or escalator',
  ramp: 'Ramp',
  street: 'Street entrance',
  passage: 'Passageway',
  'station-house': 'Station house',
  walkway: 'Walkway',
  entrance: 'Entrance',
};
const SIDES: Record<EntranceCorner, string> = { N: 'north', E: 'east', S: 'south', W: 'west', NE: 'NE', SE: 'SE', SW: 'SW', NW: 'NW' };
const KINDS = new Set(Object.keys(KIND_NAMES));
const CORNERS = new Set(Object.keys(SIDES));
const ACCESS = new Set(['both', 'entry', 'exit']);

/** "NE corner" or "north side"; undefined when the entrance is right at the station. */
function sideName(corner: EntranceCorner | undefined): string | undefined {
  if (!corner) return undefined;
  return corner.length === 2 ? `${SIDES[corner]} corner` : `${SIDES[corner]} side`;
}

/** A list row: "Stair, NE corner (exit only)", "Elevator, north side", "Entrance". */
export function entranceLabel(entrance: StationEntrance): string {
  const name = KIND_NAMES[entrance.kind];
  const side = sideName(entrance.corner);
  const access = entrance.access === 'exit' ? ' (exit only)' : entrance.access === 'entry' ? ' (entrance only)' : '';
  return `${side ? `${name}, ${side}` : name}${access}`;
}

/** "Enter by the stair at the NE corner", "Exit on the north side", "Enter at the station entrance". */
export function entranceInstruction(entrance: StationEntrance, use: 'enter' | 'exit'): string {
  const verb = use === 'enter' ? 'Enter' : 'Exit';
  const side = sideName(entrance.corner);
  const at = side ? `${entrance.corner!.length === 2 ? 'at' : 'on'} the ${side}` : null;
  // PATH's entrances say nothing about themselves but where they are.
  if (entrance.kind === 'entrance') return at ? `${verb} ${at}` : `${verb} at the station entrance`;
  const by = `${verb} by the ${KIND_NAMES[entrance.kind].toLowerCase()}`;
  return at ? `${by} ${at}` : by;
}

const KIND_PLURALS: Record<EntranceKind, string> = {
  stair: 'stairs',
  elevator: 'elevators',
  escalator: 'escalators',
  'stair-escalator': 'stairs or escalators',
  ramp: 'ramps',
  street: 'street entrances',
  passage: 'passageways',
  'station-house': 'station houses',
  walkway: 'walkways',
  entrance: 'entrances',
};

/**
 * A station's entrances as list rows, alike ones together: "3 stairs, north side",
 * "Elevator, south side", in the order they come (clockwise from north).
 */
export function entranceRows(entrances: readonly StationEntrance[]): string[] {
  const groups = new Map<string, { entrance: StationEntrance; count: number }>();
  for (const entrance of entrances) {
    const key = entranceLabel(entrance);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { entrance, count: 1 });
  }
  return [...groups.entries()].map(([label, { entrance, count }]) => {
    if (count === 1) return label;
    const plural = KIND_PLURALS[entrance.kind];
    return `${count} ${plural}${label.slice(KIND_NAMES[entrance.kind].length)}`;
  });
}

/** "4 entrances", "1 entrance". */
export function entranceCount(entrances: readonly StationEntrance[]): string {
  return `${entrances.length} ${entrances.length === 1 ? 'entrance' : 'entrances'}`;
}

function meters(entrance: StationEntrance, point: LatLng): number {
  const x = (entrance.lon - point.lng) * Math.cos((point.lat * Math.PI) / 180);
  return Math.hypot(x, entrance.lat - point.lat) * 111_320;
}

/**
 * The way in (or out) nearest `toward`: where the rider is coming from, or going next. Entrances
 * closed to that use are passed over; undefined when there's none, or nothing to measure from.
 */
export function nearestEntrance(entrances: readonly StationEntrance[] | undefined, toward: LatLng | undefined, use: 'enter' | 'exit'): StationEntrance | undefined {
  if (!entrances || !toward) return undefined;
  const open = entrances.filter((entrance) => entrance.access === 'both' || (use === 'enter' ? entrance.access === 'entry' : entrance.access === 'exit'));
  let best: StationEntrance | undefined;
  for (const entrance of open) if (!best || meters(entrance, toward) < meters(best, toward)) best = entrance;
  return best;
}

/** The entrances in a backend payload that are well formed; undefined when none are. */
export function parseEntrances(value: unknown): StationEntrance[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entrances = value.filter((item): item is StationEntrance => typeof item === 'object' && item !== null
    && Number.isFinite(item.lat) && Number.isFinite(item.lon) && KINDS.has(item.kind) && ACCESS.has(item.access)
    && (item.corner === undefined || CORNERS.has(item.corner)))
    .map(({ lat, lon, kind, access, corner }) => (corner ? { lat, lon, kind, access, corner } : { lat, lon, kind, access }));
  return entrances.length > 0 ? entrances : undefined;
}

/** Two legs' stops closer than this (or joined by a walk this short) are one station: the rider changes inside. */
const SAME_STATION_METERS = 150;

const metersBetween = (a: LatLng, b: LatLng) => Math.hypot((a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180), a.lat - b.lat) * 111_320;

/**
 * Where the ride at `steps[index]` is entered and left: the way in nearest where the rider comes
 * from (the walk's start, or the last ride's stop), and the way out nearest where they go next (the
 * next walk's destination, or the next ride's stop). Neither when the rider changes inside the
 * station, nor at a stop with no entrances (buses, commuter rail, ferries).
 */
export function legEntrances(steps: readonly TripStep[], index: number): { enter?: StationEntrance; exit?: StationEntrance } {
  const step = steps[index];
  if (step?.kind !== 'transit') return {};
  const before = steps[index - 1];
  const after = steps[index + 1];
  const rideBefore = before?.kind === 'walk' ? steps[index - 2] : before;
  const rideAfter = after?.kind === 'walk' ? steps[index + 2] : after;
  const changesAt = (ride: TripStep | undefined, walk: TripStep | undefined, here: LatLng, there: (ride: TransitStep) => LatLng) => ride?.kind === 'transit'
    && (walk?.kind === 'walk' ? walk.distanceMeters <= SAME_STATION_METERS : metersBetween(there(ride), here) <= SAME_STATION_METERS);
  const from = before?.kind === 'walk' ? before.path[0] : before?.kind === 'transit' ? before.to.location : undefined;
  const to = after?.kind === 'walk' ? after.path.at(-1) : after?.kind === 'transit' ? after.from.location : undefined;
  const enter = changesAt(rideBefore, before, step.from.location, (ride) => ride.to.location) ? undefined : nearestEntrance(step.boardEntrances, from, 'enter');
  const exit = changesAt(rideAfter, after, step.to.location, (ride) => ride.from.location) ? undefined : nearestEntrance(step.alightEntrances, to, 'exit');
  return { ...(enter ? { enter } : {}), ...(exit ? { exit } : {}) };
}
