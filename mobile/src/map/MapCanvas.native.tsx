import {
  Camera,
  GeoJSONSource,
  Images,
  Layer,
  Map,
  Marker,
  type CameraRef,
  type MapRef,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import { createContext, forwardRef, useContext, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type ComponentRef } from 'react';
import { StyleSheet, View, type NativeSyntheticEvent } from 'react-native';

import { useTheme } from '../theme/AppSettings';
import { SheetMapCredit } from './MapCredit';
import { sheetPaddingExtra, useSheetInset } from './mapSheetInset';
import { MAP_ICONS } from './mapIcons';
import { mapLandColor, overlaySlotId, pathlyMapStyle, STOP_LAYER_IDS } from './mapStyle';
import {
  boundsForMaxZoom,
  boundsOfPoints,
  fromMapLibreZoom,
  mapColor,
  toMapLibreZoom,
  walkDotRadius,
  walkDotZoom,
  walkingDots,
  mapStopOf,
  type MapCamera,
  type MapCanvasProps,
  type MapCanvasRef,
  type MapCirclesProps,
  type MapMarkerProps,
  type MapPoint,
  type MapPolylineProps,
} from './mapTypes';

/**
 * The map kit on iOS and Android (mapTypes.ts), drawn by MapLibre Native (an open-source renderer
 * compiled into the app, showing nothing of its own): Pathly's base map (mapStyle.ts), lines and
 * dots as GeoJSON layers slotted above it, and markers as live views.
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

/** The map's zoom (the app's scale, rounded for walking dots), followed as it changes. */
type ZoomStore = { get: () => number; set: (zoom: number) => void; subscribe: (listener: () => void) => () => void };

function createZoomStore(initial: number): ZoomStore {
  let zoom = walkDotZoom(initial);
  const listeners = new Set<() => void>();
  return {
    get: () => zoom,
    set: (next) => {
      const rounded = walkDotZoom(next);
      if (rounded === zoom) return;
      zoom = rounded;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const ZoomContext = createContext<ZoomStore | null>(null);
const NO_SUBSCRIPTION = () => () => undefined;

function useMapBearing(enabled: boolean): number {
  const store = useContext(BearingContext);
  return useSyncExternalStore(enabled && store ? store.subscribe : NO_SUBSCRIPTION, () => (enabled && store ? store.get() : 0));
}

const pointOf = ([longitude, latitude]: [number, number]): MapPoint => ({ latitude, longitude });

/** Taps within this many points of a stop's icon count as tapping it. */
const STOP_TAP_SLOP = 12;

/** The same camera, to well under a pixel. */
function sameCamera(a: MapCamera, b: MapCamera): boolean {
  return Math.abs(a.center.latitude - b.center.latitude) < 1e-7 && Math.abs(a.center.longitude - b.center.longitude) < 1e-7
    && Math.abs(a.zoom - b.zoom) < 1e-4 && Math.abs(a.bearing - b.bearing) < 0.01 && Math.abs(a.pitch - b.pitch) < 0.01;
}

function cameraOf(state: ViewStateChangeEvent): MapCamera {
  return { center: pointOf(state.center), zoom: fromMapLibreZoom(state.zoom), bearing: state.bearing, pitch: state.pitch };
}

export const MapCanvas = forwardRef<MapCanvasRef, MapCanvasProps>(function MapCanvas(
  { children, initialCamera, interactive = true, maxBounds, minZoom, onCameraIdle, onLongPress, onPress, onReady, onStopPress, onUserGesture, padding, testID },
  ref,
) {
  const { isDark, mapTheme, transitIcons } = useTheme();
  // As JSON, which is what the native map takes (and an unchanged theme sends nothing new).
  const mapStyle = useMemo(() => JSON.stringify(pathlyMapStyle(isDark, mapTheme, transitIcons)), [isDark, mapTheme, transitIcons]);
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);
  const viewRef = useRef<ComponentRef<typeof View>>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [bearingStore] = useState(() => createBearingStore(initialCamera.bearing ?? 0));
  const [zoomStore] = useState(() => createZoomStore(initialCamera.zoom));
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
    async pointForCoordinate(point) {
      const map = mapRef.current;
      const view = viewRef.current;
      if (!map || !view) return null;
      try {
        const [x, y] = await map.project([point.longitude, point.latitude]);
        return await new Promise<{ x: number; y: number }>((resolve) => {
          view.measureInWindow((left, top) => resolve({ x: left + x, y: top + y }));
        });
      } catch {
        return null;
      }
    },
  }), [size]);

  // A sheet over the map adds what it covers to the bottom padding, so the map never resizes and
  // its center stays in the middle of what's showing (mapSheetInset.ts).
  const sheetInset = useSheetInset();
  const covered = useSyncExternalStore(sheetInset?.subscribe ?? NO_SUBSCRIPTION, () => sheetInset?.get() ?? 0);
  const sheetExtra = sheetInset ? sheetPaddingExtra(covered, size.height, padding?.top ?? 0, padding?.bottom ?? 0) : 0;
  const contentInset = useMemo(
    () => (padding || sheetExtra > 0 ? { top: padding?.top ?? 0, right: padding?.right ?? 0, bottom: (padding?.bottom ?? 0) + sheetExtra, left: padding?.left ?? 0 } : undefined),
    [padding?.top, padding?.right, padding?.bottom, padding?.left, sheetExtra], // eslint-disable-line react-hooks/exhaustive-deps -- keyed by value
  );
  // The last camera reported, so a padding-only change (same camera) isn't reported as a move.
  const lastIdle = useRef<MapCamera | null>(null);

  return (
    <View
      collapsable={false}
      onLayout={(event) => setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
      ref={viewRef}
      style={[StyleSheet.absoluteFill, { backgroundColor: mapLandColor(isDark, mapTheme) }]}
      testID={testID}
    >
      <Map
        // No logo, and the map's credit is MapCredit below, in the app's own button style.
        attribution={false}
        compass={false}
        contentInset={contentInset}
        doubleTapHoldZoom={interactive}
        doubleTapZoom={interactive}
        dragPan={interactive}
        logo={false}
        mapStyle={mapStyle}
        onDidFinishLoadingMap={onReady ? () => onReady() : undefined}
        onLongPress={onLongPress ? (event) => onLongPress(pointOf(event.nativeEvent.lngLat)) : undefined}
        onPress={onPress || onStopPress ? (event) => {
          const lngLat = event.nativeEvent.lngLat;
          const [x, y] = event.nativeEvent.point;
          if (!onStopPress) {
            onPress?.(pointOf(lngLat));
            return;
          }
          // A station's or bus stop's icon on the base map (stations first), else the map itself.
          void mapRef.current?.queryRenderedFeatures([[x - STOP_TAP_SLOP, y - STOP_TAP_SLOP], [x + STOP_TAP_SLOP, y + STOP_TAP_SLOP]], { layers: STOP_LAYER_IDS })
            .then((features) => {
              const stops = features.map(mapStopOf).filter((stop): stop is NonNullable<typeof stop> => stop !== null);
              const stop = stops.find((candidate) => candidate.kind !== 'bus') ?? stops[0];
              if (stop) onStopPress(stop);
              else onPress?.(pointOf(lngLat));
            }, () => onPress?.(pointOf(lngLat)));
        } : undefined}
        onRegionDidChange={(event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
          bearingStore.set(event.nativeEvent.bearing);
          zoomStore.set(fromMapLibreZoom(event.nativeEvent.zoom));
          const userInteraction = event.nativeEvent.userInteraction || gesture.current;
          gesture.current = false;
          const camera = cameraOf(event.nativeEvent);
          const last = lastIdle.current;
          lastIdle.current = camera;
          if (!userInteraction && last && sameCamera(last, camera)) return;
          onCameraIdle?.({ ...camera, userInteraction });
        }}
        onRegionIsChanging={(event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
          bearingStore.set(event.nativeEvent.bearing);
          zoomStore.set(fromMapLibreZoom(event.nativeEvent.zoom));
        }}
        onRegionWillChange={(event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
          if (!event.nativeEvent.userInteraction) return;
          gesture.current = true;
          onUserGesture?.();
        }}
        ref={mapRef}
        // Flat and north-up: the map never turns or tilts.
        touchPitch={false}
        touchRotate={false}
        touchZoom={interactive}
      >
        <Images images={MAP_ICONS} />
        <Camera
          initialViewState={initialViewState}
          maxBounds={maxBounds ? [maxBounds.west, maxBounds.south, maxBounds.east, maxBounds.north] : undefined}
          minZoom={minZoom !== undefined ? toMapLibreZoom(minZoom) : undefined}
          ref={cameraRef}
        />
        <BearingContext.Provider value={bearingStore}><ZoomContext.Provider value={zoomStore}>{children}</ZoomContext.Provider></BearingContext.Provider>
      </Map>
      <SheetMapCredit bottomInset={padding?.bottom ?? 0} />
    </View>
  );
});

/** A line in Pathly's own colors over the base map; a dotted one (a walk) is drawn as round dots. */
export function MapPolyline(props: MapPolylineProps) {
  return props.dotted ? <WalkDots {...props} /> : <SolidLine {...props} />;
}

function SolidLine({ id, coordinates, color, width, opacity = 1, zIndex = 0, testID }: MapPolylineProps) {
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
        paint={{ 'line-color': mapColor(color), 'line-width': width, 'line-opacity': opacity }}
        type="line"
      />
    </GeoJSONSource>
  );
}

/** A walk: round dots a fixed size and distance apart on screen (mapTypes.ts walkingDots), laid out again as the map zooms. */
function WalkDots({ id, coordinates, color, width, opacity = 1, zIndex = 0, testID }: MapPolylineProps) {
  const store = useContext(ZoomContext);
  const zoom = useSyncExternalStore(store ? store.subscribe : NO_SUBSCRIPTION, () => (store ? store.get() : 14));
  const data = useMemo(() => walkingDots(coordinates, zoom), [coordinates, zoom]);
  if (coordinates.length < 2) return null;
  return (
    <GeoJSONSource data={data} id={`${id}-source`} testID={testID}>
      <Layer
        beforeId={overlaySlotId(zIndex + 1)}
        id={id}
        paint={{ 'circle-color': mapColor(color), 'circle-radius': walkDotRadius(width), 'circle-opacity': opacity }}
        type="circle"
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
