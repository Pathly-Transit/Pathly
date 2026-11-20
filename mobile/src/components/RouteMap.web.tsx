import { GoogleMap, Marker, OverlayViewF, OVERLAY_LAYER, OVERLAY_MOUSE_TARGET, Polyline, useJsApiLoader } from '@react-google-maps/api';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { GOOGLE_MAPS_LIBRARIES, GOOGLE_MAPS_SCRIPT_ID } from '../data/googleMapsLoaderConfig';
import { beanAvatarSvg, type BeanAvatarConfig } from '../avatars/beanAvatar';
import { formatAge, visibleTrains } from '../data/liveTrains';
import { googleMapStyle } from '../data/mapStyle';
import { entranceLabel, type StationEntrance } from '../data/stationEntrances';
import { approachingVehicle, ARROW_ZOOM_SLACK, directionArrowAt, focusStopIndex, metersPerPixel, middleDirectionArrowAt, riderNearStop, snapStopsToPath, splitPathAtStop, streetWalkToDraw, walkConnectors, withMinimumFitSpan } from '../data/routeDirection';
import { stopRevealZoom } from '../data/stopDeclutter';
import type { RouteLiveVehicle } from '../data/transitLive';
import type { Coordinates } from '../hooks/useCurrentLocation';
import { useNow } from '../hooks/useNow';
import { SELECT_BEZIER, SELECT_MS, SELECTED_SCALE } from '../hooks/useSelectionScale';
import { useAppSettings, useTheme } from '../theme/AppSettings';
import { fontFamilies } from '../theme/typography';
import type { TransitMode } from './RouteBadge';
import { HeadingBeamMarker } from './HeadingBeamMarker';
import { Glide } from '../hooks/useGlide';
import { DIRECTION_ARROW_BOX, DirectionArrow } from './DirectionArrow';
import { cameraToFit, glideMapTo } from './webMapGlide';
import type { VehicleScreenPoint } from './SelectedVehicleOverlay';

type GeometryStop = { stopId?: string; name: string; lat: number; lon: number; entrances?: readonly StationEntrance[] };

const containerStyle = { width: '100%', height: '100%' };
// 'greedy': one-finger drag pans on touch browsers and the wheel zooms without holding Ctrl,
// since this map sits in its own uncovered area of the page rather than inside scrolling text.
const baseMapOptions = { disableDefaultUI: true, keyboardShortcuts: false, gestureHandling: 'greedy', clickableIcons: false };
// Arbitrary point; immediately replaced by fitBounds (or the focus stop) once the map is ready.
const FALLBACK_CENTER = { lat: 40.75, lng: -73.95 };
const FOCUS_ZOOM = 13;
/** A station's entrances are framed no closer than this, so its street corners still show. */
const ENTRANCE_MAX_ZOOM = 18;
const ROUTE_FIT_PADDING = { top: 90, right: 40, bottom: 60, left: 40 };
// The line behind the rider's stop (already travelled in this direction) is drawn faint.
const BEHIND_LINE_OPACITY = 0.35;
// Stop dots are exactly as wide as the line (a circle symbol's outer size is 2 × scale + stroke),
// so they sit inside it like beads. Only the rider's own stop is drawn larger, so it stands out.
const LINE_WIDTH = 8;
const STOP_RING = 1.5;
const STOP_DOT_SCALE = (LINE_WIDTH - STOP_RING) / 2;
// The walk to the stop: a row of dots, matching TripMap.web.tsx's walking legs.
// Walks are plain round gray dots, which read from far out over any street.
const WALK_DOT_SCALE = 3.5;
// The joins from the walk to the rider's and stop's dots: smaller dots, closer together.
const CONNECTOR_DOT_SCALE = 1.75;

// Vehicle marker geometry: circle at bottom-left of a larger box so the age badge can overhang its top-right.
const VEHICLE_SIZE = 42;
const VEHICLE_BOX = 54;
// Riders' avatars replace the age badge, stacked to the circle's top-right.
const RIDER_AVATAR = 24;
const RIDER_AVATAR_STEP = 13;
const RIDER_AVATAR_LEFT = 30;
const RIDER_DISC_INSET = 2;
// The tapped vehicle, while its popup is open: this much larger, and above every other vehicle.
const SELECTED_Z_INDEX = 10;
const vehicleBoxWidth = (riders: number) => (riders > 0 ? RIDER_AVATAR_LEFT + RIDER_AVATAR + (riders - 1) * RIDER_AVATAR_STEP : VEHICLE_BOX);

