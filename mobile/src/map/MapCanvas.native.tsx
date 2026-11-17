import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
  type CameraRef,
  type MapRef,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import { createContext, forwardRef, useContext, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View, type NativeSyntheticEvent } from 'react-native';

import { useTheme } from '../theme/AppSettings';
import { mapLandColor, overlaySlotId, pathlyMapStyle } from './mapStyle';
import {
  boundsForMaxZoom,
  boundsOfPoints,
  fromMapLibreZoom,
  mapColor,
  toMapLibreZoom,
  type MapCamera,
  type MapCanvasProps,
  type MapCanvasRef,
  type MapCirclesProps,
  type MapMarkerProps,
  type MapPoint,
  type MapPolylineProps,
} from './mapTypes';

/**
 * The map kit on iOS and Android (mapTypes.ts), drawn by MapLibre Native: the base map, lines and
 * dots as GeoJSON layers slotted above it (mapStyle.ts's overlay slots), and markers as live views.
 */

/** The map's bearing, for markers turned to the ground; only those markers re-render as it turns. */
type BearingStore = { get: () => number; set: (bearing: number) => void; subscribe: (listener: () => void) => () => void };

function createBearingStore(initial: number): BearingStore {
  let bearing = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => bearing,
    set: (next) => {
      // A degree is as fine as a turned marker needs.
      const rounded = Math.round(next);
      if (rounded === bearing) return;
      bearing = rounded;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const BearingContext = createContext<BearingStore | null>(null);
const NO_SUBSCRIPTION = () => () => undefined;

function useMapBearing(enabled: boolean): number {
  const store = useContext(BearingContext);
  return useSyncExternalStore(enabled && store ? store.subscribe : NO_SUBSCRIPTION, () => (enabled && store ? store.get() : 0));
}

const pointOf = ([longitude, latitude]: [number, number]): MapPoint => ({ latitude, longitude });

function cameraOf(state: ViewStateChangeEvent): MapCamera {
  return { center: pointOf(state.center), zoom: fromMapLibreZoom(state.zoom), bearing: state.bearing, pitch: state.pitch };
}

export const MapCanvas = forwardRef<MapCanvasRef, MapCanvasProps>(function MapCanvas(
  { children, initialCamera, interactive = true, maxBounds, minZoom, onCameraIdle, onLongPress, onPress, onReady, onUserGesture, padding, pitchEnabled = true, rotateEnabled = true, testID },
  ref,
) {
  const { colors, isDark } = useTheme();
  // As JSON, which is what the native map takes (and an unchanged theme sends nothing new).
  const mapStyle = useMemo(() => JSON.stringify(pathlyMapStyle(isDark)), [isDark]);
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [bearingStore] = useState(() => createBearingStore(initialCamera.bearing ?? 0));
  // A gesture that started a move, so its end is reported as the rider's.
  const gesture = useRef(false);
  const [initialViewState] = useState(() => ({
    center: [initialCamera.center.longitude, initialCamera.center.latitude] as [number, number],
    zoom: toMapLibreZoom(initialCamera.zoom),
    bearing: initialCamera.bearing ?? 0,
    pitch: initialCamera.pitch ?? 0,
  }));

  useImperativeHandle(ref, () => ({
    easeTo({ center, zoom, bearing, pitch, durationMs = 300 }) {
      const camera = cameraRef.current;
      if (!camera) return;
      const options = {
        ...(zoom !== undefined ? { zoom: toMapLibreZoom(zoom) } : {}),
        ...(bearing !== undefined ? { bearing } : {}),
        ...(pitch !== undefined ? { pitch } : {}),
        duration: durationMs,
      };
      if (center) {
        if (durationMs === 0) camera.jumpTo({ center: [center.longitude, center.latitude], ...options });
        else camera.easeTo({ center: [center.longitude, center.latitude], ...options, easing: 'ease' });
      } else {
        void camera.setStop({ ...options, easing: 'ease' }).catch(() => undefined);
      }
    },
    fitPoints(points, { padding: fitPadding, durationMs = 0, maxZoom } = {}) {
      if (points.length === 0 || !cameraRef.current) return;
      let bounds = boundsOfPoints(points);
      if (maxZoom !== undefined) bounds = boundsForMaxZoom(bounds, maxZoom, size, fitPadding);
      cameraRef.current.fitBounds(bounds, { ...(fitPadding ? { padding: fitPadding } : {}), duration: durationMs });
    },
    async getCamera() {
      try {
        const state = await mapRef.current?.getViewState();
        return state ? { center: pointOf(state.center), zoom: fromMapLibreZoom(state.zoom), bearing: state.bearing, pitch: state.pitch } : null;
      } catch {
        return null;
      }
    },
  }), [size]);

  const contentInset = useMemo(
    () => (padding ? { top: padding.top ?? 0, right: padding.right ?? 0, bottom: padding.bottom ?? 0, left: padding.left ?? 0 } : undefined),
    [padding?.top, padding?.right, padding?.bottom, padding?.left], // eslint-disable-line react-hooks/exhaustive-deps -- keyed by value
  );

  return (
    <View
      onLayout={(event) => setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
      style={[StyleSheet.absoluteFill, { backgroundColor: mapLandColor(isDark) }]}
      testID={testID}
    >
      <Map
        attribution={true}
        compass={false}
        contentInset={contentInset}
        doubleTapHoldZoom={interactive}
        doubleTapZoom={interactive}
        dragPan={interactive}
        logo={false}
        mapStyle={mapStyle}
        onDidFinishLoadingMap={onReady ? () => onReady() : undefined}
        onLongPress={onLongPress ? (event) => onLongPress(pointOf(event.nativeEvent.lngLat)) : undefined}
        onPress={onPress ? (event) => onPress(pointOf(event.nativeEvent.lngLat)) : undefined}
        onRegionDidChange={(event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
          bearingStore.set(event.nativeEvent.bearing);
          const userInteraction = event.nativeEvent.userInteraction || gesture.current;
          gesture.current = false;
          onCameraIdle?.({ ...cameraOf(event.nativeEvent), userInteraction });
        }}
        onRegionIsChanging={(event: NativeSyntheticEvent<ViewStateChangeEvent>) => bearingStore.set(event.nativeEvent.bearing)}
        onRegionWillChange={(event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
          if (!event.nativeEvent.userInteraction) return;
          gesture.current = true;
          onUserGesture?.();
        }}
        ref={mapRef}
        tintColor={colors.mutedInk}
        touchPitch={interactive && pitchEnabled}
        touchRotate={interactive && rotateEnabled}
        touchZoom={interactive}
      >
        <Camera
          initialViewState={initialViewState}
          maxBounds={maxBounds ? [maxBounds.west, maxBounds.south, maxBounds.east, maxBounds.north] : undefined}
          minZoom={minZoom !== undefined ? toMapLibreZoom(minZoom) : undefined}
          ref={cameraRef}
        />
        <BearingContext.Provider value={bearingStore}>{children}</BearingContext.Provider>
      </Map>
    </View>
  );
});

/** A line in Pathly's own colors over the base map. */
export function MapPolyline({ id, coordinates, color, width, opacity = 1, dotted = false, zIndex = 0, testID }: MapPolylineProps) {
  const data = useMemo<GeoJSON.Feature>(() => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coordinates.map((point) => [point.longitude, point.latitude]) },
  }), [coordinates]);
  if (coordinates.length < 2) return null;
  return (
    <GeoJSONSource data={data} id={`${id}-source`} testID={testID}>
      <Layer
        beforeId={overlaySlotId(zIndex + 1)}
        id={id}
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        // Dots: zero-length dashes with round caps, a dot's width apart.
        paint={{ 'line-color': mapColor(color), 'line-width': width, 'line-opacity': opacity, ...(dotted ? { 'line-dasharray': [0, 2] } : {}) }}
        type="line"
      />
    </GeoJSONSource>
  );
}

