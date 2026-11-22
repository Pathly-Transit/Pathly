import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { themedRouteColor } from '../data/routeColors';
import { withAlpha } from '../data/routeDirection';
import { stopIndexAt, tripMapPoints, ENTRANCE_REVEAL_ZOOM, viaRevealZooms, type TripMapProps, type TripMapStop } from '../data/tripMap';
import { zoomForRegion } from '../data/stopDeclutter';
import { MapCanvas, MapCircles, MapMarker, MapPolyline } from '../map/MapCanvas';
import { mapLandColor } from '../map/mapStyle';
import { fadedOver, type MapCameraChange, type MapCanvasRef, type MapCircle, type MapPoint } from '../map/mapTypes';
import { useAppSettings, useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { fontFamilies } from '../theme/typography';
import { CurrentLocationMarker } from './CurrentLocationMarker';
import { DestinationPinMarker } from './DestinationPinMarker';
import { HeadingBeamMarker } from './HeadingBeamMarker';
import { Icon } from './Icon';
import { SavedPlaceMarkers } from './SavedPlaceMarkers';
import { LiveVehicleMarker } from './RouteMap';

const FIT_PADDING = { top: 90, right: 40, bottom: 60, left: 40 };
const TRANSIT_WIDTH = 6;
const CURRENT_WIDTH = 8;
const COMPLETED_WIDTH = 4;
const COMPLETED_OPACITY = 0.5;
const APPROACH_ALPHA = 0.35;
// Walks are plain round gray dots, wide enough to read from far out.
const WALK_WIDTH = 6;
// The trip's start and destination: big light-gray dots with a darker gray ring, easy to spot zoomed out.
const ENDPOINT_FILL = '#D5D9DE';
const ENDPOINT_RING = '#80868B';
const FOCUS_ZOOM = 15;
const FOCUS_DURATION_MS = 350;
/** Where the map waits, before a trip is known, over the region. */
const FALLBACK_CAMERA = { center: { latitude: 40.75, longitude: -73.95 }, zoom: 11 };
/** The destination pin's tip sits this far above the destination dot's center: on its top edge. */
const PIN_TIP_ABOVE_DOT = 8;

type ProgressState = 'completed' | 'current' | 'upcoming';

const toPoint = (point: { lat: number; lng: number }): MapPoint => ({ latitude: point.lat, longitude: point.lng });

/**
 * The camera center that puts `point` in the middle of the map's uncovered part (`shiftX`/`shiftY`
 * px off the full map's middle, toward the larger padding) at FOCUS_ZOOM. Centered on the point
 * itself, it would sit under the results sheet, below what's visible.
 */
function centerInView(point: MapPoint, shiftX: number, shiftY: number): MapPoint {
  const degreesPerPixel = 360 / (256 * 2 ** FOCUS_ZOOM);
  return {
    latitude: point.latitude - shiftY * degreesPerPixel * Math.cos((point.latitude * Math.PI) / 180),
    longitude: point.longitude + shiftX * degreesPerPixel,
  };
}

/**
 * A planned trip on a real map: each leg in its line's color, walking dotted, a marker at every
 * stop. Interactive maps pan and zoom, label a tapped stop, and offer to re-frame the whole trip.
 */
export function TripMap({ centerOnUserRequest = 0, destination, focusStop, followLocation, followUser, holdCamera, interactive = false, itinerary, navigationProgress, onFollowModeChange, onUserCameraChange, onUserPan, onVehiclePress, origin, padding = FIT_PADDING, testID = 'trip-map', userLocation, userLocationStale = false, vehicles = [], approachLines = [] }: TripMapProps) {
  const mapRef = useRef<MapCanvasRef>(null);
  // A held camera is where the rider had left this map; it opens there instead of on the trip.
  const holding = holdCamera != null;
  const [initialCamera] = useState(() => (holdCamera
    ? { center: { latitude: holdCamera.latitude, longitude: holdCamera.longitude }, zoom: holdCamera.zoom ?? (holdCamera.longitudeDelta ? zoomForRegion(holdCamera.longitudeDelta, 390) : FALLBACK_CAMERA.zoom) }
    : FALLBACK_CAMERA));
  // Set once the rider moves the map (a held camera was theirs too), so automatic framing isn't reported.
  const userMovedCamera = useRef(holding);
  const styles = useThemedStyles(createStyles);
  const { colors, isDark, mapTheme } = useTheme();
  const land = mapLandColor(isDark, mapTheme);
  const { destinationPin } = useAppSettings();
  const trip = useMemo(() => tripMapPoints(itinerary, origin, destination), [destination, itinerary, origin]);
  const legs = navigationProgress?.segments ?? trip.legs;
  const progressStops = navigationProgress?.stops;
  const stops = useMemo(() => progressStops ? [...progressStops.filter((stop) => stop.visible), ...trip.stops.filter((stop) => stop.kind === 'entrance')] : trip.stops, [progressStops, trip.stops]);
  const destinationStop = stops.find((stop) => stop.kind === 'end');
  const bounds = trip.bounds;
  const coordinates = useMemo(() => bounds.map(toPoint), [bounds]);
  const coordinatesKey = useMemo(() => coordinates.map((point) => `${point.latitude},${point.longitude}`).join(';'), [coordinates]);
  const hasNavigationProgress = navigationProgress != null;
  const [selected, setSelected] = useState<number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [internalFollow, setInternalFollow] = useState(() => navigationProgress != null);
  const following = followUser ?? internalFollow;
  const setFollowing = useCallback((next: boolean) => {
    if (followUser === undefined) setInternalFollow(next);
    onFollowModeChange?.(next);
  }, [followUser, onFollowModeChange]);
  // Stops passed in between are drawn only once they're zoomed apart (stopDeclutter.ts).
  const [zoom, setZoom] = useState(initialCamera.zoom);
  const revealZooms = useMemo(() => viaRevealZooms(stops), [stops]);
  const viaShown = (stop: TripMapStop) => zoom >= (revealZooms.get(stop.leg ?? -1) ?? 0);
  const entrancesShown = zoom >= ENTRANCE_REVEAL_ZOOM;

  const onCameraIdle = ({ center, zoom: restingZoom, userInteraction }: MapCameraChange) => {
    setZoom(restingZoom);
    if (interactive && userInteraction) userMovedCamera.current = true;
    if (userMovedCamera.current) onUserCameraChange?.({ latitude: center.latitude, longitude: center.longitude, zoom: restingZoom });
  };

  const frame = useCallback(() => {
    if (coordinates.length > 0) mapRef.current?.fitPoints(coordinates, { padding, durationMs: 0 });
    // `coordinates` and `padding` intentionally key this callback by their scalar contents below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinatesKey, padding.top, padding.right, padding.bottom, padding.left]);

  const cameraLocation = followLocation === undefined ? userLocation : followLocation;
  const userLatitude = cameraLocation?.lat;
  const userLongitude = cameraLocation?.lng;
  const followLatitude = navigationProgress?.followTarget?.lat;
  const followLongitude = navigationProgress?.followTarget?.lng;
  const shiftX = (padding.right - padding.left) / 2;
  const shiftY = (padding.bottom - padding.top) / 2;
  const inView = useCallback((point: MapPoint) => centerInView(point, shiftX, shiftY), [shiftX, shiftY]);
  const followCamera = useCallback((animated: boolean) => {
    if (userLatitude === undefined || userLongitude === undefined) return;
    const rider = { latitude: userLatitude, longitude: userLongitude };
    if (followLatitude !== undefined && followLongitude !== undefined
      && (followLatitude !== userLatitude || followLongitude !== userLongitude)) {
      mapRef.current?.fitPoints(
        [rider, { latitude: followLatitude, longitude: followLongitude }],
        {
          padding: {
            top: Math.max(padding.top, 120),
            right: Math.max(padding.right, 56),
            bottom: Math.max(padding.bottom, 180),
            left: Math.max(padding.left, 56),
          },
          durationMs: animated ? FOCUS_DURATION_MS : 0,
        },
      );
      return;
    }
    mapRef.current?.easeTo({ center: inView(rider), zoom: FOCUS_ZOOM, durationMs: animated ? FOCUS_DURATION_MS : 0 });
  }, [followLatitude, followLongitude, inView, padding.bottom, padding.left, padding.right, padding.top, userLatitude, userLongitude]);

  // Frames the whole trip (or both endpoints while it loads) whenever it changes, unless the
  // camera is held where the rider left it; releasing the hold frames the trip again.
  const frameKey = `${itinerary?.id ?? ''}:${coordinatesKey}`;
  useEffect(() => {
    if (!mapReady || holding) return;
    // Follow mode cannot drive a camera until a trustworthy rider fix exists. Frame the planned
    // route in that interim instead of leaving the map where it opened.
    if (hasNavigationProgress && userLatitude !== undefined && userLongitude !== undefined) return;
    frame();
  }, [frame, frameKey, hasNavigationProgress, holding, mapReady, userLatitude, userLongitude]);

  // In active navigation, accepted location changes keep the rider and immediate next route
  // target in view. Panning/zooming turns this off until the locate action resumes it.
  useEffect(() => {
    if (!mapReady || !hasNavigationProgress || !following || userLatitude === undefined || userLongitude === undefined) return;
    followCamera(true);
  }, [followCamera, following, hasNavigationProgress, mapReady, userLatitude, userLongitude]);

  // A stop picked from the trip's stop list: centered and labeled.
  const [handledFocusKey, setHandledFocusKey] = useState(focusStop?.key);
  if (focusStop && focusStop.key !== handledFocusKey) {
    setHandledFocusKey(focusStop.key);
    setSelected(stopIndexAt(stops, focusStop.point));
  }
  useEffect(() => {
    if (!focusStop || !mapReady) return;
    mapRef.current?.easeTo({ center: inView(toPoint(focusStop.point)), zoom: FOCUS_ZOOM, durationMs: FOCUS_DURATION_MS });
  }, [focusStop, inView, mapReady]);

  // The location button: centered on the rider, with the re-frame button offered to come back.
  const [handledCenterRequest, setHandledCenterRequest] = useState(centerOnUserRequest);
  if (centerOnUserRequest !== handledCenterRequest) {
    setHandledCenterRequest(centerOnUserRequest);
    if (navigationProgress && followUser === undefined) setInternalFollow(true);
  }
  const centerRequestForEffect = useRef(centerOnUserRequest);
  useEffect(() => {
    if (centerOnUserRequest === centerRequestForEffect.current) return;
    centerRequestForEffect.current = centerOnUserRequest;
    if (navigationProgress) onFollowModeChange?.(true);
    if (!userLocation) return;
    userMovedCamera.current = true;
    if (navigationProgress && userLatitude !== undefined && userLongitude !== undefined) followCamera(true);
    else mapRef.current?.easeTo({ center: inView(toPoint(userLocation)), zoom: Math.max(zoom, FOCUS_ZOOM), durationMs: FOCUS_DURATION_MS });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request; the zoom is read then
  }, [centerOnUserRequest, followCamera, inView, navigationProgress, onFollowModeChange, userLatitude, userLocation, userLongitude]);

  const selectedStop = selected !== null ? stops[selected] : undefined;

  // Stops as dots on the map itself; a subway entrance (a square with an arrow) is a marker.
  const circles = useMemo(() => stops.flatMap((stop, index): MapCircle[] => {
    if (stop.kind === 'entrance') return [];
    if (stop.kind === 'via' && !viaShown(stop) && index !== selected) return [];
    const completed = 'state' in stop && (stop as { state?: ProgressState }).state === 'completed';
    const lineColor = themedRouteColor(stop.color ?? colors.primary, isDark);
    const base = { key: String(index), coordinate: toPoint(stop.point), testID: `trip-map-${stop.kind}-${index}` };
    if (stop.kind === 'start' || stop.kind === 'end') {
      // A passed endpoint fades like the line behind the rider, in solid colors (see-through ones stack darker over the line).
      return [{ ...base, radius: 9, color: completed ? fadedOver(ENDPOINT_FILL, land, COMPLETED_OPACITY) : ENDPOINT_FILL, strokeColor: completed ? fadedOver(ENDPOINT_RING, land, COMPLETED_OPACITY) : ENDPOINT_RING, strokeWidth: 3, sortKey: 4 }];
    }
    const via = stop.kind === 'via';
    return [{
      ...base,
      radius: via ? 4.5 : 7,
      color: completed ? fadedOver(colors.white, land, COMPLETED_OPACITY) : colors.white,
      // A stop already passed is ringed in the faded gray of the line behind the rider: one solid
      // color, since a see-through ring over the see-through line would stack darker.
      strokeColor: completed ? fadedOver(colors.mutedInk, land, COMPLETED_OPACITY) : lineColor,
      strokeWidth: via ? 2 : 3,
      sortKey: via ? 2 : 3,
    }];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- viaShown reads zoom and revealZooms
  }), [colors.mutedInk, colors.primary, colors.white, isDark, land, revealZooms, selected, stops, zoom]);
  const entrances = stops.flatMap((stop, index) => (stop.kind === 'entrance' && (entrancesShown || index === selected) ? [{ stop, index }] : []));

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapCanvas
        initialCamera={initialCamera}
        interactive={interactive}
        onCameraIdle={onCameraIdle}
        // Tapping the map (not a stop) dismisses a stop's label.
        onPress={interactive ? () => setSelected(null) : undefined}
        onReady={() => setMapReady(true)}
        onUserGesture={interactive ? () => {
          userMovedCamera.current = true;
          setFollowing(false);
          onUserPan?.();
        } : undefined}
        pitchEnabled={false}
        ref={mapRef}
        rotateEnabled={false}
        testID={testID}
      >
        {/* A ride's line before the rider boards is faint, like Route View's line behind the rider's stop. */}
        {approachLines.map((line) => (
          <MapPolyline
            color={withAlpha(themedRouteColor(line.color, isDark), APPROACH_ALPHA)}
            coordinates={line.path.map(toPoint)}
            id={`trip-approach-${line.key}`}
            key={`approach-${line.key}`}
            testID={`trip-map-approach-${line.key}`}
            width={TRANSIT_WIDTH}
            zIndex={0}
          />
        ))}
        {legs.map((leg, index) => {
          const progressState = 'state' in leg ? leg.state as ProgressState : undefined;
          const completed = progressState === 'completed';
          const current = progressState === 'current';
          return (
            <MapPolyline
              color={completed || leg.walk ? colors.mutedInk : themedRouteColor(leg.color ?? colors.primary, isDark)}
              coordinates={leg.path.map(toPoint)}
              dotted={leg.walk}
              id={`trip-leg-${index}-${leg.walk ? 'walk' : 'ride'}`}
              // Redrawn when a piece turns from walk to ride (a moved trip re-splits its route).
              key={`leg-${index}-${leg.walk ? 'walk' : 'ride'}`}
              opacity={completed ? COMPLETED_OPACITY : 1}
              testID={progressState ? `${testID}-progress-${progressState}-${index}` : leg.walk ? `trip-map-walk-${index}` : `trip-map-transit-${index}`}
              width={completed ? COMPLETED_WIDTH : current ? CURRENT_WIDTH : leg.walk ? WALK_WIDTH : TRANSIT_WIDTH}
              zIndex={current ? 3 : leg.walk ? 1 : 2}
            />
          );
        })}
        <MapCircles
          circles={circles}
          id="trip-stops"
          onPress={interactive ? (key) => setSelected(Number(key)) : undefined}
          testID="trip-map-stops"
          zIndex={4}
        />
        {/* The rider's saved places, under the trip's own markers. */}
        <SavedPlaceMarkers zIndex={0} zoom={zoom} />
        {entrances.map(({ stop, index }) => (
          // A square in the line's color with a white arrow, for a station's way in or out.
          <MapMarker coordinate={toPoint(stop.point)} key={`entrance-${index}`} onPress={interactive ? () => setSelected(index) : undefined} testID={`trip-map-entrance-${index}`} zIndex={2}>
            <View style={[styles.entranceDot, { backgroundColor: themedRouteColor(stop.color ?? colors.primary, isDark) }]}>
              <Icon color="#FFFFFF" name="arrowRight" size={11} />
            </View>
          </MapMarker>
        ))}
        {/* The rides' live vehicles, like Route View's. */}
        {vehicles.map((vehicle) => <LiveVehicleMarker key={`${vehicle.mode}-${vehicle.tripId}`} color={themedRouteColor(vehicle.color, isDark)} mode={vehicle.mode} onPress={onVehiclePress} vehicle={vehicle} zIndex={3} />)}
        {selectedStop?.label ? (
          // A themed label above the stop.
          <MapMarker anchor="bottom" coordinate={toPoint(selectedStop.point)} offset={[0, -14]} testID="trip-map-stop-label" zIndex={4}>
            <View style={styles.label}><Text numberOfLines={1} style={styles.labelText}>{selectedStop.label}</Text></View>
          </MapMarker>
        ) : null}
        {/* The rider's pin (Settings, Appearance) stands on the destination's gray dot, so it reads apart from the start. */}
        {destinationStop ? (
          <MapMarker
            anchor="bottom"
            coordinate={toPoint(destinationStop.point)}
            key={`destination-${destinationPin.color}-${destinationPin.eyes ?? 'pathling'}-${destinationPin.mouth ?? 'pathling'}`}
            offset={[0, -PIN_TIP_ABOVE_DOT]}
            testID="trip-map-destination-pin"
            zIndex={5}
          >
            <View pointerEvents="none"><DestinationPinMarker /></View>
          </MapMarker>
        ) : null}
        {userLocation ? <HeadingBeamMarker coordinate={toPoint(userLocation)} /> : null}
        {userLocation ? (
          <MapMarker coordinate={toPoint(userLocation)} testID={`${testID}-user-location`} zIndex={6}>
            <View pointerEvents="none" style={userLocationStale ? styles.staleLocation : undefined} testID={`${testID}-user-location-visual`}>
              <CurrentLocationMarker />
            </View>
          </MapMarker>
        ) : null}
      </MapCanvas>
    </View>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  entranceDot: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#FFFFFF', borderRadius: 3 },
  label: { maxWidth: 240, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, backgroundColor: colors.surface, shadowColor: colors.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 4 },
  labelText: { color: colors.ink, fontFamily: fontFamilies.bold, fontSize: 13 },
  staleLocation: { opacity: 0.45 },
});
