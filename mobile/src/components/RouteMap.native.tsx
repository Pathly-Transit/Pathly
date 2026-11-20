import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import MapView, { Callout, Marker, Polyline, type Region } from 'react-native-maps';

import { BeanAvatar } from '../avatars/BeanAvatarImage';
import { formatAge, visibleTrains } from '../data/liveTrains';
import { googleMapStyle } from '../data/mapStyle';
import { entranceLabel, type StationEntrance } from '../data/stationEntrances';
import { approachingVehicle, ARROW_ZOOM_SLACK, directionArrowAt, focusStopIndex, metersPerPixel, middleDirectionArrowAt, MIN_FIT_SPAN, riderNearStop, snapStopsToPath, splitPathAtStop, streetWalkToDraw, walkConnectors, withAlpha } from '../data/routeDirection';
import { stopRevealZoom, zoomForRegion } from '../data/stopDeclutter';
import type { RouteLiveVehicle } from '../data/transitLive';
import type { Coordinates } from '../hooks/useCurrentLocation';
import { useMarkerTracking } from '../hooks/useMarkerTracking';
import { useNow } from '../hooks/useNow';
import { SELECTED_SCALE, useSelectionScale } from '../hooks/useSelectionScale';
import { useTheme } from '../theme/AppSettings';
import { fontFamilies } from '../theme/typography';
import { Icon } from './Icon';
import { NATIVE_MAP_PROVIDER } from './mapProvider';
import type { TransitMode } from './RouteBadge';
import { CurrentLocationMarker } from './CurrentLocationMarker';
import { HeadingBeamMarker } from './HeadingBeamMarker';
import { useGlide } from '../hooks/useGlide';
import { DirectionArrow } from './DirectionArrow';
import type { VehicleScreenPoint } from './SelectedVehicleOverlay';

type GeometryStop = { stopId?: string; name: string; lat: number; lon: number; entrances?: readonly StationEntrance[] };

const CENTER_ANCHOR = { x: 0.5, y: 0.5 };
// Street-level span around a focused stop or the rider.
const FOCUS_DELTA = { latitudeDelta: 0.06, longitudeDelta: 0.06 };
const FOCUS_ANIMATION_MS = 400;
const ROUTE_FIT_PADDING = { top: 90, right: 40, bottom: 60, left: 40 };

type LatLngPoint = { latitude: number; longitude: number };

/** `points`, plus two corners around their middle when they're closer together than MIN_FIT_SPAN. */
function withMinimumSpan(points: readonly LatLngPoint[]): LatLngPoint[] {
  const lats = points.map((point) => point.latitude);
  const lons = points.map((point) => point.longitude);
  const [minLat, maxLat, minLon, maxLon] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  if (maxLat - minLat >= MIN_FIT_SPAN || maxLon - minLon >= MIN_FIT_SPAN) return [...points];
  const [lat, lon, half] = [(minLat + maxLat) / 2, (minLon + maxLon) / 2, MIN_FIT_SPAN / 2];
  return [...points, { latitude: lat - half, longitude: lon - half }, { latitude: lat + half, longitude: lon + half }];
}
// The line behind the rider's stop (already travelled in this direction) is drawn faint.
const BEHIND_LINE_ALPHA = 0.35;
// Stop dots are exactly as wide as the line, so they sit inside it like beads instead of
// bulging out of it. Only the rider's own stop is drawn larger, so it stands out.
const LINE_WIDTH = 8;
// The walk to the stop, matching TripMap.native.tsx's walking legs.
// Walks are plain round gray dots, which read from far out over any street.
const WALK_WIDTH = 6;
const WALK_DASH = [1, 10];
// The joins from the walk to the rider's and stop's dots: smaller dots, closer together.
const CONNECTOR_WIDTH = 3;
const CONNECTOR_DASH = [1, 6];
const STOP_RING = 1.5;

// Vehicle marker geometry: the circle sits bottom-left of a larger box so the age badge can
// overhang its top-right corner (Android clips marker views to their own bounds).
const VEHICLE_SIZE = 42;
const VEHICLE_BOX = 54;
// Room around the circle's left and bottom for its shadow, which the marker's bounds would clip.
const SHADOW_ROOM = 6;
const VEHICLE_BOX_HEIGHT = VEHICLE_BOX + SHADOW_ROOM;
/**
 * The soft shadow under the circle, like the web's: Android leaves real shadows out of marker
 * pictures, so there it's painted as rings fading out, a little below the circle.
 */
