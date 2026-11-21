import { agencyConfig, type AgencyId } from './gtfsAgencies';
import { gtfsTimeToSeconds, isServiceRunningOn, loadAgencyStaticData, loadRouteStopTimes } from './gtfsStaticData';
import type { GtfsTripStatus } from './gtfsStatus';
import { gtfsServiceDaysFor, type GtfsServiceDay } from './gtfsServiceTime';

export type DirectionPrediction = {
  minutes: number;
  live: boolean;
  /** This specific trip's real LIRR peak/off-peak classification — null for agencies without fare tiers (e.g. subway's flat fare) or if it couldn't be resolved. */
  peakOffpeak: boolean | null;
  /**
   * How many minutes behind (negative: ahead of) its timetable a tracked trip is running at this
   * stop: the feed's own delay, or else its live time against trips.txt where the agency's live
   * trip_ids match the timetable's. Null for a timetable departure, or when it can't be told.
   */
  delayMinutes: number | null;
  /**
   * Where this trip ends: its timetable headsign, or else the last stop the live feed lists for
   * it. A direction's trips don't all go as far (an S76 short-turning at Clove Rd), so each
   * departure says its own. Null when neither is known.
   */
  headsign: string | null;
};
export type StopPredictions = {
  towardDirection1: readonly DirectionPrediction[];
  towardDirection0: readonly DirectionPrediction[];
};

/** Tiles shown per direction on route detail. */
const PREDICTIONS_PER_DIRECTION = 6;

type Entry = { tripId: string; minutes: number; peakOffpeak: boolean | null; delayMinutes: number | null; headsign: string | null };
/** A tracked trip at the asked-for stop, before its delay is resolved. */
type LiveEntry = Entry & { stopId: string; atMs: number };

/** Beyond this, a live time and a timetable time are taken to belong to different runs of the trip. */
const MAX_PLAUSIBLE_DELAY_MINUTES = 180;

const feedDelayMinutes = (delaySeconds: number | null) => (delaySeconds == null ? null : Math.round(delaySeconds / 60));

/**
 * Upcoming departures for one station, by direction — works the same way for any configured
 * agency, with two behaviors that switch on gtfsAgencies.ts's per-agency flags:
 *
 * Direction is read by matching *which* of `direction1StopId`/`direction0StopId` a trip hits
 * when `directionalStops` is set (NYC Subway: direction_id is unreliable there, but each
 * direction has its own stop_id); otherwise by the trip's own direction_id, looked up against
 * `direction1StopId` for both directions (LIRR-style: one stop_id serves a station regardless
 * of direction, so direction1StopId === direction0StopId is expected and correct there).
 *
 * Live predictions are padded with the real published timetable (never a placeholder) for
 * every agency, including overlapping overnight and next-date service.
 * Where realtime and static trip_ids match (`realtimeTripIdsMatchStatic`), a tracked trip's
 * timetable entry is dropped by id; otherwise only timetable departures after the last live
 * one are added (see gtfsAgencies.ts).
 */
