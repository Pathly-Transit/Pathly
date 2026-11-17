import { gunzipSync, gzipSync } from 'zlib';

/**
 * One agency's timetable laid out for trip planning (transitRouter.ts): every trip grouped into
 * stop patterns, with the stops, calendars, line names and colors, station transfers and track
 * geometry a planned trip needs, so planning reads one compact file per agency instead of the
 * GTFS text files. Written by routingTimetableBuild.ts next to the other prepared files
 * (derived/routing.bin), both at deploy time and by the daily snapshot refresh.
 *
 * File: gzip of "PRT1", u32 header length, the JSON header (RoutingHeader), zero padding to an
 * 8-byte boundary, then each array the header lists, in order, each padded to 8 bytes. All
 * little-endian. Coordinates are microdegrees; times are seconds after the service day's GTFS
 * midnight (noon minus 12 hours), which can pass 24:00:00 for trips running after midnight.
 *
 * A pattern is a run of stops several trips make in the same order with the same pickup and
 * drop-off rules. Its trips are sorted so no trip overtakes another (each one leaves and arrives
 * no earlier than the one before it at every stop), which lets the planner find the first trip
 * leaving a stop after a given time by binary search. Trips with the same running times share a
 * profile: a trip's time at a stop is its start time plus its profile's offset there.
 */

export const ROUTING_FORMAT_VERSION = 1;
const MAGIC = 'PRT1';

/** pickup_type / drop_off_type 1 at a pattern stop: no boarding, or no getting off, there. */
export const NO_PICKUP = 1;
export const NO_DROP_OFF = 2;

export type RoutingRoute = {
  id: string;
  shortName: string;
  longName: string;
  /** GTFS route_type: 0 tram, 1 subway, 2 rail, 3 bus, 4 ferry, ... */
  type: number;
  /** "RRGGBB" as the feed publishes it, or "" when it gives none. */
  color: string;
  textColor: string;
  /** Index into the header's agencies. */
  agency: number;
};

/** service_id's weekly days (bit 0 Sunday ... bit 6 Saturday) and dates as YYYYMMDD numbers. */
export type RoutingService = { id: string; days: number; start: number; end: number; added: number[]; removed: number[] };

export type RoutingPattern = {
  route: number;
  /** GTFS direction_id, or -1 when the feed leaves it blank. */
  direction: number;
  /** Index into headsigns: what most of its trips show. */
  headsign: number;
  stopCount: number;
  tripCount: number;
  profileCount: number;
  pathPoints: number;
};

type ArrayType = 'i32' | 'u32' | 'u8';
type ArraySpec = { name: string; type: ArrayType; length: number };

export type RoutingHeader = {
  format: number;
  agencyId: string;
  agencies: { name: string; url?: string }[];
  stopIds: string[];
  stopNames: string[];
  routes: RoutingRoute[];
  services: RoutingService[];
  headsigns: string[];
  tripIds: string[];
  patterns: RoutingPattern[];
  /** transfers.txt between stops: [from, to, seconds]; seconds -1 means the change isn't possible. */
  stopTransfers: [number, number, number][];
  /** transfers.txt's timed transfers: [fromTrip, toTrip, stop], a connection that's held. */
  tripTransfers: [number, number, number][];
  arrays: ArraySpec[];
};

/** The decoded file: the header plus its arrays, by name. */
export type RoutingTimetable = RoutingHeader & {
  /** Microdegrees; parent is -1 for a stop with no station. */
  stopLat: Int32Array;
  stopLon: Int32Array;
  stopParent: Int32Array;
  /** Per pattern, in pattern order: its stops, their pickup/drop-off flags, and where each sits on its path. */
  patternStops: Int32Array;
  patternFlags: Uint8Array;
  patternPathIndex: Uint32Array;
  pathLat: Int32Array;
  pathLon: Int32Array;
  /** Per trip, in pattern order (each pattern's trips sorted and overtaking-free). */
  tripStart: Int32Array;
  tripProfile: Uint32Array;
  tripService: Uint32Array;
  /** Index into headsigns, or -1 for the pattern's own. */
  tripHeadsign: Int32Array;
  /** Per profile (each pattern's in order), one offset per pattern stop from the trip's start. */
  profileArr: Int32Array;
  profileDep: Int32Array;
};

