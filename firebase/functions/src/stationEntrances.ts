import type { AgencyId } from './gtfsAgencies';
import type { GtfsStop } from './gtfsFeed';
import { loadAgencyStaticData } from './gtfsStaticData';
import subwayRows from './subwayEntrances.json';

/**
 * A station's ways in and out, for the stop list and a trip's boarding and alighting stops.
 *
 * From the agency's own stops.txt where it publishes entrances (location_type 2, under their
 * parent_station: PATH, every station). The MTA's subway feed publishes none, so the subway's come
 * from the state's "Subway Entrances and Exits" open data, keyed by the same GTFS station ids
 * (scripts/generate-subway-entrances.mjs). LIRR, Metro-North, the ferries and buses have none.
 *
 * No source names an entrance's street, so each says which side of the station it's on
 * (`corner`: the compass point from the station's own point), or none when it's right at it.
 */

export type EntranceKind = 'stair' | 'elevator' | 'escalator' | 'stair-escalator' | 'ramp' | 'street' | 'passage' | 'station-house' | 'walkway' | 'entrance';
export type EntranceAccess = 'both' | 'entry' | 'exit';
export type EntranceCorner = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
export type StationEntrance = { lat: number; lon: number; kind: EntranceKind; access: EntranceAccess; corner?: EntranceCorner };

type SubwayRow = [lat: number, lon: number, type: string, access: EntranceAccess];
const SUBWAY = subwayRows as unknown as Record<string, SubwayRow[]>;

/** Closer than this to the station's point, an entrance is at no side of it worth naming. */
const CENTER_METERS = 20;
const CORNERS: readonly EntranceCorner[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const KINDS: Record<string, EntranceKind> = {
  Stair: 'stair',
  Elevator: 'elevator',
  Escalator: 'escalator',
  'Stair/Escalator': 'stair-escalator',
  Ramp: 'ramp',
  'Stair/Ramp': 'ramp',
  'Stair/Ramp/Walkway': 'ramp',
  'Easement - Street': 'street',
  'Easement - Passage': 'passage',
  Underpass: 'passage',
  Overpass: 'passage',
  'Station House': 'station-house',
  Walkway: 'walkway',
};

/** The compass point from `from` to `to`, or undefined when they're within CENTER_METERS. */
export function entranceCorner(from: { lat: number; lon: number }, to: { lat: number; lon: number }): EntranceCorner | undefined {
  const east = (to.lon - from.lon) * Math.cos((from.lat * Math.PI) / 180) * 111_320;
  const north = (to.lat - from.lat) * 110_540;
  if (Math.hypot(east, north) < CENTER_METERS) return undefined;
  const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
  return CORNERS[Math.round(bearing / 45) % 8];
}

function withCorner(station: GtfsStop | undefined, entrance: Omit<StationEntrance, 'corner'>): StationEntrance {
  const corner = station ? entranceCorner(station, entrance) : undefined;
  return corner ? { ...entrance, corner } : entrance;
}

/**
 * The entrances and exits of the station `stopId` is (or is a platform of), clockwise from north;
 * empty when the agency publishes none for it, or its data isn't loaded.
 */
export function stationEntrances(agencyId: AgencyId, stopId: string): StationEntrance[] {
  let data;
  try {
    data = loadAgencyStaticData(agencyId);
  } catch {
    return [];
  }
  const stationId = data.stopsById.get(stopId)?.parentStation ?? stopId;
  const station = data.stopsById.get(stationId);
  const published = data.entrancesByStation?.get(stationId) ?? [];
  const entrances = published.length > 0
    ? published.map((point) => withCorner(station, { lat: point.lat, lon: point.lon, kind: 'entrance', access: 'both' }))
    : agencyId === 'subway'
      ? (SUBWAY[stationId] ?? []).map(([lat, lon, type, access]) => withCorner(station, { lat, lon, kind: KINDS[type] ?? 'entrance', access }))
      : [];
  const order = (entrance: StationEntrance) => (entrance.corner ? CORNERS.indexOf(entrance.corner) : -1);
  return entrances.sort((a, b) => order(a) - order(b));
}

/** The route's stops, each with its station's entrances when it has any. */
export function withStopEntrances<T extends { stopId: string }>(agencyId: AgencyId, stops: readonly T[]): (T & { entrances?: StationEntrance[] })[] {
  return stops.map((stop) => {
    const entrances = stationEntrances(agencyId, stop.stopId);
    return entrances.length > 0 ? { ...stop, entrances } : stop;
  });
}