const PAINTED_SHADOW = Platform.OS === 'android'
  ? [{ grow: 6, opacity: 0.05 }, { grow: 4, opacity: 0.07 }, { grow: 2, opacity: 0.1 }, { grow: 0, opacity: 0.14 }]
  : [];
const SHADOW_DROP = 2;
// Riders' avatars replace the age badge, stacked; the box widens so Android doesn't clip them.
const RIDER_AVATAR = 24;
const RIDER_AVATAR_STEP = 13;
const RIDER_AVATAR_LEFT = 30;
const RIDER_DISC_INSET = 2;
// The tapped vehicle, while its popup is open: this much larger, and above every marker.
const SELECTED_PAD = 16;
const SELECTED_Z_INDEX = 10;

type RouteMapProps = {
  /** Incremented by the location button; each change centers the map on `userLocation` and follows it until a pan. */
  centerOnUserRequest?: number;
  /** Incremented by the route-overview button; each change fits the map to the whole line. */
  showRouteRequest?: number;
  color: string;
  /** GTFS direction_id to show vehicles for; all directions when omitted. */
  directionId?: number;
  /** Stop to open zoomed on and emphasize (the rider's nearest), matched by stopId. */
  focusStopId?: string;
  /** A station whose entrances to mark and zoom to, from its stop row; `key` repeats the request. */
  entranceFocus?: { stopId: string; key: number };
  /** Matches the rider's stop by name when its id isn't in `stops` (see focusStopIndex). */
  focusStopName?: string;
  /** Vehicle glyph and label (train vs bus). */
  mode?: TransitMode;
  /** Tapping a live vehicle opens its details. */
  onVehiclePress?: (tripId: string) => void;
  onSelectedVehiclePosition?: (point: VehicleScreenPoint | null) => void;
  /** The vehicle whose popup is open: drawn larger, above every other vehicle. */
  selectedVehicleId?: string | null;
  /** Tapping a stop's name (shown once its dot is tapped) opens the line at that stop. */
  onOpenStop?: (stop: GeometryStop) => void;
  /** Called when the rider drags the map, so the location button can drop its selected state. */
  onUserPan?: () => void;
  /** Detailed track geometry when known (e.g. GTFS shapes); otherwise the line joins the stops. */
  path?: readonly { lat: number; lon: number }[];
  stops: readonly GeometryStop[];
  testID?: string;
  /** Rider's real location; omitted while only the fallback is known. */
  userLocation?: Coordinates;
  /**
   * The home map's purple explore dot, when the rider was exploring from it: drawn beside the
   * rider's own dot, and framed with the stop and vehicle in its place (the walk starts there).
   * The location button still goes to the rider.
   */
  exploreFrom?: Coordinates;
  /** Room (pt) to keep around framed points, clear of the controls drawn over the map. */
  fitPadding?: { top: number; right: number; bottom: number; left: number };
  vehicles: readonly RouteLiveVehicle[];
  /** The walk along the streets from the rider to the focused stop, drawn dotted (as on the trip map). */
  walkPath?: readonly { lat: number; lon: number }[];
};

/** Centers/zooms to fit every stop, with some breathing room around the edges. */
function regionForStops(stops: readonly GeometryStop[]): Region {
  const lats = stops.map((stop) => stop.lat);
  const lons = stops.map((stop) => stop.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.3, 0.05),
    longitudeDelta: Math.max((maxLon - minLon) * 1.3, 0.05),
  };
}

function regionFor(stops: readonly GeometryStop[], focusStop: GeometryStop | undefined): Region {
  return focusStop ? { latitude: focusStop.lat, longitude: focusStop.lon, ...FOCUS_DELTA } : regionForStops(stops);
}

/**
 * A live vehicle (Route View and the trip map): a white circle with the line's mode glyph and its
 * position's age, gliding to each refreshed spot rather than jumping there.
 */