export async function getStopPredictions(
  agencyId: AgencyId,
  routeId: string,
  direction1StopId: string,
  direction0StopId: string,
  trips: readonly GtfsTripStatus[],
  /** How many departures to return per direction; the full departures list asks for many more. */
  limit = PREDICTIONS_PER_DIRECTION,
): Promise<StopPredictions> {
  const config = agencyConfig(agencyId);
  const now = Date.now();
  const { tripsById, stopsById } = loadAgencyStaticData(agencyId);
  // The last stop a feed lists for a trip names where it ends, unless that is the asked-for stop
  // itself: PATH's feed lists each train at one station only, so at World Trade Center every
  // train, Hoboken-bound ones too, would read "To World Trade Center".
  const liveHeadsign = (trip: GtfsTripStatus, atStopId: string): string | null => {
    const timetable = tripsById.get(trip.tripId)?.headsign;
    if (timetable) return timetable;
    const lastStopId = trip.stops.at(-1)?.stopId;
    if (!lastStopId || lastStopId === atStopId) return null;
    return stopsById.get(lastStopId)?.name || null;
  };
  const direction1Live: LiveEntry[] = [];
  const direction0Live: LiveEntry[] = [];

  for (const trip of trips) {
    if (config.directionalStops) {
      const stop = trip.stops.find((candidate) => candidate.stopId === direction1StopId || candidate.stopId === direction0StopId);
      if (!stop?.scheduledTime) continue;
      const atMs = new Date(stop.scheduledTime).getTime();
      const minutes = Math.round((atMs - now) / 60_000);
      if (minutes < 0) continue;
      // Terminals can serve both directions from one stop_id; the trip's own direction decides then.
      const isDirection1 = direction1StopId === direction0StopId ? trip.directionId === 1 : stop.stopId === direction1StopId;
      (isDirection1 ? direction1Live : direction0Live).push({ tripId: trip.tripId, minutes, peakOffpeak: trip.peakOffpeak, delayMinutes: feedDelayMinutes(stop.delaySeconds), headsign: liveHeadsign(trip, stop.stopId), stopId: stop.stopId, atMs });
    } else {
      const stop = trip.stops.find((candidate) => candidate.stopId === direction1StopId);
      if (!stop?.scheduledTime) continue;
      const atMs = new Date(stop.scheduledTime).getTime();
      const minutes = Math.round((atMs - now) / 60_000);
      if (minutes < 0) continue;
      (trip.directionId === 1 ? direction1Live : direction0Live).push({ tripId: trip.tripId, minutes, peakOffpeak: trip.peakOffpeak, delayMinutes: feedDelayMinutes(stop.delaySeconds), headsign: liveHeadsign(trip, stop.stopId), stopId: stop.stopId, atMs });
    }
  }

  // The published timetable pads live predictions across neighboring service dates, so each
  // direction can show actual departures even with one or no vehicle tracked.
  const direction1Static: Entry[] = [];
  const direction0Static: Entry[] = [];
  const liveEntries = [...direction1Live, ...direction0Live];
  const seenTripIds = new Set(liveEntries.map((entry) => entry.tripId));
  const { byStop, byTrip } = await loadRouteStopTimes(agencyId, routeId);
  // A shuttle's trip ends at the other terminal: arriving there isn't a departure from it.
  const endsTripHere = (stopTime: { tripId: string; stopSequence: number }) => config.terminalShuttle === true
    && (byTrip.get(stopTime.tripId) ?? []).every((other) => other.stopSequence <= stopTime.stopSequence);
  const serviceDays = gtfsServiceDaysFor(now, [-1, 0, 1]);

  // A tracked trip the feed gives no delay for is compared with its own timetable time at the stop,
  // when the live trip_ids are the timetable's. Compare plausible runs on their own calendar
  // dates: overnight service and a DST-adjusted next day can overlap the current civil date.
  if (config.realtimeTripIdsMatchStatic) {
    for (const entry of liveEntries) {
      if (entry.delayMinutes !== null) continue;
      const stopTime = (byStop.get(entry.stopId) ?? []).find((candidate) => candidate.tripId === entry.tripId);
      if (!stopTime) continue;
      const scheduledSeconds = gtfsTimeToSeconds(stopTime.departureTime || stopTime.arrivalTime);
      const trip = tripsById.get(entry.tripId);
      const delays = serviceDays.filter((day) => trip && isServiceRunningOn(agencyId, trip.serviceId, day.dateKey, day.dayOfWeek))
        .map((day) => Math.round((entry.atMs - (day.startMs + scheduledSeconds * 1000)) / 60_000));
      if (!delays.length) continue;
      const delay = delays.reduce((best, candidate) => (Math.abs(candidate) < Math.abs(best) ? candidate : best));
      if (Math.abs(delay) <= MAX_PLAUSIBLE_DELAY_MINUTES) entry.delayMinutes = delay;
    }
  }
  // Directional-stop agencies have one stop_id per direction; otherwise one shared stop_id
  // (direction1StopId === direction0StopId) and the trip's direction_id decides.
  const stopIds = config.directionalStops ? [...new Set([direction1StopId, direction0StopId])] : [direction1StopId];

  const collectStatic = (day: GtfsServiceDay) => {
    for (const stopId of stopIds) {
      for (const stopTime of byStop.get(stopId) ?? []) {
        const trip = tripsById.get(stopTime.tripId);
        if (!trip || trip.routeId !== routeId) continue;
        if (endsTripHere(stopTime)) continue;
        if (!isServiceRunningOn(agencyId, trip.serviceId, day.dateKey, day.dayOfWeek)) continue;

        const eventMs = day.startMs + gtfsTimeToSeconds(stopTime.departureTime || stopTime.arrivalTime) * 1000;
        const minutes = Math.round((eventMs - now) / 60_000);
        if (minutes < 0) continue;
        if (config.realtimeTripIdsMatchStatic && seenTripIds.has(stopTime.tripId)
          && liveEntries.some((entry) => entry.tripId === stopTime.tripId
            && Math.abs(entry.atMs - eventMs) <= MAX_PLAUSIBLE_DELAY_MINUTES * 60_000)) continue;

        const isDirection1 = config.directionalStops && direction1StopId !== direction0StopId ? stopId === direction1StopId : trip.directionId === 1;
        (isDirection1 ? direction1Static : direction0Static).push({ tripId: stopTime.tripId, minutes, peakOffpeak: trip.peakOffpeak, delayMinutes: null, headsign: trip.headsign || null });
      }
    }
  };

  // Prior service can run past 24:00, and a DST-adjusted next service day can start before civil midnight.
  // Collect all three calendar dates and sort by actual instants rather than assuming 24h boundaries.
  for (const day of serviceDays) collectStatic(day);

  const merge = (live: Entry[], staticEntries: Entry[]): DirectionPrediction[] => {
    // Without matching trip_ids, a tracked trip's own timetable entry can't be identified, so
    // only timetable departures after the last live one are added (never the same trip twice).
    const lastLive = Math.max(-1, ...live.map((entry) => entry.minutes));
    const padding = config.realtimeTripIdsMatchStatic ? staticEntries : staticEntries.filter((entry) => entry.minutes > lastLive);
    const merged: DirectionPrediction[] = [
      ...live.map((entry) => ({ minutes: entry.minutes, live: true, peakOffpeak: entry.peakOffpeak, delayMinutes: entry.delayMinutes, headsign: entry.headsign })),
      ...padding.map((entry) => ({ minutes: entry.minutes, live: false, peakOffpeak: entry.peakOffpeak, delayMinutes: null, headsign: entry.headsign })),
    ];
    merged.sort((a, b) => a.minutes - b.minutes);
    return merged.slice(0, limit);
  };

  return {
    towardDirection1: merge(direction1Live, direction1Static),
    towardDirection0: merge(direction0Live, direction0Static),
  };
}
