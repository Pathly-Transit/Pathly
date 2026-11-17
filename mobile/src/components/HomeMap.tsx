import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { MapLine } from '../data/lineLayers';
import { addressAfterName } from '../data/placesSearch';
import { themedRouteColor } from '../data/routeColors';
import { metersPerPixelAtZoom, SAVED_PIN, savedPlaceColor, stackSavedPins } from '../data/savedPlacePin';
import { MAP_EXPLORATION_BOUNDS } from '../data/serviceArea';
import { zoomForRegion } from '../data/stopDeclutter';
import { locationPoint, savedPlaceName, type SavedLocation } from '../data/userData';
import type { Coordinates } from '../hooks/useCurrentLocation';
import { MapCanvas, MapMarker, MapPolyline } from '../map/MapCanvas';
import type { MapCameraChange, MapCanvasRef } from '../map/mapTypes';
import { useTheme } from '../theme/AppSettings';
import { CurrentLocationMarker } from './CurrentLocationMarker';
import { HeadingBeamMarker } from './HeadingBeamMarker';
import { Icon, type IconName } from './Icon';
import { savedLocationIcon } from './SavedPlacesStrip';

/**
 * A saved place's map marker: its icon centered in a round badge right on the place, in the
 * place's color. A marker stacked under another leaves its icon off.
 */
function SavedPlacePin({ color, icon }: { color: string; icon: IconName | null }) {
  const { colors } = useTheme();
  return (
    <View style={[pinStyles.badge, { backgroundColor: color, borderColor: colors.savedPlaceBorder }]}>
      {icon ? <Icon color={colors.ring} name={icon} size={16} /> : null}
    </View>
  );
}

const pinStyles = StyleSheet.create({
  badge: { width: SAVED_PIN.size, height: SAVED_PIN.size, alignItems: 'center', justifyContent: 'center', borderRadius: SAVED_PIN.size / 2, borderWidth: 2.5 },
});

/** Where the map opens with no camera to restore: around the rider at street-and-neighborhood scale. */
const HOME_ZOOM = 14;
const MIN_ZOOM = 8;
const RECENTER_MS = 400;
/** Within this many degrees of north-up and flat, the map counts as oriented. */
const ORIENTED_TOLERANCE_DEGREES = 2;
const REORIENT_MS = 300;

/**
 * Where the home map's camera rests, so it can be restored when the map is rebuilt (returning from
 * a route). Older resting cameras carried a region span instead of a zoom.
 */
export type HomeMapCamera = { latitude: number; longitude: number; latitudeDelta?: number; longitudeDelta?: number; zoom?: number };

type Padding = { bottom?: number; left?: number; right?: number; top?: number };

export type MapOrientation = { heading: number; rotated: boolean };

type HomeMapProps = {
  /** Camera to open on instead of the rider's location (e.g. where they had panned before). */
  initialCamera?: HomeMapCamera | null;
  location: Coordinates;
  /** Every time the map comes to rest, wherever it is. */
  onCameraChange?: (camera: HomeMapCamera) => void;
  onUserPan?: () => void;
  /** After the rider pans the map and it comes to rest: the center of the visible (padded) area. */
  onUserMoveEnd?: (center: Coordinates) => void;
  /** The parts of the map under the app's own header or sheet: centering and searching use what's left. */
  padding?: Padding;
  /** Incremented to center the map on `location`; later GPS updates alone never move the map. */
  recenterRequest?: number;
  /** After the map comes to rest: its heading (degrees clockwise from north) and whether it's off north-up/flat. */
  onOrientationChange?: (orientation: MapOrientation) => void;
  /** Incremented to turn the map back to north-up and flat, keeping its center and zoom. */
  reorientRequest?: number;
  /** A tap on the map (admin: show its coordinates). */
  onPress?: (point: Coordinates) => void;
  /** A long press (or right-click) on the map (admin: choose a mock location). */
  onLongPress?: (point: Coordinates) => void;
  /** Saved destinations with valid coordinates, drawn as tappable pins. */
  savedLocations?: readonly SavedLocation[];
  /** Transit lines the rider switched on, drawn under everything else. */
  lines?: readonly MapLine[];
  /** A marker tapped: its place, and every place stacked with it there (itself included). */
  onSavedLocationPress?: (location: SavedLocation, stack: readonly SavedLocation[]) => void;
  /** `location` is a real fix (not the service-area fallback), so the rider's dot is drawn there. */
  locationKnown?: boolean;
  /** `location` is an admin's mock location (always drawn). */
  simulatedLocation?: boolean;
  testID?: string;
};

/** The zoom a restored camera opens at: its own, or (an older camera) its span's. */
function cameraZoom(camera: HomeMapCamera, widthPx: number): number {
  if (camera.zoom !== undefined) return camera.zoom;
  return camera.longitudeDelta ? zoomForRegion(camera.longitudeDelta, widthPx) : HOME_ZOOM;
}

