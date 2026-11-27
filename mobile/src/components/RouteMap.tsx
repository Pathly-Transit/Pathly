import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BeanAvatar } from '../avatars/BeanAvatarImage';
import { formatAge, visibleTrains } from '../data/liveTrains';
import { approachingVehicle, ARROW_ZOOM_SLACK, directionArrowAt, focusStopIndex, metersPerPixel, middleDirectionArrowAt, riderNearStop, snapStopsToPath, splitPathAtStop, streetWalkToDraw, walkConnectors, walkToStreetStop, withAlpha } from '../data/routeDirection';
import { entranceLabel, type StationEntrance } from '../data/stationEntrances';
import { stopRevealZoom, zoomForRegion } from '../data/stopDeclutter';
import type { RouteLiveVehicle } from '../data/transitLive';
import type { Coordinates } from '../hooks/useCurrentLocation';
import { useGlide } from '../hooks/useGlide';
import { useNow } from '../hooks/useNow';
import { SELECTED_SCALE, useSelectionScale } from '../hooks/useSelectionScale';
import { MapCanvas, MapCircles, MapMarker, MapPolyline } from '../map/MapCanvas';
import { mapLandColor } from '../map/mapStyle';
import { fadedOver, type MapCameraChange, type MapCanvasRef, type MapCircle, type MapPoint } from '../map/mapTypes';
import { useTheme } from '../theme/AppSettings';
import { fontFamilies } from '../theme/typography';
import { DIRECTION_ARROW_BOX, DirectionArrow } from './DirectionArrow';
import { RiderLocationMarker } from './RiderLocationMarker';
import { Icon } from './Icon';
import { SavedPlaceMarkers } from './SavedPlaceMarkers';
import type { TransitMode } from './RouteBadge';
import type { VehicleScreenPoint } from './SelectedVehicleOverlay';

type GeometryStop = { stopId?: string; name: string; lat: number; lon: number; entrances?: readonly StationEntrance[] };

/** Street-level scale around a focused stop or the rider. */
const FOCUS_ZOOM = 13;
const FOCUS_MS = 400;
const ROUTE_FIT_PADDING = { top: 90, right: 40, bottom: 60, left: 40 };
/** The closest a framing may zoom (~1.3 km across), so a bus right by the stop isn't framed at street level. */
const FRAME_MAX_ZOOM = 15.5;
/** A station's entrances are framed no closer than this, so its street corners still show. */
const ENTRANCE_MAX_ZOOM = 18;
// The line behind the rider's stop (already travelled in this direction) is drawn faint.
const BEHIND_LINE_ALPHA = 0.35;
// Stop dots are exactly as wide as the line, so they sit inside it like beads instead of bulging
// out of it. Only the rider's own stop is drawn larger, so it stands out.
const LINE_WIDTH = 8;
const STOP_RING = 1.5;
const FOCUSED_STOP_RADIUS = 10;
const FOCUSED_STOP_RING = 4;
// The walk to the stop: plain round gray dots, which read from far out over any street.
const WALK_WIDTH = 6;
// The joins from the walk to the rider's and stop's dots: smaller dots.
const CONNECTOR_WIDTH = 3;

// Vehicle marker geometry: the circle sits bottom-left of a larger box so the age badge can
// overhang its top-right corner; room around it for its shadow.
const VEHICLE_SIZE = 42;
const VEHICLE_BOX = 54;
const SHADOW_ROOM = 6;
const VEHICLE_BOX_HEIGHT = VEHICLE_BOX + SHADOW_ROOM;
// Riders' avatars replace the age badge, stacked; the box widens to hold them.
const RIDER_AVATAR = 24;
const RIDER_AVATAR_STEP = 13;
const RIDER_AVATAR_LEFT = 30;
const RIDER_DISC_INSET = 2;
// The tapped vehicle, while its popup is open: larger (SELECTED_SCALE), and above every marker.
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
  /** Where the selected vehicle is on the screen, for its popup's copy drawn over the sheet's backdrop. */
  onSelectedVehiclePosition?: (point: VehicleScreenPoint | null) => void;
  /** The vehicle whose popup is open: drawn larger, above every other vehicle. */
  selectedVehicleId?: string | null;
  /** Tapping a stop's name (shown once its dot is tapped) opens the line at that stop. */
  onOpenStop?: (stop: GeometryStop) => void;
  /** Called when the rider moves the map, so the location button can drop its selected state. */
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

