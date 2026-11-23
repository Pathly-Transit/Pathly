import { basename } from 'node:path';

import { parse } from 'csv-parse/sync';
import { unzipSync, zipSync, type Zippable } from 'fflate';

import trackGeometry from './pathTrackGeometry.json';

// Versioned cartography from the committed Trillium shapes (source SHA/date in the JSON).
// All ten current operator patterns were checked against the same legacy station order and
// pathAlongShape. Known station entrances have separate stops.txt SHA provenance. No old
// timetable/service data is reused; provider shapes and per-station entrances take precedence.
const TRACKS = new Map(trackGeometry.patterns.map((pattern) => [JSON.stringify([pattern.routeId, pattern.directionId, pattern.stopIds]), pattern]));

/** The operator's replacement feed uses different IDs from RidePATH's live arrivals. */
const ROUTES: Record<string, { id: string; name: string }> = {
  RED: { id: '862', name: 'Newark - World Trade Center' },
  YEL: { id: '861', name: 'Journal Square - 33rd Street' },
  ATW: { id: '1024', name: 'Journal Square - 33rd Street (via Hoboken)' },
  BLU: { id: '859', name: 'Hoboken - 33rd Street' },
  GRE: { id: '860', name: 'Hoboken - World Trade Center' },
};
/** Canonical west-to-east station order; short-turn trips must still agree with live direction IDs. */
const ROUTE_STOPS: Record<string, string[]> = {
  RED: ['26733', '26729', '26731', '26728', '26727', '26734'],
  YEL: ['26731', '26728', '26732', '26726', '26725', '26722', '26723', '26724'],
  ATW: ['26731', '26728', '26732', '26730', '26726', '26725', '26722', '26723', '26724'],
  BLU: ['26730', '26726', '26725', '26722', '26723', '26724'],
  GRE: ['26730', '26732', '26727', '26734'],
};