/** The home map: the rider and their surroundings, the lines they switched on, and their saved places. */
export function HomeMap({
  initialCamera,
  lines = [],
  location,
  onCameraChange,
  onLongPress,
  onOrientationChange,
  onPress,
  onSavedLocationPress,
  onUserMoveEnd,
  onUserPan,
  padding,
  recenterRequest = 0,
  reorientRequest = 0,
  savedLocations = [],
  locationKnown = false,
  simulatedLocation = false,
  testID = 'home-map',
}: HomeMapProps) {
  const mapRef = useRef<MapCanvasRef>(null);
  const { colors, isDark } = useTheme();
  const [openedOn] = useState(() => (initialCamera
    ? { center: { latitude: initialCamera.latitude, longitude: initialCamera.longitude }, zoom: cameraZoom(initialCamera, 390) }
    : { center: { latitude: location.latitude, longitude: location.longitude }, zoom: HOME_ZOOM }));
  // Followed so saved-place pins can stack once zooming out would make them collide.
  const [zoom, setZoom] = useState(openedOn.zoom);

  // Re-centers only on a new request (the first GPS fix and the location button), so a rider who
  // has panned away isn't pulled back by routine GPS updates, and a rebuilt map keeps its camera.
  const handledRecenterRequest = useRef(recenterRequest);
  useEffect(() => {
    if (recenterRequest === handledRecenterRequest.current) return;
    handledRecenterRequest.current = recenterRequest;
    mapRef.current?.easeTo({ center: { latitude: location.latitude, longitude: location.longitude }, zoom: Math.max(zoom, HOME_ZOOM), durationMs: RECENTER_MS });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the request only; `location` is read at request time
  }, [recenterRequest]);

  const handledReorientRequest = useRef(reorientRequest);
  useEffect(() => {
    if (reorientRequest === handledReorientRequest.current) return;
    handledReorientRequest.current = reorientRequest;
    mapRef.current?.easeTo({ bearing: 0, pitch: 0, durationMs: REORIENT_MS });
  }, [reorientRequest]);

  const onCameraIdle = useCallback(({ center, zoom: restingZoom, bearing, pitch, userInteraction }: MapCameraChange) => {
    setZoom(restingZoom);
    onCameraChange?.({ latitude: center.latitude, longitude: center.longitude, zoom: restingZoom });
    if (onOrientationChange) {
      const heading = ((bearing % 360) + 360) % 360;
      const offNorth = Math.min(heading, 360 - heading);
      onOrientationChange({ heading, rotated: offNorth > ORIENTED_TOLERANCE_DEGREES || pitch > ORIENTED_TOLERANCE_DEGREES });
    }
    // The center is the visible (padded) area's: where Nearby searches around.
    if (userInteraction) onUserMoveEnd?.(center);
  }, [onCameraChange, onOrientationChange, onUserMoveEnd]);

  // Pins that would collide at this zoom are stacked at one spot (see stackSavedPins).
  const savedPins = useMemo(() => {
    const placed = savedLocations.flatMap((saved) => {
      const point = locationPoint(saved.address);
      return point ? [{ saved, point }] : [];
    });
    const stacks = stackSavedPins(placed.map(({ point }) => point), metersPerPixelAtZoom(zoom, placed[0]?.point.latitude ?? location.latitude));
    return placed.map((pin, index) => ({ ...pin, ...stacks[index]! }));
  }, [savedLocations, zoom, location.latitude]);
  // Stacked pins draw under their stack's leader.
  const orderedPins = useMemo(() => [...savedPins].sort((a, b) => Number(a.leader) - Number(b.leader)), [savedPins]);
  const showRider = simulatedLocation || locationKnown;

  return (
    <MapCanvas
      initialCamera={openedOn}
      maxBounds={MAP_EXPLORATION_BOUNDS}
      minZoom={MIN_ZOOM}
      onCameraIdle={onCameraIdle}
      onLongPress={onLongPress}
      onPress={onPress}
      onUserGesture={onUserPan}
      padding={padding}
      ref={mapRef}
      testID={testID}
    >
      {lines.map((line) => (
        <MapPolyline
          color={themedRouteColor(line.color, isDark)}
          coordinates={line.path}
          id={`home-line-${line.key}`}
          key={line.key}
          opacity={0.9}
          testID={`map-line-${line.key}`}
          width={3}
          zIndex={0}
        />
      ))}
      {showRider ? <HeadingBeamMarker coordinate={location} /> : null}
      {orderedPins.map(({ saved, position: pinPosition, leader }) => {
        const name = savedPlaceName(saved.address);
        const address = addressAfterName(name, saved.address.streetAddress);
        return (
          <MapMarker
            accessibilityLabel={address ? `Plan a trip to ${name}, ${address}` : `Plan a trip to ${name}`}
            coordinate={pinPosition}
            key={saved.id}
            onPress={onSavedLocationPress ? () => onSavedLocationPress(saved, savedPins.filter((pin) => pin.position === pinPosition).map((pin) => pin.saved)) : undefined}
            testID={`saved-place-marker-${saved.id}`}
            zIndex={leader ? 2 : 1}
          >
            <SavedPlacePin color={savedPlaceColor(saved.address, colors.primary)} icon={leader ? savedLocationIcon(saved.address) : null} />
          </MapMarker>
        );
      })}
      {showRider ? (
        <MapMarker coordinate={location} testID={simulatedLocation ? 'mock-location-marker' : `${testID}-user-location`} zIndex={5}>
          <CurrentLocationMarker />
        </MapMarker>
      ) : null}
    </MapCanvas>
  );
}