/**
 * Borderless white circle with a route-color vehicle glyph (three times a stop dot's size and
 * carrying a glyph they never have), plus a borderless route-color age badge with white text at
 * its top-right, as an SVG data URL. With no outline, the shadow keeps the white circle visible
 * on pale tiles.
 */
function vehicleIconUrl(color: string, age: string | null, avatars: readonly BeanAvatarConfig[], badgeOnly = false) {
  const r = VEHICLE_SIZE / 2;
  const cx = r;
  const cy = VEHICLE_BOX - r;
  const badge = age
    // Just the badge's circle: its "5s" is text laid over it (WebVehicleMarker), since an image
    // can't load the app's font and fell back to Arial.
    ? `<circle cx="${VEHICLE_BOX - 12}" cy="12" r="11" fill="${color}"/>`
    : '';
  // An image can't load anything else, but can hold another image as a data URL.
  // Each on a white disc that keeps it apart from the map and its neighbor; the first (the rider's own) on top.
  const riders = avatars.map((avatar, index) => {
    const left = RIDER_AVATAR_LEFT + index * RIDER_AVATAR_STEP;
    return `<circle cx="${left + RIDER_AVATAR / 2}" cy="${RIDER_AVATAR / 2}" r="${RIDER_AVATAR / 2}" fill="#FFFFFF" filter="url(#s)"/><image x="${left + RIDER_DISC_INSET}" y="${RIDER_DISC_INSET}" width="${RIDER_AVATAR - RIDER_DISC_INSET * 2}" height="${RIDER_AVATAR - RIDER_DISC_INSET * 2}" href="data:image/svg+xml;charset=UTF-8,${encodeURIComponent(beanAvatarSvg(avatar))}"/>`;
  }).reverse().join('');
  const width = badgeOnly ? VEHICLE_SIZE - 6 : vehicleBoxWidth(avatars.length);
  const height = badgeOnly ? width : VEHICLE_BOX;
  const origin = badgeOnly ? `${cx - width / 2} ${cy - height / 2}` : '0 0';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${origin} ${width} ${height}">
<defs><filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#16324F" flood-opacity="0.45"/></filter></defs>
<g>
<circle cx="${cx}" cy="${cy}" r="${r - 3}" fill="#FFFFFF"${badgeOnly ? '' : ' filter="url(#s)"'}/>
<g transform="translate(${cx - 8.4} ${cy - 10.8}) scale(1.2)">
<rect x="0" y="0" width="14" height="14" rx="3.5" fill="${color}"/>
<rect x="2.2" y="2.6" width="9.6" height="5" rx="1.2" fill="#FFFFFF"/>
<circle cx="3.6" cy="11" r="1.3" fill="#FFFFFF"/><circle cx="10.4" cy="11" r="1.3" fill="#FFFFFF"/>
<path d="M2.4 14.6 L0.6 17.6 M11.6 14.6 L13.4 17.6" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>
</g>${badge}${riders}</g>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

/**
 * One live vehicle, gliding to each refreshed spot. The picked vehicle grows, sits above the other
 * markers, and shrinks back when dismissed.
 *
 * Drawn as one element, its age in the same box as its circle: a Google marker's label goes in a
 * layer above every marker's picture, so two vehicles side by side showed one's age over the
 * other's circle. As one element, the vehicle in front covers the one behind, age and all.
 *
 * The grow is the browser's own transition, so it runs without redrawing the vehicle each frame.
 */
export function WebVehicleMarker({ color, now, onPosition, onPress, selected = false, title, vehicle, zIndex }: { color: string; now: number; onPosition?: RouteMapProps['onSelectedVehiclePosition']; onPress?: (tripId: string) => void; selected?: boolean; title: string; vehicle: RouteLiveVehicle; zIndex: number }) {
  const { reducedMotionActive } = useAppSettings();
  const hitTarget = useRef<HTMLSpanElement>(null);
  const { tripId } = vehicle;
  useEffect(() => {
    if (!onPosition) return;
    const badgeUrl = vehicleIconUrl(color, null, [], true);
    let frame: number;
    let lastPoint: VehicleScreenPoint | undefined;
    const trackPosition = () => {
      const bounds = hitTarget.current?.getBoundingClientRect();
      if (bounds && bounds.width > 0) {
        // The hit target follows Google's overlay and grows around its own center.
        const x = Math.round(bounds.left + bounds.width / 2);
        const y = Math.round(bounds.top + bounds.height / 2);
        if (x !== lastPoint?.x || y !== lastPoint?.y) {
          lastPoint = { tripId, x, y, badgeUrl };
          onPosition(lastPoint);
        }
      }
      frame = requestAnimationFrame(trackPosition);
    };
    trackPosition();
    return () => {
      cancelAnimationFrame(frame);
      onPosition(null);
    };
  }, [color, onPosition, tripId]);
  const avatars = vehicle.riders?.avatars ?? [];
  const age = avatars.length === 0 && vehicle.updatedAt != null ? formatAge(now - vehicle.updatedAt) : null;
  // Drawn once per refresh, not per glide frame.
  const avatarsKey = JSON.stringify(avatars);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- avatars are keyed by their contents
  const url = useMemo(() => vehicleIconUrl(color, age, avatars), [color, age, avatarsKey]);
  const pad = 0;
  const drawingWidth = vehicleBoxWidth(avatars.length);
  const width = drawingWidth + pad * 2;
  const height = VEHICLE_BOX + pad * 2;
  // The circle's center, which sits on the vehicle's position.
  const centerX = pad + VEHICLE_SIZE / 2;
  const centerY = pad + VEHICLE_BOX - VEHICLE_SIZE / 2;
  const offset = useCallback(() => ({ x: -centerX, y: -centerY }), [centerX, centerY]);
  const transition = reducedMotionActive ? undefined : `transform ${SELECT_MS}ms cubic-bezier(${SELECT_BEZIER.join(', ')})`;
  return (
    <Glide lat={vehicle.lat} lon={vehicle.lon}>
      {(point) => (
        <OverlayViewF getPixelPositionOffset={offset} mapPaneName={OVERLAY_MOUSE_TARGET} position={{ lat: point.lat, lng: point.lon }} zIndex={selected ? SELECTED_Z_INDEX : zIndex}>
          <div
            aria-label={onPress ? `${title}, details` : title}
            data-testid={`route-vehicle-${vehicle.tripId}`}
            onClick={onPress ? (event) => {
              event.stopPropagation();
              onPress(vehicle.tripId);
            } : undefined}
            // Google's map listens below React's root: without this a tap would also reach the map.
            ref={(element) => {
              if (element && onPress) google.maps.OverlayView.preventMapHitsAndGesturesFrom(element);
            }}
            role={onPress ? 'button' : 'img'}
            style={{
              position: 'relative',
              width,
              height,
              cursor: onPress ? 'pointer' : 'default',
              transform: `scale(${selected ? SELECTED_SCALE : 1})`,
              transformOrigin: `${centerX}px ${centerY}px`,
              transition,
              willChange: 'transform',
              // The picture's empty corners don't take taps meant for the map or a stop under them.
              pointerEvents: 'none',
            }}
            title={title}
          >
            <img alt="" draggable={false} height={VEHICLE_BOX} src={url} style={{ position: 'absolute', left: pad, top: pad, display: 'block', pointerEvents: 'none' }} width={drawingWidth} />
            {/* Just the circle (and the age badge) take taps. */}
            <span
              ref={hitTarget}
              style={{ position: 'absolute', left: centerX - VEHICLE_SIZE / 2, top: centerY - VEHICLE_SIZE / 2, width: VEHICLE_SIZE, height: VEHICLE_SIZE, borderRadius: VEHICLE_SIZE / 2, pointerEvents: 'auto' }}
            />
            {age ? (
              <span
                style={{
                  position: 'absolute',
                  left: pad + VEHICLE_BOX - 24,
                  top: pad + 1,
                  width: 24,
                  height: 22,
                  lineHeight: '22px',
                  textAlign: 'center',
                  color: '#FFFFFF',
                  fontFamily: `${fontFamilies.extraBold}, Nunito, sans-serif`,
                  fontSize: 9,
                  fontWeight: 800,
                  pointerEvents: 'auto',
                }}
              >
                {age}
              </span>
            ) : null}
          </div>
        </OverlayViewF>
      )}
    </Glide>
  );
}

/** A square in the line's color with a white arrow, for a station's way in or out. */
export function entranceIcon(color: string): google.maps.Icon {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><rect x="1" y="1" width="16" height="16" rx="3" fill="${color}" stroke="#FFFFFF" stroke-width="1.5"/><path d="M4.5 9H13M10 5.8 13.2 9 10 12.2" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return { url: `data:image/svg+xml,${encodeURIComponent(svg)}`, anchor: new google.maps.Point(9, 9) };
}

/** Places the stop label's bottom-center just above the dot. */
const labelOffset = (width: number, height: number) => ({ x: -width / 2, y: -height - 12 });

type RouteMapProps = {
  /** Room (pt) to keep around framed points, clear of the controls drawn over the map. */
  fitPadding?: { top: number; right: number; bottom: number; left: number };
  /** Incremented by the location button; each change centers the map on `userLocation` and follows it until a drag. */
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
  /** Vehicle label (train vs bus). */
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
  vehicles: readonly RouteLiveVehicle[];
  /** The walk along the streets from the rider to the focused stop, drawn dotted (as on the trip map). */
  walkPath?: readonly { lat: number; lon: number }[];
};

/** Real route map: actual stop positions, the real line, and live vehicles — for any route with a live feed. */
const arrowOffset = () => ({ x: -DIRECTION_ARROW_BOX / 2, y: -DIRECTION_ARROW_BOX / 2 });

export function RouteMap({ centerOnUserRequest = 0, color, directionId, entranceFocus, exploreFrom, focusStopId, focusStopName, mode = 'rail', onOpenStop, onSelectedVehiclePosition, onUserPan, onVehiclePress, path, selectedVehicleId = null, showRouteRequest = 0, stops, testID = 'route-map', userLocation, vehicles, walkPath }: RouteMapProps) {
  // Where the walk starts: the purple dot when exploring, else the rider.
  const walkOrigin = exploreFrom ?? userLocation;
  const { isLoaded } = useJsApiLoader({
    id: GOOGLE_MAPS_SCRIPT_ID,
    googleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_WEB_API_KEY ?? '',
    libraries: GOOGLE_MAPS_LIBRARIES,
  });
  // Places hidden, and recolored in the dark theme (see mapStyle.ts).
  const { colors, isDark } = useTheme();
  const mapOptions = useMemo(() => ({ ...baseMapOptions, styles: googleMapStyle(isDark) }), [isDark]);
  const [selectedStop, setSelectedStop] = useState<GeometryStop | null>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  // Stop dots are drawn only once they're zoomed apart (stopDeclutter.ts); the rider's stop always is.
  const [zoom, setZoom] = useState(0);
  // The loaded map, readable from its first zoom change (before `map` state has updated).
  const zoomSource = useRef<google.maps.Map | null>(null);
  const revealZoom = useMemo(() => stopRevealZoom(stops.map((stop) => ({ lat: stop.lat, lng: stop.lon }))), [stops]);
  const riderMovedMap = useRef(false);
  // True from a location-button press until the rider drags (or asks for the whole route): keeps
  // following fresh GPS fixes.
  const followRider = useRef(false);
  const now = useNow(1000);
  const shownVehicles = visibleTrains(vehicles, directionId, now);
  const vehicleLabel = mode === 'bus' ? 'Bus' : 'Train';
  const focusStop = stops[focusStopIndex(stops, focusStopId, focusStopName)];
  // Dots sit on the drawn line, not at the stop's own (platform) coordinates beside it.
  const dotSpots = useMemo(() => snapStopsToPath(path, stops), [path, stops]);
  const dotSpot = (stop: GeometryStop) => {
    const spot = dotSpots[stops.indexOf(stop)];
    return { lat: spot?.lat ?? stop.lat, lng: spot?.lon ?? stop.lon };
  };
  const focusDot = focusStop ? dotSpots[stops.indexOf(focusStop)] : undefined;

  // Split at the rider's stop: faint behind it, full strength ahead.
  const line = useMemo(() => {
    const points = path ?? stops;
    const toPath = (part: readonly { lat: number; lon: number }[]) => part.map((point) => ({ lat: point.lat, lng: point.lon }));
    const focusIndex = focusStop ? stops.indexOf(focusStop) : -1;
    if (focusIndex < 0) return { behind: [], ahead: toPath(points), aheadPoints: [], behindPoints: [], wholePoints: points, focusIndex };
    const { behind, ahead } = splitPathAtStop(points, stops, focusIndex);
    return { behind: toPath(behind), ahead: toPath(ahead), aheadPoints: ahead, behindPoints: behind, wholePoints: null, focusIndex };
  }, [focusStop, path, stops]);
  // The zoom the whole line was first framed at (a line looked up by name, with no rider's stop).
  const [wholeLineZoom, setWholeLineZoom] = useState<number | null>(null);
  // Placed once, for the zoom the map opens at, so zooming never moves it. Zoomed out well past that,
  // the line's bends would reach it, so it's hidden there instead.
  const arrowZoom = line.wholePoints ? wholeLineZoom ?? 0 : FOCUS_ZOOM;
  const arrow = useMemo(() => {
    if (arrowZoom <= 0) return null;
    // No rider's stop: near the middle of the line, moving to the other direction's line on a switch.
    if (line.wholePoints) {
      const middle = line.wholePoints[Math.floor(line.wholePoints.length / 2)];
      return middle ? middleDirectionArrowAt(line.wholePoints, metersPerPixel(arrowZoom - ARROW_ZOOM_SLACK, middle.lat)) : null;
    }
    const start = line.aheadPoints[0];
    // The faint line behind the stop is drawn too, so the arrow keeps clear of it as well.
    return start ? directionArrowAt(line.aheadPoints, metersPerPixel(arrowZoom - ARROW_ZOOM_SLACK, start.lat), [line.behindPoints]) : null;
  }, [arrowZoom, line.aheadPoints, line.behindPoints, line.wholePoints]);
  const polylineOptions = useMemo(() => ({ strokeColor: color, strokeWeight: LINE_WIDTH, zIndex: 1 }), [color]);
  const behindPolylineOptions = useMemo(() => ({ strokeColor: color, strokeOpacity: BEHIND_LINE_OPACITY, strokeWeight: LINE_WIDTH, zIndex: 0 }), [color]);

  // The rider, when they're near their stop: framed with it so they see the walk there.
  // The purple dot is always framed: its walk and stop are the point of the page.
  const nearRider = walkOrigin && focusStop && (exploreFrom != null || riderNearStop(walkOrigin, focusStop)) ? { lat: walkOrigin.latitude, lng: walkOrigin.longitude } : null;
  // Thin dotted joins from the rider's dot and to the stop's dot, where the street walk stops short
  // of them (or straight between them with no walk, for a rider near enough to walk).
  // No street walk once the rider is at the stop: just the thin join between the dots.
  const streetWalk = useMemo(
    () => streetWalkToDraw(walkPath, walkOrigin ? { lat: walkOrigin.latitude, lon: walkOrigin.longitude } : null, focusStop),
    [focusStop, walkOrigin?.latitude, walkOrigin?.longitude, walkPath],
  );
  const connectors = useMemo(() => {
    const from = streetWalk ? walkOrigin : nearRider ? { latitude: nearRider.lat, longitude: nearRider.lng } : null;
    if (!from) return [];
    return walkConnectors(streetWalk, { lat: from.latitude, lon: from.longitude }, focusDot)
      .map((join) => join.map((point) => ({ lat: point.lat, lng: point.lon })));
  }, [focusDot?.lat, focusDot?.lon, nearRider?.lat, nearRider?.lng, walkOrigin?.latitude, walkOrigin?.longitude, streetWalk]);
  const frameStop = (target: google.maps.Map, stop: GeometryStop, extra: readonly google.maps.LatLngLiteral[]) => {
    // Never closer than ~1.3 km, so a rider right by the stop doesn't open the map at street level.
    const points = extra.length > 0 ? withMinimumFitSpan([{ lat: stop.lat, lng: stop.lon }, ...extra]) : [{ lat: stop.lat, lng: stop.lon }];
    if (points.length === 1) {
      target.panTo(points[0]!);
      if ((target.getZoom() ?? 0) < FOCUS_ZOOM) target.setZoom(FOCUS_ZOOM);
      return;
    }
    const camera = cameraToFit(target, points, ROUTE_FIT_PADDING, FOCUS_ZOOM + 3);
    if (camera) {
      glideCancel.current?.();
      glideCancel.current = glideMapTo(target, camera.centerAt, camera.zoom);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    for (const point of points) bounds.extend(point);
    target.fitBounds(bounds, ROUTE_FIT_PADDING);
  };
  const glideCancel = useRef<(() => void) | null>(null);

  // A stop row's entrances: marked on the map, which zooms in to frame them with the station.
  const entranceStop = entranceFocus ? stops.find((stop) => stop.stopId === entranceFocus.stopId) : undefined;
  const entrances = entranceStop?.entrances ?? [];
  const frameEntrances = (target: google.maps.Map, stop: GeometryStop) => {
    const points = [{ lat: stop.lat, lng: stop.lon }, ...entrances.map((entrance) => ({ lat: entrance.lat, lng: entrance.lon }))];
    const camera = cameraToFit(target, points, ROUTE_FIT_PADDING, ENTRANCE_MAX_ZOOM);
    glideCancel.current?.();
    if (camera) {
      glideCancel.current = glideMapTo(target, camera.centerAt, camera.zoom);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    for (const point of points) bounds.extend(point);
    target.fitBounds(bounds, ROUTE_FIT_PADDING);
  };

  // Opens on the rider's nearest stop when known (with the rider, if they're close by), otherwise
  // fits every stop with some breathing room.
  const onLoad = useCallback((loadedMap: google.maps.Map) => {
    setMap(loadedMap);
    zoomSource.current = loadedMap;
    if (focusStop) {
      loadedMap.setCenter({ lat: focusStop.lat, lng: focusStop.lon });
      loadedMap.setZoom(FOCUS_ZOOM);
      if (nearRider) {
        const bounds = new google.maps.LatLngBounds();
        for (const point of withMinimumFitSpan([{ lat: focusStop.lat, lng: focusStop.lon }, nearRider])) bounds.extend(point);
        loadedMap.fitBounds(bounds, ROUTE_FIT_PADDING);
      }
      return;
    }
    // The whole line, clear of the controls over the map's top.
    const bounds = new google.maps.LatLngBounds();
    for (const point of path ?? stops) bounds.extend({ lat: point.lat, lng: point.lon });
    loadedMap.fitBounds(bounds, ROUTE_FIT_PADDING);
    // The direction arrow is placed for the zoom the line settles at.
    google.maps.event.addListenerOnce(loadedMap, 'idle', () => setWholeLineZoom(loadedMap.getZoom() ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot camera setup on load
  }, [stops]);

  // Set once the map has framed an approaching vehicle (below).
  const framedVehicle = useRef(false);
  // The nearest stop (and whether the rider is near it) often resolves after the page opens; follow
  // them until the rider drags. Keyed on near/far, not every GPS fix.
  useEffect(() => {
    if (!map || !focusStop || riderMovedMap.current || framedVehicle.current) return;
    frameStop(map, focusStop, nearRider ? [nearRider] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stop's identity and the rider being near
  }, [map, focusStop?.stopId, nearRider != null]);

  // Once a live vehicle shows up on its way to the rider's stop, the map glides out (once) to show
  // the stop and that vehicle (and the rider, when they're near the stop), unless the rider has
  // moved the map already.
  useEffect(() => {
    if (framedVehicle.current || riderMovedMap.current || !map || !focusStop) return;
    const vehicle = approachingVehicle(line.behindPoints, shownVehicles);
    if (!vehicle) return;
    framedVehicle.current = true;
    frameStop(map, focusStop, [{ lat: vehicle.lat, lng: vehicle.lon }, ...(nearRider ? [nearRider] : [])]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-checked as vehicles report; the rest is read then
  }, [map, focusStop?.stopId, vehicles]);
  useEffect(() => () => glideCancel.current?.(), []);

  useEffect(() => {
    if (centerOnUserRequest === 0) return;
    followRider.current = true;
    riderMovedMap.current = true; // the nearest-stop focus must not pull the map back
  }, [centerOnUserRequest]);

  // Glides there (zooming back in a level at a time from far out) rather than jumping.
  useEffect(() => {
    if (!followRider.current || !map || !userLocation) return undefined;
    const rider = { lat: userLocation.latitude, lng: userLocation.longitude };
    return glideMapTo(map, () => rider, Math.max(map.getZoom() ?? 0, FOCUS_ZOOM));
  }, [centerOnUserRequest, map, userLocation]);

  // The route-overview button frames the whole line in this direction (every stop), clear of the
  // controls over the map's top.
  useEffect(() => {
    if (showRouteRequest === 0 || !map) return;
    followRider.current = false;
    riderMovedMap.current = true; // the nearest-stop focus must not pull the map back
    const bounds = new google.maps.LatLngBounds();
    for (const point of path ?? stops) bounds.extend({ lat: point.lat, lng: point.lon });
    map.fitBounds(bounds, ROUTE_FIT_PADDING);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request only; the line is read at request time
  }, [showRouteRequest]);

  useEffect(() => {
    if (!map || !entranceStop || entrances.length === 0) return;
    followRider.current = false;
    riderMovedMap.current = true; // the nearest-stop focus must not pull the map back
    frameEntrances(map, entranceStop);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request; the stop is read then
  }, [map, entranceFocus?.key]);

  return (
    <View style={StyleSheet.absoluteFill} testID={testID}>
      {isLoaded ? (
        <GoogleMap
          center={FALLBACK_CENTER}
          mapContainerStyle={containerStyle}
          onClick={() => setSelectedStop(null)}
          onDragStart={() => {
            riderMovedMap.current = true;
            followRider.current = false;
            onUserPan?.();
          }}
          onLoad={onLoad}
          onZoomChanged={() => setZoom(zoomSource.current?.getZoom() ?? 0)}
          onUnmount={() => setMap(null)}
          options={mapOptions}
          zoom={9}
        >
          {line.behind.length > 1 ? <Polyline options={behindPolylineOptions} path={line.behind} /> : null}
          <Polyline options={polylineOptions} path={line.ahead} />
          {connectors.map((join, index) => (
            <Polyline
              key={`connector-${index}`}
              options={{
                strokeOpacity: 0,
                icons: [{ icon: { path: google.maps.SymbolPath.CIRCLE, scale: CONNECTOR_DOT_SCALE, fillColor: colors.mutedInk, fillOpacity: 1, strokeWeight: 0 }, offset: '0', repeat: '7px' }],
                zIndex: 2,
                clickable: false,
              }}
              path={join}
            />
          ))}
          {streetWalk ? (
            <Polyline
              options={{
                strokeOpacity: 0,
                icons: [{ icon: { path: google.maps.SymbolPath.CIRCLE, scale: WALK_DOT_SCALE, fillColor: colors.mutedInk, fillOpacity: 1, strokeWeight: 0 }, offset: '0', repeat: '13px' }],
                zIndex: 2,
                clickable: false,
              }}
              path={streetWalk.map((point) => ({ lat: point.lat, lng: point.lon }))}
            />
          ) : null}
          {stops.map((stop, stopIndex) => {
            const focused = stop === focusStop;
            if (!focused && zoom < revealZoom && stop !== selectedStop) return null;
            // Stops behind the rider's stop in this direction fade with the line behind it.
            const passed = line.focusIndex >= 0 && stopIndex < line.focusIndex;
            return (
              <Marker
                key={`${stop.stopId ?? stop.name}-${stopIndex}`}
                // A circle symbol is centered on its position by definition, unlike a pin. The
                // rider's nearest stop is larger and white, with a thick ring in the route color.
                icon={focused
                  ? { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#FFFFFF', fillOpacity: 1, strokeColor: color, strokeWeight: 4 }
                  : { path: google.maps.SymbolPath.CIRCLE, scale: STOP_DOT_SCALE, fillColor: '#FFFFFF', fillOpacity: 1, strokeColor: color, strokeOpacity: passed ? BEHIND_LINE_OPACITY : 1, strokeWeight: STOP_RING }}
                onClick={() => setSelectedStop(stop)}
                position={dotSpot(stop)}
                title={stop.name}
                zIndex={focused ? 1 : 0}
              />
            );
          })}
          {selectedStop ? (
            // A compact label instead of Google's InfoWindow, whose close button overlapped the name.
            <OverlayViewF getPixelPositionOffset={labelOffset} mapPaneName={OVERLAY_MOUSE_TARGET} position={dotSpot(selectedStop)}>
              <div
                aria-label={onOpenStop ? `Open ${selectedStop.name}` : undefined}
                onClick={onOpenStop ? (event) => {
                  event.stopPropagation();
                  onOpenStop(selectedStop);
                } : undefined}
                // Google's map listens below React's root, so a tap here would also reach the map
                // (closing the label before it can open the stop) unless the map is told to skip it.
                ref={(element) => {
                  if (element) google.maps.OverlayView.preventMapHitsAndGesturesFrom(element);
                }}
                role={onOpenStop ? 'button' : undefined}
                style={{
                  cursor: onOpenStop ? 'pointer' : 'default',
                  padding: '6px 12px',
                  borderRadius: 999,
                  background: '#FFFFFF',
                  boxShadow: '0 2px 8px rgba(22, 50, 79, 0.24)',
                  border: `2px solid ${color}`,
                  color: '#1F2937',
                  fontFamily: 'Nunito_800ExtraBold, Nunito, sans-serif',
                  fontSize: 13,
                  whiteSpace: 'nowrap',
                }}
              >
                {selectedStop.name}
                {onOpenStop ? <span style={{ marginLeft: 6, color }}>›</span> : null}
              </div>
            </OverlayViewF>
          ) : null}
          {entrances.map((entrance) => (
            <Marker
              key={`entrance-${entrance.lat},${entrance.lon}`}
              icon={entranceIcon(color)}
              position={{ lat: entrance.lat, lng: entrance.lon }}
              title={entranceLabel(entrance)}
              zIndex={2}
            />
          ))}
          {exploreFrom ? (
            <Marker
              clickable={false}
              icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 8.5, fillColor: colors.searchCenter, fillOpacity: 1, strokeColor: '#FFFFFF', strokeWeight: 3 }}
              position={{ lat: exploreFrom.latitude, lng: exploreFrom.longitude }}
              title="Exploring from here"
              zIndex={3}
            />
          ) : null}
          {userLocation ? <HeadingBeamMarker coordinate={userLocation} /> : null}
          {userLocation ? (
            // Same blue "you are here" dot as the home map.
            <Marker
              clickable={false}
              icon={{ path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: colors.location, fillOpacity: 1, strokeColor: '#FFFFFF', strokeWeight: 2 }}
              position={{ lat: userLocation.latitude, lng: userLocation.longitude }}
              title="Your location"
              zIndex={3}
            />
          ) : null}
          {arrow && (zoom || FOCUS_ZOOM) >= arrowZoom - ARROW_ZOOM_SLACK ? (
            // Which way the line runs, beside it just past the rider's stop (web maps stay north-up).
            <OverlayViewF getPixelPositionOffset={arrowOffset} mapPaneName={OVERLAY_LAYER} position={{ lat: arrow.point.lat, lng: arrow.point.lon }}>
              <View pointerEvents="none" style={{ width: DIRECTION_ARROW_BOX, height: DIRECTION_ARROW_BOX, transform: [{ rotate: `${arrow.bearing}deg` }] }} testID="route-direction-arrow">
                <DirectionArrow color={color} side={arrow.side} />
              </View>
            </OverlayViewF>
          ) : null}
          {shownVehicles.map((vehicle) => {
            const selected = vehicle.tripId === selectedVehicleId;
            return <WebVehicleMarker key={vehicle.tripId} color={color} now={now} onPosition={selected ? onSelectedVehiclePosition : undefined} onPress={onVehiclePress} selected={selected} title={vehicleLabel} vehicle={vehicle} zIndex={2} />;
          })}
        </GoogleMap>
      ) : null}
    </View>
  );
}