type Station = { id: string; name: string; lat: number; lon: number; aliases: string[] };
const STATIONS: Station[] = [
  { id: '26725', name: '9th Street', lat: 40.73424, lon: -73.9991, aliases: ['781735', '781734', 'place_09S'] },
  { id: '26722', name: '14th Street', lat: 40.73735, lon: -73.99684, aliases: ['781737', '781736', 'place_14S'] },
  { id: '26723', name: '23rd Street', lat: 40.7429, lon: -73.99278, aliases: ['781739', '781738', 'place_23S'] },
  { id: '26724', name: '33rd Street', lat: 40.74912, lon: -73.98827, aliases: ['781740', '781742', 'place_33S'] },
  { id: '26726', name: 'Christopher Street', lat: 40.73295, lon: -74.00707, aliases: ['781733', '781732', 'place_CHR'] },
  { id: '26727', name: 'Exchange Place', lat: 40.71676, lon: -74.03238, aliases: ['781731', '781730', 'place_EXP'] },
  { id: '26728', name: 'Grove Street', lat: 40.71966, lon: -74.04245, aliases: ['781727', '781726', 'place_GRV'] },
  { id: '26729', name: 'Harrison', lat: 40.73942, lon: -74.15587, aliases: ['781721', '781720', 'place_HAR'] },
  { id: '26730', name: 'Hoboken', lat: 40.73586, lon: -74.02922, aliases: ['781743', '781744', 'place_HOB'] },
  { id: '26731', name: 'Journal Square', lat: 40.73301, lon: -74.06289, aliases: ['781722', '781723', '781724', '781725', 'place_JSQ'] },
  { id: '26732', name: 'Newport', lat: 40.72699, lon: -74.03383, aliases: ['781728', '781729', 'place_NEW'] },
  { id: '26733', name: 'Newark', lat: 40.73454, lon: -74.16375, aliases: ['781719', '781718', 'place_NWK'] },
  { id: '26734', name: 'World Trade Center', lat: 40.71271, lon: -74.01193, aliases: ['781747', '781750', 'place_WTC'] },
];
const STATION_BY_ALIAS = new Map(STATIONS.flatMap((station) => station.aliases.map((alias) => [alias, station] as const)));
const STATION_BY_ID = new Map(STATIONS.map((station) => [station.id, station]));
type Row = Record<string, string>;
type Table = { name: string; header: string[]; rows: Row[] };
const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** Only known source schemas are rewritten; an identifier change must never silently merge stations. */
export function normalizePathStaticArchive(archive: Buffer): Buffer {
  const entries = unzipSync(archive);
  const table = (filename: string, required = true): Table | null => {
    const names = Object.keys(entries).filter((name) => basename(name.replaceAll('\\', '/')) === filename);
    if (names.length === 0 && !required) return null;
    if (names.length !== 1) throw new Error(`PATH feed must contain exactly one ${filename}`);
    const name = names[0]!;
    const parsed = parse(entries[name]!, { bom: true, skip_empty_lines: true }) as string[][];
    const header = parsed.shift()?.map((value) => value.trim()) ?? [];
    if (header.length === 0 || new Set(header).size !== header.length) throw new Error(`PATH ${filename} has invalid columns`);
    return { name, header, rows: parsed.map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']))) };
  };
  const routes = table('routes.txt', false);
  if (!routes || !routes.rows.some((row) => Object.hasOwn(ROUTES, row.route_id?.trim() ?? ''))) return archive;
  for (const row of routes.rows) {
    const sourceId = row.route_id?.trim() ?? '';
    const route = Object.hasOwn(ROUTES, sourceId) ? ROUTES[sourceId] : undefined;
    if (!route) throw new Error(`PATH feed has an unrecognized or mixed route_id ${sourceId}`);
    row.route_id = route.id;
    row.route_short_name = 'PATH';
    row.route_long_name = route.name;
  }
  const stops = table('stops.txt')!;
  const stopAliases = new Map<string, Station>();
  const stationRows = new Map<string, Row>();
  const seenStopIds = new Set<string>();
  const entranceRows: Row[] = [];
  for (const row of stops.rows) {
    const id = row.stop_id?.trim() ?? '';
    if (!id || seenStopIds.has(id)) throw new Error('PATH stop_id is missing or repeated');
    seenStopIds.add(id);
    if (row.location_type?.trim() === '2') {
      entranceRows.push({ ...row, stop_id: id });
      continue;
    }
    const station = STATION_BY_ALIAS.get(id);
    if (!station) throw new Error(`PATH feed has an unrecognized stop_id ${id}`);
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (!row.stop_lat?.trim() || !row.stop_lon?.trim() || !Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat - station.lat) > 0.001 || Math.abs(lon - station.lon) > 0.001
      || row.stop_name?.trim().toLowerCase() !== station.name.toLowerCase()) throw new Error(`PATH stop_id ${id} no longer identifies ${station.name}`);
    stopAliases.set(id, station);
    // The place_* row represents the station; platforms carry the identical published position.
    if (!stationRows.has(station.id) || id.startsWith('place_')) stationRows.set(station.id,
      { ...row, stop_id: station.id, stop_name: station.name, location_type: '1', parent_station: '' });
  }
  const entrances = new Map<string, Row[]>();
  const entranceIds = new Set<string>();
  for (const row of entranceRows) {
    const parent = row.parent_station?.trim() ?? '';
    const station = stopAliases.get(parent) ?? STATION_BY_ID.get(parent);
    if (!station || !stationRows.has(station.id)) throw new Error(`PATH entrance has an unknown parent_station ${parent}`);
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (!row.stop_lat?.trim() || !row.stop_lon?.trim() || !Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180 || stationRows.has(row.stop_id!)) throw new Error('PATH entrance has invalid coordinates or stop_id');
    const normalized = { ...row, location_type: '2', parent_station: station.id };
    entrances.set(station.id, [...(entrances.get(station.id) ?? []), normalized]);
    entranceIds.add(row.stop_id!);
  }
  // Provider entrances replace all retained entrances at that station; other stations retain
  // their known spatial metadata. Entrances are never registered as timetable stop aliases.
  const providerStations = new Set(entrances.keys());
  for (const entrance of trackGeometry.entrances) {
    if (!stationRows.has(entrance.parentStation) || providerStations.has(entrance.parentStation) || entranceIds.has(entrance.stopId)) continue;
    const row = { stop_id: entrance.stopId, stop_name: entrance.name, stop_lat: String(entrance.lat), stop_lon: String(entrance.lon), location_type: '2', parent_station: entrance.parentStation };
    entrances.set(entrance.parentStation, [...(entrances.get(entrance.parentStation) ?? []), row]);
    entranceIds.add(entrance.stopId);
  }
  const stopId = (value: string | undefined) => {
    const station = stopAliases.get(value?.trim() ?? '');
    if (!station) throw new Error(`PATH feed references an unknown stop_id ${value ?? ''}`);
    return station.id;
  };
  const trips = table('trips.txt')!;
  const byTrip = new Map<string, { row: Row; sourceRoute: string; visits: { sequence: number; station: Station }[] }>();
  for (const row of trips.rows) {
    const route = row.route_id?.trim() ?? '';
    if (!Object.hasOwn(ROUTES, route)) throw new Error(`PATH trip references an unknown route_id ${route}`);
    if (row.direction_id !== '0' && row.direction_id !== '1') throw new Error('PATH trip must have direction_id 0 or 1');
    if (!row.trip_id || byTrip.has(row.trip_id)) throw new Error('PATH trip_id is missing or repeated');
    byTrip.set(row.trip_id, { row, sourceRoute: route, visits: [] });
    row.route_id = ROUTES[route]!.id;
    row.direction_id = row.direction_id === '0' ? '1' : '0';
  }
  const times = table('stop_times.txt')!;
  const providerShapes = table('shapes.txt', false);
  const retainedShapes = new Map<string, (typeof trackGeometry.patterns)[number]>();
  for (const row of times.rows) {
    if (!byTrip.has(row.trip_id ?? '')) throw new Error('PATH stop time references an unknown trip_id');
    const station = stopAliases.get(row.stop_id?.trim() ?? '');
    if (!station) throw new Error(`PATH stop time references an unknown stop_id ${row.stop_id ?? ''}`);
    const sequence = Number(row.stop_sequence);
    if (!row.stop_sequence?.trim() || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('PATH stop_sequence is invalid');
    row.stop_id = station.id;
    byTrip.get(row.trip_id!)!.visits.push({ sequence, station });
  }
  for (const { row, sourceRoute, visits } of byTrip.values()) {
    visits.sort((a, b) => a.sequence - b.sequence);
    const positions = visits.map((visit) => ROUTE_STOPS[sourceRoute]!.indexOf(visit.station.id));
    const sign = row.direction_id === '1' ? 1 : -1;
    if (positions.length < 2 || positions.some((position, index) => position < 0 || (index > 0 && (position - positions[index - 1]!) * sign < 0))
      || positions[0] === positions.at(-1)) throw new Error('PATH trip station order disagrees with its expected live direction');
    const terminal = visits.at(-1)?.station.name;
    if (!terminal) throw new Error('PATH trip has no stop times');
    row.trip_headsign = terminal + (sourceRoute === 'ATW' && visits.some((visit) => visit.station.id === '26730') && terminal !== 'Hoboken' ? ' via Hoboken' : '');
    if (!providerShapes?.rows.length) {
      // A new/short-turn station pattern is never assigned a convenient whole-line shape.
      const track = TRACKS.get(JSON.stringify([row.route_id, Number(row.direction_id), visits.map((visit) => visit.station.id)]));
      if (track) {
        const id = `pathly-track-v1-${track.sourceShapeId}`;
        row.shape_id = id;
        retainedShapes.set(id, track);
      }
    }
  }
  stops.rows = [...stationRows.values(), ...[...entrances.values()].flat()].sort((a, b) => a.stop_id!.localeCompare(b.stop_id!));
  const transfers = table('transfers.txt', false);
  if (transfers) for (const row of transfers.rows) {
    row.from_stop_id = stopId(row.from_stop_id);
    row.to_stop_id = stopId(row.to_stop_id);
    for (const key of ['from_route_id', 'to_route_id']) if (row[key]) {
      const route = Object.hasOwn(ROUTES, row[key]!) ? ROUTES[row[key]!] : undefined;
      if (!route) throw new Error('PATH transfer references an unknown route_id');
      row[key] = route.id;
    }
  }
  const write = (value: Table, added: string[] = []) => {
    for (const key of added) if (!value.header.includes(key)) value.header.push(key);
    entries[value.name] = new TextEncoder().encode([value.header.map(quote).join(','),
      ...value.rows.map((row) => value.header.map((key) => quote(row[key] ?? '')).join(',')), ''].join('\n'));
  };
  write(routes, ['route_short_name', 'route_long_name']);
  write(stops, ['location_type', 'parent_station']);
  write(trips, ['trip_headsign', ...(retainedShapes.size ? ['shape_id'] : [])]);
  write(times);
  if (transfers) write(transfers);
  if (retainedShapes.size) write({
    name: providerShapes?.name ?? 'shapes.txt',
    header: ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
    rows: [...retainedShapes].flatMap(([id, shape]) => shape.points.map((point, index) => ({
      shape_id: id, shape_pt_lat: String(point[0]), shape_pt_lon: String(point[1]), shape_pt_sequence: String(index + 1),
    }))),
  });
  const sorted: Zippable = {};
  for (const name of Object.keys(entries).sort()) sorted[name] = entries[name]!;
  return Buffer.from(zipSync(sorted, { level: 6, mtime: new Date('2000-01-01T00:00:00Z') }));
}