const ARRAY_NAMES = [
  ['stopLat', 'i32'], ['stopLon', 'i32'], ['stopParent', 'i32'],
  ['patternStops', 'i32'], ['patternFlags', 'u8'], ['patternPathIndex', 'u32'],
  ['pathLat', 'i32'], ['pathLon', 'i32'],
  ['tripStart', 'i32'], ['tripProfile', 'u32'], ['tripService', 'u32'], ['tripHeadsign', 'i32'],
  ['profileArr', 'i32'], ['profileDep', 'i32'],
] as const satisfies readonly (readonly [keyof RoutingTimetable, ArrayType])[];

type TypedArray = Int32Array | Uint32Array | Uint8Array;
const CONSTRUCTORS = { i32: Int32Array, u32: Uint32Array, u8: Uint8Array } as const;

const padTo8 = (length: number) => (8 - (length % 8)) % 8;

export function encodeRoutingTimetable(timetable: RoutingTimetable): Buffer {
  const arrays: ArraySpec[] = ARRAY_NAMES.map(([name, type]) => ({ name, type, length: (timetable[name] as TypedArray).length }));
  const header: RoutingHeader = {
    format: ROUTING_FORMAT_VERSION,
    agencyId: timetable.agencyId,
    agencies: timetable.agencies,
    stopIds: timetable.stopIds,
    stopNames: timetable.stopNames,
    routes: timetable.routes,
    services: timetable.services,
    headsigns: timetable.headsigns,
    tripIds: timetable.tripIds,
    patterns: timetable.patterns,
    stopTransfers: timetable.stopTransfers,
    tripTransfers: timetable.tripTransfers,
    arrays,
  };
  const json = Buffer.from(JSON.stringify(header), 'utf-8');
  const parts: Buffer[] = [Buffer.from(MAGIC, 'ascii'), Buffer.alloc(4), json, Buffer.alloc(padTo8(8 + json.length))];
  parts[1]!.writeUInt32LE(json.length, 0);
  for (const [name] of ARRAY_NAMES) {
    const array = timetable[name] as TypedArray;
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    parts.push(bytes, Buffer.alloc(padTo8(bytes.length)));
  }
  return gzipSync(Buffer.concat(parts), { level: 6 });
}

export function decodeRoutingTimetable(gzipped: Buffer): RoutingTimetable {
  const buffer = gunzipSync(gzipped);
  if (buffer.toString('ascii', 0, 4) !== MAGIC) throw new Error('not a routing timetable');
  const jsonLength = buffer.readUInt32LE(4);
  const header = JSON.parse(buffer.toString('utf-8', 8, 8 + jsonLength)) as RoutingHeader;
  if (header.format !== ROUTING_FORMAT_VERSION) throw new Error(`routing timetable format ${header.format} is not ${ROUTING_FORMAT_VERSION}`);
  let offset = 8 + jsonLength + padTo8(8 + jsonLength);
  const decoded: Record<string, TypedArray> = {};
  for (const spec of header.arrays) {
    const Type = CONSTRUCTORS[spec.type];
    const byteLength = spec.length * Type.BYTES_PER_ELEMENT;
    if (offset + byteLength > buffer.length) throw new Error(`routing timetable is truncated at ${spec.name}`);
    // Copied out so every array is aligned, whatever the gunzipped buffer's own offset.
    decoded[spec.name] = new Type(buffer.buffer.slice(buffer.byteOffset + offset, buffer.byteOffset + offset + byteLength) as ArrayBuffer);
    offset += byteLength + padTo8(byteLength);
  }
  for (const [name] of ARRAY_NAMES) {
    if (!decoded[name]) throw new Error(`routing timetable has no ${name}`);
  }
  return { ...header, ...(decoded as unknown as Omit<RoutingTimetable, keyof RoutingHeader>) };
}

/** "20261117" as 20261117. */
export const dateNumber = (dateKey: string) => Number(dateKey);

/** Whether a service runs on a date (YYYYMMDD number; dayOfWeek 0 Sunday). Exceptions win over the weekly pattern. */
export function serviceRunsOn(service: RoutingService, date: number, dayOfWeek: number): boolean {
  if (service.removed.includes(date)) return false;
  if (service.added.includes(date)) return true;
  if (date < service.start || date > service.end) return false;
  return (service.days & (1 << dayOfWeek)) !== 0;
}