export function LiveVehicleMarker({ color, mode, onPress, onPosition, project, projectionRevision, selected = false, vehicle, zIndex }: {
  color: string;
  mode: TransitMode;
  onPress?: (tripId: string) => void;
  onPosition?: RouteMapProps['onSelectedVehiclePosition'];
  project?: (coordinate: LatLngPoint) => Promise<{ x: number; y: number } | null>;
  projectionRevision?: number;
  selected?: boolean;
  vehicle: RouteLiveVehicle;
  zIndex: number;
}) {
  const { lat, lon } = useGlide(vehicle);
  const { tripId } = vehicle;
  const projection = useRef({ selection: 0, requested: 0, reported: 0 });
  useEffect(() => {
    const updates = projection.current;
    return () => {
      updates.selection += 1;
      onPosition?.(null);
    };
  }, [onPosition]);
  useEffect(() => {
    if (!onPosition || !project) return;
    const updates = projection.current;
    const selection = updates.selection;
    const request = ++updates.requested;
    void project({ latitude: lat, longitude: lon }).then((point) => {
      if (!point || updates.selection !== selection || request <= updates.reported) return;
      updates.reported = request;
      onPosition({ tripId, ...point });
    }).catch(() => {
      // A projection can fail before the map is ready. Layout and camera updates retry.
    });
  }, [lat, lon, onPosition, project, projectionRevision, tripId]);

  const avatars = vehicle.riders?.avatars ?? [];
  // The position's age ("12s") ticks each second.
  const now = useNow(1000);
  const age = vehicle.updatedAt != null ? formatAge(now - vehicle.updatedAt) : '';
  // 0 plain, 1 while its popup is open, easing between (useSelectionScale).
  const selection = useSelectionScale(selected);
  // Re-pictured only when its drawing changes: the ticking age, its color, its riders or being picked.
  const tracksView = useMarkerTracking(`${color}|${mode}|${age}|${JSON.stringify(avatars)}|${selected}`);
  const boxWidth = SHADOW_ROOM + (avatars.length > 0 ? RIDER_AVATAR_LEFT + RIDER_AVATAR + (avatars.length - 1) * RIDER_AVATAR_STEP : VEHICLE_BOX);
  // Picked (or shrinking back), the box gains room on every side for the larger drawing, since
  // Android clips a marker to its view's bounds. Plain markers keep their tap area.
  const pad = selected || selection > 0 ? SELECTED_PAD : 0;
  const circleX = SHADOW_ROOM + VEHICLE_SIZE / 2;
  const circleY = VEHICLE_BOX_HEIGHT - SHADOW_ROOM - VEHICLE_SIZE / 2;
  // Anchored on the circle's center.
  const anchor = { x: (pad + circleX) / (boxWidth + pad * 2), y: (pad + circleY) / (VEHICLE_BOX_HEIGHT + pad * 2) };
  const scale = 1 + (SELECTED_SCALE - 1) * selection;
  // Grows about the circle's center, not the box's.
  const shiftX = circleX - boxWidth / 2;
  const shiftY = circleY - VEHICLE_BOX_HEIGHT / 2;
  return (
      <Marker anchor={anchor} coordinate={{ latitude: lat, longitude: lon }} onPress={onPress ? () => onPress(tripId) : undefined} testID={`route-vehicle-${tripId}`} title={onPress ? undefined : mode === 'bus' ? 'Bus' : 'Train'} tracksViewChanges={tracksView} zIndex={selected || selection > 0 ? SELECTED_Z_INDEX : zIndex}>
        <View style={{ width: boxWidth + pad * 2, height: VEHICLE_BOX_HEIGHT + pad * 2 }}>
        <View style={[styles.vehicleBox, { width: boxWidth, left: pad, top: pad }, selection !== 0 && { transform: [{ translateX: shiftX }, { translateY: shiftY }, { scale }, { translateX: -shiftX }, { translateY: -shiftY }] }]} testID={`route-vehicle-drawing-${vehicle.tripId}`}>
          {PAINTED_SHADOW.map(({ grow, opacity }) => (
            <View
              key={grow}
              style={[styles.paintedShadow, {
                left: SHADOW_ROOM - grow / 2,
                bottom: SHADOW_ROOM - SHADOW_DROP - grow / 2,
                width: VEHICLE_SIZE + grow,
                height: VEHICLE_SIZE + grow,
                borderRadius: (VEHICLE_SIZE + grow) / 2,
                backgroundColor: `rgba(22, 50, 79, ${opacity})`,
              }]}
            />
          ))}
          <View style={styles.vehicleBadge} testID={`route-vehicle-badge-${vehicle.tripId}`}>
            <Icon color={color} name={mode === 'bus' ? 'bus' : mode === 'subway' ? 'subway' : mode === 'ferry' ? 'ferry' : 'rail'} size={22} />
          </View>
          {avatars.length > 0 ? avatars.map((avatar, index) => (
            // The first (the rider's own) on top; the white disc keeps each apart from its neighbor.
            <View key={index} style={[styles.riderAvatar, { left: SHADOW_ROOM + RIDER_AVATAR_LEFT + index * RIDER_AVATAR_STEP, zIndex: avatars.length - index }]}>
              <BeanAvatar config={avatar} size={RIDER_AVATAR - RIDER_DISC_INSET * 2} testID={`route-vehicle-rider-${vehicle.tripId}-${index}`} />
            </View>
          )) : vehicle.updatedAt != null ? (
            <View style={[styles.ageBadge, { backgroundColor: color }]} testID={`route-vehicle-age-badge-${vehicle.tripId}`}>
              <Text style={styles.ageText} testID={`route-vehicle-age-${vehicle.tripId}`}>{age}</Text>
            </View>
          ) : null}
        </View>
        </View>
      </Marker>
  );
}