/** Round dots (stops), drawn on the map itself so hundreds cost nothing; tappable by key. */
export function MapCircles({ id, circles, zIndex = 0, onPress, testID }: MapCirclesProps) {
  const data = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: circles.map((circle) => ({
      type: 'Feature',
      properties: {
        key: circle.key,
        radius: Math.max(0, circle.radius - (circle.strokeWidth ?? 0)),
        color: mapColor(circle.color),
        strokeColor: mapColor(circle.strokeColor ?? circle.color),
        strokeWidth: circle.strokeWidth ?? 0,
        opacity: circle.opacity ?? 1,
        sortKey: circle.sortKey ?? 0,
      },
      geometry: { type: 'Point', coordinates: [circle.coordinate.longitude, circle.coordinate.latitude] },
    })),
  }), [circles]);
  if (circles.length === 0) return null;
  return (
    <GeoJSONSource
      data={data}
      hitbox={{ top: 10, right: 10, bottom: 10, left: 10 }}
      id={`${id}-source`}
      onPress={onPress ? (event) => {
        const key = event.nativeEvent.features[0]?.properties?.key;
        if (typeof key !== 'string') return;
        event.stopPropagation();
        onPress(key);
      } : undefined}
      testID={testID}
    >
      <Layer
        beforeId={overlaySlotId(zIndex + 1)}
        id={id}
        layout={{ 'circle-sort-key': ['get', 'sortKey'] }}
        paint={{
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': ['get', 'strokeColor'],
          'circle-stroke-width': ['get', 'strokeWidth'],
          'circle-opacity': ['get', 'opacity'],
          'circle-stroke-opacity': ['get', 'opacity'],
          'circle-pitch-alignment': 'map',
        }}
        type="circle"
      />
    </GeoJSONSource>
  );
}

/**
 * A view standing on the map at a point. MapLibre Native draws markers in the order they're
 * rendered, so maps render theirs lowest first (`zIndex` orders them on the web).
 */
export function MapMarker({ accessibilityLabel, anchor = 'center', children, coordinate, offset, onPress, rotation, testID }: MapMarkerProps) {
  const bearing = useMapBearing(rotation !== undefined);
  return (
    <Marker
      accessibilityLabel={accessibilityLabel}
      anchor={anchor}
      lngLat={[coordinate.longitude, coordinate.latitude]}
      offset={offset}
      onPress={onPress ? () => onPress() : undefined}
      testID={testID}
    >
      {rotation === undefined ? children : <View style={{ transform: [{ rotate: `${rotation - bearing}deg` }] }}>{children}</View>}
    </Marker>
  );
}
