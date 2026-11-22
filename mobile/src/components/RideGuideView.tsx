import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { NavigationGuidance } from '../data/enrouteNavigation';
import { rideGuideItinerary, rideStopTimes, type RideGuideRequest } from '../data/rideGuide';
import { legDepartureOptions, retimeItinerary, type DepartureChoices } from '../data/tripDepartures';
import { formatTripClock, type Itinerary, type LatLng, type TransitStep } from '../data/tripPlanning';
import { useUserPreferences } from '../data/userPreferences';
import type { Coordinates } from '../hooks/useCurrentLocation';
import { useClock } from '../hooks/useClock';
import { useTripVehicles } from '../hooks/useTripVehicles';
import { useTheme } from '../theme/AppSettings';
import { ActiveTripNotices } from './ActiveTripNotices';
import { toTripDetailModel, useLiveFollow, useLiveVehicles, withMapLive, type LiveTripFollow } from './PlannedTripDetailView';
import { SharedTripDetailView, tripDetailMapPadding } from './SharedTripDetailView';
import { TripMap } from './TripMap';
import { VehicleSheet } from './VehicleSheet';

/** The active trip, when it's this ride: what it's following and where the rider is on it. */
export type RideGuideLiveTrip = {
  itinerary: Itinerary;
  guidance: NavigationGuidance;
};

type RideGuideViewProps = {
  request: RideGuideRequest;
  onBack: () => void;
  /** Starts the ride as shown (the departure and stop the rider picked), or moves the live trip to it. */
  onStart: (itinerary: Itinerary, alightName: string) => void;
  /** Ends the live trip. */
  onEnd: () => void;
  /** The active trip when it's this ride; null before it starts (or when the rider kept another trip). */
  live?: RideGuideLiveTrip | null;
  /** The rider's real position, for the map's location button; null when unknown. */
  riderLocation?: Coordinates | null;
  /** While `live`: how the page follows the trip (the map, hurry up, a shared ride). */
  follow?: LiveTripFollow | null;
};

/** Before boarding, the trip can still move to a later departure; after, it stays on the one taken. */
function boarded(live: RideGuideLiveTrip | null | undefined): boolean {
  return Boolean(live && live.guidance.phase !== 'walking' && live.guidance.phase !== 'waiting-to-board');
}

function rideOf(itinerary: Itinerary): TransitStep | undefined {
  return itinerary.steps.find((step): step is TransitStep => step.kind === 'transit');
}

/** Same departure to the same stop: the live trip already follows what the page shows. */
function sameRide(left: Itinerary, right: Itinerary): boolean {
  const a = rideOf(left);
  const b = rideOf(right);
  return left.id === right.id && a?.from.time === b?.from.time && a?.to.time === b?.to.time;
}

/**
 * Route View's GO: one line, for a rider who already knows they're taking it. Laid out like Trip
 * Details ("Leave within", leave and arrive times, the ride with its departures and alerts), for
 * that one ride. Opening it starts the trip, so this page is the navigation too, and END ends it. Its last stop is where the rider gets off, changed right in
 * the ride's card; a new stop or departure moves the live trip with it.
 */