/** Real route map: actual stop positions, the real line, and live vehicles — for any route with a live feed. */
export function RouteMap({ centerOnUserRequest = 0, color, directionId, entranceFocus, exploreFrom, fitPadding = ROUTE_FIT_PADDING, focusStopId, focusStopName, mode = 'rail', onOpenStop, onSelectedVehiclePosition, onUserPan, onVehiclePress, path, selectedVehicleId = null, showRouteRequest = 0, stops, testID = 'route-map', userLocation, vehicles, walkPath }: RouteMapProps) {
  const mapRef = useRef<MapView>(null);
  const mapContainer = useRef<ComponentRef<typeof View>>(null);
  const [projectionRevision, setProjectionRevision] = useState(0);
  const projectVehicle = useCallback(async (coordinate: LatLngPoint) => {
    const map = mapRef.current;
    const container = mapContainer.current;
    if (!map || !container) return null;
    const point = await map.pointForCoordinate(coordinate);
    return new Promise<{ x: number; y: number }>((resolve) => {
      container.measureInWindow((x, y) => resolve({ x: x + point.x, y: y + point.y }));
    });
  }, []);
  const refreshProjection = selectedVehicleId && onSelectedVehiclePosition
    ? () => setProjectionRevision((revision) => revision + 1)
    : undefined;
  // Where the walk starts: the purple dot when exploring, else the rider.
  const walkOrigin = exploreFrom ?? userLocation;
  // Places hidden, and recolored in the dark theme (see mapStyle.ts).
  const { colors, isDark } = useTheme();
  // The rider's and explore dots are redrawn only when the theme changes (see useMarkerTracking).
  const tracksDots = useMarkerTracking(isDark ? 'dark' : 'light');
  const mapStyle = useMemo(() => googleMapStyle(isDark), [isDark]);
  const riderMovedMap = useRef(false);
  // True from a location-button press until the rider pans (or asks for the whole route): keeps
  // following fresh GPS fixes.
  const followRider = useRef(false);
  const focusStop = stops[focusStopIndex(stops, focusStopId, focusStopName)];
  const [initialRegion] = useState(() => regionFor(stops, focusStop));
  // Custom-view stop markers must render at least once with tracking on (Android otherwise can
  // draw them blank), then stop tracking so static dots aren't re-rasterized every frame.
  const [tracksStopViews, setTracksStopViews] = useState(true);
  // Stop dots are drawn only once they're zoomed apart (stopDeclutter.ts); the rider's stop always is.
  const [mapWidth, setMapWidth] = useState(0);
  // Before the map's own layout arrives, the window's width stands in.
  const { width: windowWidth } = useWindowDimensions();
  const [zoom, setZoom] = useState(() => zoomForRegion(initialRegion.longitudeDelta, windowWidth));
  const revealZoom = useMemo(() => stopRevealZoom(stops.map((stop) => ({ lat: stop.lat, lng: stop.lon }))), [stops]);
  const dotsShown = zoom >= revealZoom;
  // Dots shown again are new markers: they render once with tracking on, like on first load.
  const [trackedDotsShown, setTrackedDotsShown] = useState(dotsShown);
  if (dotsShown !== trackedDotsShown) {
    setTrackedDotsShown(dotsShown);
    if (dotsShown) setTracksStopViews(true);
  }
  useEffect(() => {
    if (!tracksStopViews || !dotsShown) return undefined;
    const timer = setTimeout(() => setTracksStopViews(false), 500);
    return () => clearTimeout(timer);
  }, [dotsShown, tracksStopViews]);
  // Only for dropping vehicles not heard from in 5 minutes; each marker ticks its own age.
  const now = useNow(30_000);
  // The arrow's drawing only needs snapshotting once (and again when the line's color changes).
  const [arrowDrawnIn, setArrowDrawnIn] = useState<string | null>(null);
  const tracksArrowView = arrowDrawnIn !== color;
  useEffect(() => {
    const timer = setTimeout(() => setArrowDrawnIn(color), 500);
    return () => clearTimeout(timer);
  }, [color]);
  const shownVehicles = visibleTrains(vehicles, directionId, now);
  // Dots sit on the drawn line, not at the stop's own (platform) coordinates beside it.
  const dotSpots = useMemo(() => snapStopsToPath(path, stops), [path, stops]);
  const focusDot = focusStop ? dotSpots[stops.indexOf(focusStop)] : undefined;
  // Split at the rider's stop: faint behind it, full strength ahead.
  const line = useMemo(() => {
    const points = path ?? stops;
    const toCoordinates = (part: readonly { lat: number; lon: number }[]) => part.map((point) => ({ latitude: point.lat, longitude: point.lon }));
    const focusIndex = focusStop ? stops.indexOf(focusStop) : -1;
    if (focusIndex < 0) return { behind: [], ahead: toCoordinates(points), aheadPoints: [], behindPoints: [], wholePoints: points };
    const { behind, ahead } = splitPathAtStop(points, stops, focusIndex);
    return { behind: toCoordinates(behind), ahead: toCoordinates(ahead), aheadPoints: ahead, behindPoints: behind, wholePoints: null };
  }, [focusStop, path, stops]);
  // Placed once, for the zoom the map opens at, so zooming never moves it. Zoomed out well past that,
  // the line's bends would reach it, so it's hidden there instead.
  const [arrowZoom] = useState(() => zoom);
  const arrow = useMemo(() => {
    if (arrowZoom <= 0) return null;
    // A line looked up by name has no rider's stop: the arrow goes near the middle of the line, and
    // moves to the other direction's line when the rider switches.
    if (line.wholePoints) {
      const middle = line.wholePoints[Math.floor(line.wholePoints.length / 2)];
      return middle ? middleDirectionArrowAt(line.wholePoints, metersPerPixel(arrowZoom - ARROW_ZOOM_SLACK, middle.lat)) : null;
    }
    const start = line.aheadPoints[0];
    // The faint line behind the stop is drawn too, so the arrow keeps clear of it as well.
    return start ? directionArrowAt(line.aheadPoints, metersPerPixel(arrowZoom - ARROW_ZOOM_SLACK, start.lat), [line.behindPoints]) : null;
  }, [arrowZoom, line.aheadPoints, line.behindPoints, line.wholePoints]);

  // The rider, when they're near their stop: framed with it so they see the walk there.
  // The purple dot is always framed: its walk and stop are the point of the page.
  const nearRider = walkOrigin && focusStop && (exploreFrom != null || riderNearStop(walkOrigin, focusStop)) ? walkOrigin : null;
  // Thin dotted joins from the rider's dot and to the stop's dot, where the street walk stops short
  // of them (or straight between them with no walk), for a rider near enough to walk.
  // No street walk once the rider is at the stop: just the thin join between the dots.
  const streetWalk = useMemo(
    () => streetWalkToDraw(walkPath, walkOrigin ? { lat: walkOrigin.latitude, lon: walkOrigin.longitude } : null, focusStop),
    [focusStop, walkOrigin?.latitude, walkOrigin?.longitude, walkPath],
  );
  const connectors = useMemo(() => {
    const from = streetWalk ? walkOrigin : nearRider;
    if (!from) return [];
    return walkConnectors(streetWalk, { lat: from.latitude, lon: from.longitude }, focusDot)
      .map((join) => join.map((point) => ({ latitude: point.lat, longitude: point.lon })));
  }, [focusDot?.lat, focusDot?.lon, nearRider?.latitude, nearRider?.longitude, walkOrigin?.latitude, walkOrigin?.longitude, streetWalk]);
  // Set once the map has framed an approaching vehicle (below).
  const framedVehicle = useRef(false);
  // The nearest stop (and whether the rider is near it) often resolves after the page opens; follow
  // them until the rider pans. Keyed on near/far, not every GPS fix.
  useEffect(() => {
    if (!focusStop || riderMovedMap.current || framedVehicle.current) return;
    if (nearRider) {
      mapRef.current?.fitToCoordinates(withMinimumSpan([{ latitude: focusStop.lat, longitude: focusStop.lon }, nearRider]), { edgePadding: fitPadding, animated: true });
      return;
    }
    mapRef.current?.animateToRegion(regionFor(stops, focusStop), FOCUS_ANIMATION_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stop's identity and the rider being near
  }, [focusStop?.stopId, nearRider != null]);

  // Once a live vehicle shows up on its way to the rider's stop, the map glides out (once) to show
  // the stop and that vehicle (and the rider, when they're near the stop), unless the rider has
  // moved the map already.
  useEffect(() => {
    if (framedVehicle.current || riderMovedMap.current || !focusStop) return;
    const vehicle = approachingVehicle(line.behindPoints, shownVehicles);
    if (!vehicle) return;
    framedVehicle.current = true;
    mapRef.current?.fitToCoordinates(withMinimumSpan([
      { latitude: focusStop.lat, longitude: focusStop.lon },
      { latitude: vehicle.lat, longitude: vehicle.lon },
      ...(nearRider ? [nearRider] : []),
    ]), { edgePadding: fitPadding, animated: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-checked as vehicles report; the rest is read then
  }, [focusStop?.stopId, vehicles]);

  useEffect(() => {
    if (centerOnUserRequest === 0) return;
    followRider.current = true;
    riderMovedMap.current = true; // the nearest-stop focus must not pull the map back
  }, [centerOnUserRequest]);

  useEffect(() => {
    if (!followRider.current || !userLocation) return;
    mapRef.current?.animateToRegion({ ...userLocation, ...FOCUS_DELTA }, FOCUS_ANIMATION_MS);
  }, [centerOnUserRequest, userLocation]);

  // The route-overview button frames the whole line in this direction (every stop), clear of the
  // controls over the map's top and the page edge at its bottom.
  useEffect(() => {
    if (showRouteRequest === 0) return;
    followRider.current = false;
    riderMovedMap.current = true; // the nearest-stop focus must not pull the map back
    const points = (path ?? stops).map((point) => ({ latitude: point.lat, longitude: point.lon }));
    mapRef.current?.fitToCoordinates(points, { edgePadding: fitPadding, animated: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request only; the line is read at request time
  }, [showRouteRequest]);

  // A stop row's entrances: marked on the map, which zooms in to frame them with the station.
  const entranceStop = entranceFocus ? stops.find((stop) => stop.stopId === entranceFocus.stopId) : undefined;
  const entrances = entranceStop?.entrances ?? [];
  useEffect(() => {
    if (!entranceStop || entrances.length === 0) return;
    followRider.current = false;
    riderMovedMap.current = true; // the nearest-stop focus must not pull the map back
    const points = [entranceStop, ...entrances].map((point) => ({ latitude: point.lat, longitude: point.lon }));
    mapRef.current?.fitToCoordinates(points, { edgePadding: fitPadding, animated: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request; the stop is read then
  }, [entranceFocus?.key]);

  const map = (
    <MapView
      initialRegion={initialRegion}
      onLayout={(event: LayoutChangeEvent) => {
        setMapWidth(event.nativeEvent.layout.width);
        refreshProjection?.();
      }}
      onMapReady={() => {
        setTracksStopViews(false);
        refreshProjection?.();
      }}
      onPanDrag={() => {
        riderMovedMap.current = true;
        followRider.current = false;
        onUserPan?.();
      }}
      onRegionChange={refreshProjection}
      onRegionChangeComplete={(region: Region) => {
        setZoom(zoomForRegion(region.longitudeDelta, mapWidth || windowWidth));
        refreshProjection?.();
      }}
      customMapStyle={mapStyle}
      provider={NATIVE_MAP_PROVIDER}
      ref={mapRef}
      showsCompass={false}
      showsMyLocationButton={false}
      // Drawn from the app's own location below, so Google's layer doesn't track the phone a second time.
      showsUserLocation={false}
      style={StyleSheet.absoluteFill}
      testID={testID}
      toolbarEnabled={false}
      userInterfaceStyle={isDark ? 'dark' : 'light'}
    >
      {line.behind.length > 1 ? <Polyline coordinates={line.behind} strokeColor={withAlpha(color, BEHIND_LINE_ALPHA)} strokeWidth={LINE_WIDTH} testID="route-line-behind" zIndex={0} /> : null}
      <Polyline coordinates={line.ahead} strokeColor={color} strokeWidth={LINE_WIDTH} testID="route-line" zIndex={1} />
      {connectors.map((join, index) => (
        <Polyline
          key={`connector-${index}`}
          coordinates={join}
          lineCap="round"
          lineDashPattern={CONNECTOR_DASH}
          strokeColor={colors.mutedInk}
          strokeWidth={CONNECTOR_WIDTH}
          testID={`route-walk-connector-${index}`}
          zIndex={2}
        />
      ))}
      {streetWalk ? (
        // The walk to the stop, dotted like TripMap.native.tsx's walking legs.
        <>
          <Polyline
            coordinates={streetWalk.map((point) => ({ latitude: point.lat, longitude: point.lon }))}
            lineCap="round"
            lineDashPattern={WALK_DASH}
            strokeColor={colors.mutedInk}
            strokeWidth={WALK_WIDTH}
            testID="route-walk"
            zIndex={2}
          />
        </>
      ) : null}
      {stops.map((stop, stopIndex) => {
        const focused = stop === focusStop;
        if (!focused && !dotsShown) return null;
        // Stops behind the rider's stop in this direction fade with the line behind it.
        const passed = focusStop != null && stopIndex < stops.indexOf(focusStop);
        return (
          <Marker
            key={`${stop.stopId ?? stop.name}-${stopIndex}`}
            anchor={CENTER_ANCHOR}
            coordinate={{ latitude: dotSpots[stopIndex]?.lat ?? stop.lat, longitude: dotSpots[stopIndex]?.lon ?? stop.lon }}
            testID={`route-stop-${stop.name}`}
            // Names the marker for screen readers; the bubble shown is the Callout below.
            title={stop.name}
            tracksViewChanges={tracksStopViews}
            zIndex={focused ? 1 : 0}
          >
            <View style={[styles.stopDot, { borderColor: passed ? withAlpha(color, BEHIND_LINE_ALPHA) : color }, focused && [styles.focusedStopDot, { borderColor: color }]]} testID={`route-dot-${stop.name}`} />
            {/* The stop's name in the app's own font and card style; Google's plain bubble used its own sharp system font. */}
            <Callout onPress={onOpenStop ? () => onOpenStop(stop) : undefined} tooltip={true}>
              <View style={[styles.stopCallout, { backgroundColor: colors.surface, borderColor: colors.border }]} testID={`route-callout-${stop.name}`}>
                <Text numberOfLines={2} style={[styles.stopCalloutText, { color: colors.ink }]}>{stop.name}</Text>
                {onOpenStop ? <Icon color={colors.mutedInk} name="forward" size={14} /> : null}
              </View>
            </Callout>
          </Marker>
        );
      })}
      {arrow && zoom >= arrowZoom - ARROW_ZOOM_SLACK ? (
        // Which way the line runs, beside it just past the rider's stop. Flat, so it turns with the map.
        <Marker
          anchor={{ x: 0.5, y: 0.5 }}
          coordinate={{ latitude: arrow.point.lat, longitude: arrow.point.lon }}
          flat={true}
          rotation={arrow.bearing}
          tappable={false}
          testID="route-direction-arrow"
          tracksViewChanges={tracksArrowView}
          zIndex={1}
        >
          <DirectionArrow color={color} side={arrow.side} />
        </Marker>
      ) : null}
      {shownVehicles.map((vehicle) => {
        const selected = vehicle.tripId === selectedVehicleId;
        return <LiveVehicleMarker key={vehicle.tripId} color={color} mode={mode} onPosition={selected ? onSelectedVehiclePosition : undefined} onPress={onVehiclePress} project={projectVehicle} projectionRevision={selected ? projectionRevision : undefined} selected={selected} vehicle={vehicle} zIndex={2} />;
      })}
      {entrances.map((entrance) => (
        <Marker key={`entrance-${entrance.lat},${entrance.lon}`} anchor={CENTER_ANCHOR} coordinate={{ latitude: entrance.lat, longitude: entrance.lon }} testID="route-entrance" title={entranceLabel(entrance)} tracksViewChanges={tracksDots} zIndex={2}>
          <View style={[styles.entranceDot, { backgroundColor: color }]}><Icon color="#FFFFFF" name="arrowRight" size={11} /></View>
        </Marker>
      ))}
      {exploreFrom ? (
        <Marker anchor={CENTER_ANCHOR} coordinate={exploreFrom} tappable={false} testID="route-explore-dot" title="Exploring from here" tracksViewChanges={tracksDots} zIndex={3}>
          <View style={[styles.exploreDot, { backgroundColor: colors.searchCenter, shadowColor: colors.searchCenter }]} />
        </Marker>
      ) : null}
      {userLocation ? <HeadingBeamMarker coordinate={userLocation} /> : null}
      {userLocation ? (
        <Marker anchor={CENTER_ANCHOR} coordinate={userLocation} tappable={false} testID={`${testID}-user-location`} tracksViewChanges={tracksDots} zIndex={5}>
          <CurrentLocationMarker />
        </Marker>
      ) : null}
    </MapView>
  );
  return <View collapsable={false} ref={mapContainer} style={StyleSheet.absoluteFill}>{map}</View>;
}

/**
 * Android draws a map marker as a still picture of its view, and shadows (`elevation`) are left out
 * of that picture, so there a soft dark edge stands in for the shadow on pale map tiles.
 */
const ANDROID_MARKER_EDGE = Platform.OS === 'android' ? { borderWidth: 1.5, borderColor: 'rgba(22, 50, 79, 0.3)' } : null;

const styles = StyleSheet.create({
  entranceDot: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#FFFFFF', borderRadius: 3 },
  // The home map's purple explore dot, as it looks there.
  exploreDot: { width: 17, height: 17, borderWidth: 3, borderRadius: 8.5, borderColor: '#FFFFFF', shadowOpacity: 0.32, shadowRadius: 5, shadowOffset: { width: 0, height: 0 }, elevation: 3 },
  stopDot: {
    width: LINE_WIDTH,
    height: LINE_WIDTH,
    borderWidth: STOP_RING,
    borderRadius: LINE_WIDTH / 2,
    // Stop dots stay white in dark mode too.
    backgroundColor: '#FFFFFF',
  },
  stopCallout: {
    maxWidth: 240,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: 1,
    borderRadius: 16,
  },
  stopCalloutText: {
    flexShrink: 1,
    fontFamily: fontFamilies.extraBold,
    fontSize: 15,
  },
  // The rider's nearest stop: larger, white, with a thick ring in the route color.
  focusedStopDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 4,
  },
  vehicleBox: {
    width: VEHICLE_BOX + SHADOW_ROOM,
    height: VEHICLE_BOX_HEIGHT,
  },
  paintedShadow: { position: 'absolute' },
  // Borderless white circle with a route-color glyph: three times a stop dot's size and carrying
  // the mode glyph (stop dots never do), so a vehicle reads apart from a stop.
  vehicleBadge: {
    position: 'absolute',
    left: SHADOW_ROOM,
    bottom: SHADOW_ROOM,
    width: VEHICLE_SIZE,
    height: VEHICLE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: VEHICLE_SIZE / 2,
    backgroundColor: '#FFFFFF',
    // With no outline, the shadow is what keeps the white circle visible on pale map tiles.
    shadowColor: '#16324F',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 5,
    elevation: 6,
  },
  riderAvatar: {
    position: 'absolute',
    top: 0,
    width: RIDER_AVATAR,
    height: RIDER_AVATAR,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RIDER_AVATAR / 2,
    backgroundColor: '#FFFFFF',
    shadowColor: '#16324F',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 3,
    ...ANDROID_MARKER_EDGE,
  },
  ageBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
    borderRadius: 12,
  },
  ageText: {
    color: '#FFFFFF',
    fontFamily: 'Nunito_800ExtraBold',
    fontSize: 9,
  },
});