const toPoint = (point: { lat: number; lon: number }): MapPoint => ({ latitude: point.lat, longitude: point.lon });

/**
 * About the zoom that frames the whole line (with some room around it) on a phone-width map: where
 * a line looked up by name opens, and what its direction arrow is placed for until the map has
 * framed the line itself.
 */
function zoomToFrame(points: readonly { lat: number; lon: number }[]): number {
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const middleLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const span = Math.max(Math.max(...lons) - Math.min(...lons), (Math.max(...lats) - Math.min(...lats)) / Math.cos((middleLat * Math.PI) / 180));
  return zoomForRegion(Math.max(span * 1.3, 0.05), 390);
}

/**
 * A live vehicle (Route View and the trip map): a white circle with the line's mode glyph and its
 * position's age (or the riders aboard), gliding to each refreshed spot rather than jumping there.
 */
export function LiveVehicleMarker({ color, mode, onPosition, onPress, project, projectionRevision, selected = false, vehicle, zIndex }: {
  color: string;
  mode: TransitMode;
  /** Told where the vehicle is on the screen as it moves (the selected one only), and null once it's gone. */
  onPosition?: RouteMapProps['onSelectedVehiclePosition'];
  onPress?: (tripId: string) => void;
  /** The map's screen position for a point (MapCanvasRef.pointForCoordinate). */
  project?: (point: MapPoint) => Promise<{ x: number; y: number } | null>;
  /** Changed when the map moves, so the screen position is found again. */
  projectionRevision?: number;
  selected?: boolean;
  vehicle: RouteLiveVehicle;
  zIndex: number;
}) {
  const { lat, lon } = useGlide(vehicle);
  const { tripId } = vehicle;
  // An answer is kept only if it's the latest asked for, and the vehicle is still the one picked.
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
    }, () => undefined);
  }, [lat, lon, onPosition, project, projectionRevision, tripId]);
  // 0 plain, 1 while its popup is open, easing between (useSelectionScale).
  const selection = useSelectionScale(selected);
  const scale = 1 + (SELECTED_SCALE - 1) * selection;
  const avatars = vehicle.riders?.avatars ?? [];
  // The position's age ("12s") ticks each second.
  const now = useNow(1000);
  const age = vehicle.updatedAt != null ? formatAge(now - vehicle.updatedAt) : '';
  const boxWidth = SHADOW_ROOM + (avatars.length > 0 ? RIDER_AVATAR_LEFT + RIDER_AVATAR + (avatars.length - 1) * RIDER_AVATAR_STEP : VEHICLE_BOX);
  // The box is centered on the vehicle, then moved so the circle's center is what sits there.
  const circleX = SHADOW_ROOM + VEHICLE_SIZE / 2;
  const circleY = VEHICLE_BOX_HEIGHT - SHADOW_ROOM - VEHICLE_SIZE / 2;
  const offset: [number, number] = [boxWidth / 2 - circleX, VEHICLE_BOX_HEIGHT / 2 - circleY];
  // Grows about the circle's center, not the box's.
  const shiftX = circleX - boxWidth / 2;
  const shiftY = circleY - VEHICLE_BOX_HEIGHT / 2;
  return (
    <MapMarker
      accessibilityLabel={mode === 'bus' ? 'Bus' : 'Train'}
      coordinate={{ latitude: lat, longitude: lon }}
      offset={offset}
      onPress={onPress ? () => onPress(tripId) : undefined}
      testID={`route-vehicle-${tripId}`}
      zIndex={selected || selection > 0 ? SELECTED_Z_INDEX : zIndex}
    >
        <View
          pointerEvents={onPress ? 'auto' : 'none'}
          style={[styles.vehicleBox, { width: boxWidth }, selection !== 0 && { transform: [{ translateX: shiftX }, { translateY: shiftY }, { scale }, { translateX: -shiftX }, { translateY: -shiftY }] }]}
          testID={`route-vehicle-drawing-${tripId}`}
        >
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
    </MapMarker>
  );
}