export function RideGuideView({ follow: followTrip = null, live = null, onBack, onEnd, onStart, request, riderLocation }: RideGuideViewProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { preferences } = useUserPreferences();
  // The end of the line until the rider picks their stop; resumed, the stop and departure the live trip has.
  const liveRide = live ? rideOf(live.itinerary) : undefined;
  const [alightIndex, setAlightIndex] = useState(() => {
    const resumed = liveRide ? request.stops.findIndex((stop, index) => index > 0 && stop.name === liveRide.to.name) : -1;
    return resumed > 0 ? resumed : request.stops.length - 1;
  });
  const [choices, setChoices] = useState<DepartureChoices>(() => (liveRide ? new Map([[0, liveRide.from.time]]) : new Map()));
  const [focusStop, setFocusStop] = useState<{ point: LatLng; key: number } | null>(null);
  const [centerRequest, setCenterRequest] = useState(0);
  const [centered, setCentered] = useState(false);
  // A vehicle tapped on the map, shown in the same sheet as Route View's.
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const clock = useClock(30_000);
  // On board, the ride taken doesn't roll over to the next one once its departure passes.
  const liveDeparture = live && boarded(live) ? Date.parse(rideOf(live.itinerary)?.from.time ?? '') : NaN;
  const now = Number.isFinite(liveDeparture) ? Math.min(clock, liveDeparture) : clock;
  const planned = useMemo(() => rideGuideItinerary(request, alightIndex), [alightIndex, request]);
  const itinerary = useMemo(() => (planned ? retimeItinerary(planned, choices, now) : null), [choices, now, planned]);
  const departures = useMemo(() => (planned ? legDepartureOptions(planned, choices, now) : []), [choices, now, planned]);
  const { vehicles, approachLines } = useTripVehicles(itinerary, colors.primary);
  // Once the ride is under way the map follows the rider, as Trip Details does.
  const following = live ? followTrip : null;
  const follow = useLiveFollow(following != null);
  const { shown: shownVehicles, reportTripId } = useLiveVehicles(vehicles, following);
  const alight = request.stops[alightIndex] ?? request.stops.at(-1)!;

  // GO already happened on Route View: the trip starts as this page opens.
  const startOnOpen = useEffectEvent(() => {
    if (itinerary && !live) onStart(itinerary, alight.name);
  });
  useEffect(() => startOnOpen(), []);

  // A picked stop or departure, or a missed one before boarding, moves the live trip along with the page.
  const followPage = useEffectEvent(() => {
    if (itinerary && live && !sameRide(itinerary, live.itinerary)) onStart(itinerary, alight.name);
  });
  useEffect(() => followPage(), [itinerary]);

  if (!itinerary) return null;

  const ride = rideOf(itinerary)!;
  const stopTimes = rideStopTimes(request, ride.from.time);
  const userLocation = following ? following.userLocation : riderLocation ? { lat: riderLocation.latitude, lng: riderLocation.longitude } : null;
  const model = withMapLive({
    ...toTripDetailModel(itinerary, request.stops[0]!.name, alight.name, false, colors.primary, departures, preferences.travel.fareType),
    // No fare is known for a ride picked this way; the page doesn't guess one.
    fare: '',
    contextLabel: 'Ride',
  }, itinerary, vehicles, now);
  const vehicle = vehicles.find((candidate) => candidate.tripId === vehicleId) ?? null;
  const vehicleMode = request.mode === 'ferry' ? 'ferry' : request.mode === 'bus' ? 'bus' : request.mode === 'subway' ? 'subway' : 'rail';

  return (
    <>
    <SharedTripDetailView
      actionLabel={live ? 'End trip' : `Start ride to ${alight.name}`}
      backLabel="Back to route"
      // Where to get off is picked from the ride's own card: its last stop.
      endStopPicker={{
        legIndex: 0,
        choices: stopTimes.map(({ arrives, index, stop }) => ({ index, name: stop.name, time: formatTripClock(arrives), selected: index === alightIndex })),
        onPick: setAlightIndex,
      }}
      beforeSteps={following ? <>{following.adminPanel}<ActiveTripNotices hurry={following.hurry} reportRoute={following.currentRoute} reportTripId={reportTripId} ride={following.ride} rideFix={following.rideFix} /></> : undefined}
      interactiveMap={true}
      isFavorite={false}
      locationSelected={following ? follow.following : centered}
      map={(
        <TripMap
          approachLines={approachLines}
          centerOnUserRequest={following ? follow.centerRequest : centerRequest}
          focusStop={focusStop}
          {...(following ? {
            followLocation: following.followLocation,
            followUser: follow.following,
            navigationProgress: following.progress,
            onFollowModeChange: follow.setFollowing,
            userLocationStale: following.userLocationStale,
          } : {})}
          interactive={true}
          itinerary={itinerary}
          onUserPan={() => (following ? follow.setFollowing(false) : setCentered(false))}
          onVehiclePress={setVehicleId}
          padding={tripDetailMapPadding(insets.top, false)}
          testID="ride-guide-map"
          userLocation={userLocation}
          vehicles={shownVehicles}
        />
      )}
      model={model}
      onAction={live ? onEnd : () => onStart(itinerary, alight.name)}
      onBack={onBack}
      onCenterOnLocation={() => {
        if (following) {
          follow.resume();
          return;
        }
        setCenterRequest((count) => count + 1);
        setCentered(true);
      }}
      onFocusStop={(stop) => {
        if (following) follow.setFollowing(false);
        setFocusStop((current) => ({ point: stop.point, key: (current?.key ?? 0) + 1 }));
      }}
      onSelectDeparture={(legIndex, departs) => setChoices((current) => new Map(current).set(legIndex, departs))}
      onToggleFavorite={() => undefined}
      rootTestID={`ride-guide-${request.routeId}`}
      showFavorite={false}
      showServiceAlerts={false}
      testPrefix="ride-guide"
    />
    <VehicleSheet
      color={request.color}
      destination={request.headsign}
      lineName={request.shortName}
      mode={vehicleMode}
      onClaim={() => undefined}
      onClose={() => setVehicleId(null)}
      onDismiss={() => undefined}
      ridingTripId={null}
      sharingEnabled={false}
      stops={request.stops}
      vehicle={vehicle}
    />
    </>
  );
}