/** Real route map: actual stop positions, the real line, and live vehicles — for any route with a live feed. */
export function RouteMap({ centerOnUserRequest = 0, color, directionId, entranceFocus, exploreFrom, fitPadding = ROUTE_FIT_PADDING, focusStopId, focusStopName, mode = 'rail', onOpenStop, onSelectedVehiclePosition, onUserPan, onVehiclePress, path, selectedVehicleId = null, showRouteRequest = 0, stops, testID = 'route-map', userLocation, vehicles, walkPath }: RouteMapProps) {
  const mapRef = useRef<MapCanvasRef>(null);
  // Where the selected vehicle is on the screen, found again whenever the map comes to rest.
  const projectVehicle = useCallback((point: MapPoint) => mapRef.current?.pointForCoordinate(point) ?? Promise.resolve(null), []);
  const [projectionRevision, setProjectionRevision] = useState(0);
  const refreshProjection = selectedVehicleId && onSelectedVehiclePosition ? () => setProjectionRevision((revision) => revision + 1) : undefined;
  // Where the walk starts: the purple dot when exploring, else the rider.
  const walkOrigin = exploreFrom ?? userLocation;
  const { colors, isDark, mapTheme } = useTheme();
  const land = mapLandColor(isDark, mapTheme);
  const riderMovedMap = useRef(false);
  // True from a location-button press until the rider pans (or asks for the whole route): keeps
  // following fresh GPS fixes.
  const followRider = useRef(false);
  const focusStop = stops[focusStopIndex(stops, focusStopId, focusStopName)];
  const wholeLine = useMemo(() => (path ?? stops).map(toPoint), [path, stops]);
  // Opens on the rider's stop; a line looked up by name opens about framed on its middle, then is framed exactly.
  const [initialCamera] = useState(() => {
    if (focusStop) return { center: toPoint(focusStop), zoom: FOCUS_ZOOM };
    const points = path ?? stops;
    const middle = points[Math.floor(points.length / 2)];
    return { center: middle ? toPoint(middle) : { latitude: 40.75, longitude: -73.95 }, zoom: points.length > 0 ? zoomToFrame(points) : 10 };
  });
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(initialCamera.zoom);
  const [selectedStop, setSelectedStop] = useState<GeometryStop | null>(null);
  // Stop dots are drawn only once they're zoomed apart (stopDeclutter.ts); the rider's stop always is.
  const revealZoom = useMemo(() => stopRevealZoom(stops.map((stop) => ({ lat: stop.lat, lng: stop.lon }))), [stops]);
  // Only for dropping vehicles not heard from in 5 minutes; each marker ticks its own age.
  const now = useNow(30_000);
  const shownVehicles = visibleTrains(vehicles, directionId, now);
  // Dots sit on the drawn line, not at the stop's own (platform) coordinates beside it.
  const dotSpots = useMemo(() => snapStopsToPath(path, stops), [path, stops]);
  const focusDot = focusStop ? dotSpots[stops.indexOf(focusStop)] : undefined;

  // Split at the rider's stop: faint behind it, full strength ahead.
  const line = useMemo(() => {
    const points = path ?? stops;
    const focusIndex = focusStop ? stops.indexOf(focusStop) : -1;
    if (focusIndex < 0) return { behind: [] as MapPoint[], ahead: points.map(toPoint), aheadPoints: [], behindPoints: [], wholePoints: points, focusIndex };
    const { behind, ahead } = splitPathAtStop(points, stops, focusIndex);
    return { behind: behind.map(toPoint), ahead: ahead.map(toPoint), aheadPoints: ahead, behindPoints: behind, wholePoints: null, focusIndex };
  }, [focusStop, path, stops]);

  // The zoom the whole line was first framed at (a line looked up by name, with no rider's stop).
  const [wholeLineZoom, setWholeLineZoom] = useState<number | null>(null);
  const awaitingWholeLineZoom = useRef(false);
  // Placed once, for the zoom the map opens at, so zooming never moves it. Zoomed out well past that,
  // the line's bends would reach it, so it's hidden there instead.
  const arrowZoom = line.wholePoints ? wholeLineZoom ?? initialCamera.zoom : FOCUS_ZOOM;
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

  const frame = (points: MapPoint[]) => mapRef.current?.fitPoints(points, { padding: fitPadding, durationMs: FOCUS_MS, maxZoom: FRAME_MAX_ZOOM });

  // The rider, when they're near their stop: framed with it so they see the walk there.
  // The purple dot is always framed: its walk and stop are the point of the page.
  const nearRider = walkOrigin && focusStop && (exploreFrom != null || riderNearStop(walkOrigin, focusStop)) ? walkOrigin : null;
  // A subway or rail station is reached through its entrances, so its walk ends at the street and
  // thin dotted joins stand for the way inside (and for the rider already at the station). A bus
  // stop or ferry landing is on the street: its whole walk, however short, is the one dotted walk.
  const atStation = mode === 'subway' || mode === 'rail';
  const streetWalk = useMemo(() => {
    const from = walkOrigin ? { lat: walkOrigin.latitude, lon: walkOrigin.longitude } : null;
    if (atStation) return streetWalkToDraw(walkPath, from, focusStop);
    const near = nearRider ? { lat: nearRider.latitude, lon: nearRider.longitude } : null;
    return walkToStreetStop(walkPath, walkPath ? from : near, focusDot);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by value
  }, [atStation, focusStop, focusDot?.lat, focusDot?.lon, nearRider?.latitude, nearRider?.longitude, walkOrigin?.latitude, walkOrigin?.longitude, walkPath]);
  const connectors = useMemo(() => {
    if (!atStation) return [];
    const from = streetWalk ? walkOrigin : nearRider;
    if (!from) return [];
    return walkConnectors(streetWalk, { lat: from.latitude, lon: from.longitude }, focusDot).map((join) => join.map(toPoint));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by value
  }, [atStation, focusDot?.lat, focusDot?.lon, nearRider?.latitude, nearRider?.longitude, walkOrigin?.latitude, walkOrigin?.longitude, streetWalk]);
  // Set once the map has framed an approaching vehicle (below).
  const framedVehicle = useRef(false);
  // The nearest stop (and whether the rider is near it) often resolves after the page opens; follow
  // them until the rider pans. Keyed on near/far, not every GPS fix.
  useEffect(() => {
    if (!ready || !focusStop || riderMovedMap.current || framedVehicle.current) return;
    if (nearRider) frame([toPoint(focusStop), nearRider]);
    else mapRef.current?.easeTo({ center: toPoint(focusStop), zoom: FOCUS_ZOOM, durationMs: FOCUS_MS });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stop's identity and the rider being near
  }, [ready, focusStop?.stopId, nearRider != null]);

  // Once a live vehicle shows up on its way to the rider's stop, the map glides out (once) to show
  // the stop and that vehicle (and the rider, when they're near the stop), unless the rider has
  // moved the map already.
  useEffect(() => {
    if (!ready || framedVehicle.current || riderMovedMap.current || !focusStop) return;
    const vehicle = approachingVehicle(line.behindPoints, shownVehicles);
    if (!vehicle) return;
    framedVehicle.current = true;
    frame([toPoint(focusStop), { latitude: vehicle.lat, longitude: vehicle.lon }, ...(nearRider ? [nearRider] : [])]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-checked as vehicles report; the rest is read then
  }, [ready, focusStop?.stopId, vehicles]);

  useEffect(() => {
    if (centerOnUserRequest === 0) return;
    followRider.current = true;
    riderMovedMap.current = true; // the nearest-stop focus must not pull the map back
  }, [centerOnUserRequest]);

  useEffect(() => {
    if (!ready || !followRider.current || !userLocation) return;
    mapRef.current?.easeTo({ center: userLocation, zoom: Math.max(zoom, FOCUS_ZOOM), durationMs: FOCUS_MS });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the request and fixes, at the zoom then
  }, [centerOnUserRequest, ready, userLocation]);

  // The route-overview button frames the whole line in this direction (every stop), clear of the
  // controls over the map's top and the page edge at its bottom.
  useEffect(() => {
    if (showRouteRequest === 0) return;
    followRider.current = false;
    riderMovedMap.current = true; // the nearest-stop focus must not pull the map back
    mapRef.current?.fitPoints(wholeLine, { padding: fitPadding, durationMs: FOCUS_MS });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request only; the line is read at request time
  }, [showRouteRequest]);

  // A stop row's entrances: marked on the map, which zooms in to frame them with the station.
  const entranceStop = entranceFocus ? stops.find((stop) => stop.stopId === entranceFocus.stopId) : undefined;
  const entrances = entranceStop?.entrances ?? [];
  useEffect(() => {
    if (!ready || !entranceStop || entrances.length === 0) return;
    followRider.current = false;
    riderMovedMap.current = true; // the nearest-stop focus must not pull the map back
    mapRef.current?.fitPoints([toPoint(entranceStop), ...entrances.map(toPoint)], { padding: fitPadding, durationMs: FOCUS_MS, maxZoom: ENTRANCE_MAX_ZOOM });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request; the stop is read then
  }, [ready, entranceFocus?.key]);

  const onReady = () => {
    setReady(true);
    refreshProjection?.();
    if (focusStop || wholeLine.length === 0) return;
    // The whole line, clear of the controls over the map's top; the arrow is placed for the zoom it settles at.
    awaitingWholeLineZoom.current = true;
    mapRef.current?.fitPoints(wholeLine, { padding: fitPadding, durationMs: 0 });
  };
  const onCameraIdle = ({ zoom: restingZoom }: MapCameraChange) => {
    setZoom(restingZoom);
    refreshProjection?.();
    if (awaitingWholeLineZoom.current) {
      awaitingWholeLineZoom.current = false;
      setWholeLineZoom(restingZoom);
    }
  };

  const circles = useMemo(() => stops.flatMap((stop, index): MapCircle[] => {
    const focused = stop === focusStop;
    if (!focused && zoom < revealZoom && stop !== selectedStop) return [];
    // Stops behind the rider's stop in this direction fade with the line behind it. Stop dots stay white in the dark theme too.
    const passed = line.focusIndex >= 0 && index < line.focusIndex;
    return [{
      key: String(index),
      coordinate: toPoint(dotSpots[index] ?? stop),
      radius: focused ? FOCUSED_STOP_RADIUS : LINE_WIDTH / 2,
      color: '#FFFFFF',
      // Solid, the faded line's own color: a see-through ring over the see-through line would look darker.
      strokeColor: focused || !passed ? color : fadedOver(color, land, BEHIND_LINE_ALPHA),
      strokeWidth: focused ? FOCUSED_STOP_RING : STOP_RING,
      sortKey: focused ? 1 : 0,
      testID: `route-stop-${stop.name}`,
    }];
  }), [color, dotSpots, focusStop, land, line.focusIndex, revealZoom, selectedStop, stops, zoom]);

  return (
    <MapCanvas
      initialCamera={initialCamera}
      onCameraIdle={onCameraIdle}
      onPress={() => setSelectedStop(null)}
      onReady={onReady}
      onUserGesture={() => {
        riderMovedMap.current = true;
        followRider.current = false;
        onUserPan?.();
      }}
      ref={mapRef}
      testID={testID}
    >
      {line.behind.length > 1 ? <MapPolyline color={withAlpha(color, BEHIND_LINE_ALPHA)} coordinates={line.behind} id="route-line-behind" testID="route-line-behind" width={LINE_WIDTH} zIndex={0} /> : null}
      <MapPolyline color={color} coordinates={line.ahead} id="route-line" testID="route-line" width={LINE_WIDTH} zIndex={1} />
      {connectors.map((join, index) => (
        <MapPolyline key={`connector-${index}`} color={colors.mutedInk} coordinates={join} dotted={true} id={`route-walk-connector-${index}`} testID={`route-walk-connector-${index}`} width={CONNECTOR_WIDTH} zIndex={2} />
      ))}
      {streetWalk ? (
        // The walk to the stop, dotted like the trip map's walking legs.
        <MapPolyline color={colors.mutedInk} coordinates={streetWalk.map(toPoint)} dotted={true} id="route-walk" testID="route-walk" width={WALK_WIDTH} zIndex={2} />
      ) : null}
      <MapCircles
        circles={circles}
        id="route-stops"
        onPress={(key) => setSelectedStop(stops[Number(key)] ?? null)}
        testID="route-stops"
        zIndex={3}
      />
      {/* The rider's saved places, under the trip's own markers. */}
      <SavedPlaceMarkers zIndex={0} zoom={zoom} />
      {arrow && zoom >= arrowZoom - ARROW_ZOOM_SLACK ? (
        // Which way the line runs, beside it just past the rider's stop; it turns with the map.
        <MapMarker coordinate={toPoint(arrow.point)} rotation={arrow.bearing} testID="route-direction-arrow" zIndex={1}>
          <View pointerEvents="none" style={{ width: DIRECTION_ARROW_BOX, height: DIRECTION_ARROW_BOX }}>
            <DirectionArrow color={color} side={arrow.side} />
          </View>
        </MapMarker>
      ) : null}
      {shownVehicles.map((vehicle) => {
        const selected = vehicle.tripId === selectedVehicleId;
        return (
          <LiveVehicleMarker
            key={vehicle.tripId}
            color={color}
            mode={mode}
            onPosition={selected ? onSelectedVehiclePosition : undefined}
            onPress={onVehiclePress}
            project={projectVehicle}
            projectionRevision={selected ? projectionRevision : undefined}
            selected={selected}
            vehicle={vehicle}
            zIndex={2}
          />
        );
      })}
      {entrances.map((entrance) => (
        // A station's way in or out: a square in the line's color with a white arrow.
        <MapMarker key={`entrance-${entrance.lat},${entrance.lon}`} accessibilityLabel={entranceLabel(entrance)} coordinate={toPoint(entrance)} testID="route-entrance" zIndex={2}>
          <View pointerEvents="none" style={[styles.entranceDot, { backgroundColor: color }]}><Icon color="#FFFFFF" name="arrowRight" size={11} /></View>
        </MapMarker>
      ))}
      {exploreFrom ? (
        <MapMarker accessibilityLabel="Exploring from here" coordinate={exploreFrom} testID="route-explore-dot" zIndex={3}>
          <View style={[styles.exploreDot, { backgroundColor: colors.searchCenter, shadowColor: colors.searchCenter }]} />
        </MapMarker>
      ) : null}
      {selectedStop ? (
        // The tapped stop's name, in the app's own font and card; tapping it opens the line there.
        <MapMarker anchor="bottom" coordinate={toPoint(selectedStop)} offset={[0, -10]} testID={`route-callout-${selectedStop.name}`} zIndex={4}>
          <Pressable
            accessibilityLabel={onOpenStop ? `Open ${selectedStop.name}` : selectedStop.name}
            accessibilityRole={onOpenStop ? 'button' : 'text'}
            disabled={!onOpenStop}
            onPress={onOpenStop ? () => onOpenStop(selectedStop) : undefined}
            style={[styles.stopCallout, { backgroundColor: colors.surface, borderColor: isDark ? colors.border : color }]}
          >
            <Text numberOfLines={2} style={[styles.stopCalloutText, { color: colors.ink }]}>{selectedStop.name}</Text>
            {onOpenStop ? <Icon color={colors.mutedInk} name="forward" size={14} /> : null}
          </Pressable>
        </MapMarker>
      ) : null}
      {userLocation ? <RiderLocationMarker coordinate={userLocation} testID={`${testID}-user-location`} zIndex={5} /> : null}
    </MapCanvas>
  );
}

const styles = StyleSheet.create({
  entranceDot: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#FFFFFF', borderRadius: 6 },
  // The home map's purple explore dot, as it looks there.
  exploreDot: { width: 17, height: 17, borderWidth: 3, borderRadius: 8.5, borderColor: '#FFFFFF', shadowOpacity: 0.32, shadowRadius: 5, shadowOffset: { width: 0, height: 0 }, elevation: 3 },
  stopCallout: {
    maxWidth: 240,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: 1.5,
    borderRadius: 16,
    shadowColor: '#16324F',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
  },
  stopCalloutText: {
    flexShrink: 1,
    fontFamily: fontFamilies.extraBold,
    fontSize: 15,
  },
  vehicleBox: {
    height: VEHICLE_BOX_HEIGHT,
  },
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
