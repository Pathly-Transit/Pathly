import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/AppSettings';
import { sheetPaddingExtra, useSheetInset } from './mapSheetInset';
import { WEB_ICON_PIXEL_RATIO, WEB_MAP_ICONS } from './mapIcons';
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
  type MapCanvasProps,
  type MapCanvasRef,
  type MapCirclesProps,
  type MapMarkerProps,
  type MapPoint,
  type MapPolylineProps,
} from './mapTypes';

/**
 * The map kit in the browser (mapTypes.ts), drawn by MapLibre GL JS (open-source rendering code
 * bundled with the app, showing nothing of its own): Pathly's base map (mapStyle.ts), lines and
 * dots as GeoJSON layers slotted above it, and markers as the app's own views placed over the map.
 */

/** Taps within this many px of a dot count as tapping it (fingers are wider than dots). */
const TAP_SLOP_PX = 10;
const LONG_PRESS_MS = 600;

type TapTarget = { layerId: string; onPress: (key: string) => void };

type MapContextValue = {
  map: maplibregl.Map;
  /** Bumped each time a style finishes loading (the theme changed): lines and dots add themselves again. */
  styleKey: number;
  tapTargets: Map<string, TapTarget>;
};

const MapContext = createContext<MapContextValue | null>(null);

const lngLatOf = (point: MapPoint): [number, number] => [point.longitude, point.latitude];
const pointOf = (lngLat: { lng: number; lat: number }): MapPoint => ({ latitude: lngLat.lat, longitude: lngLat.lng });

/** A bundled image's URL (the web bundler gives a URL, or an object holding one). */
function assetUri(source: unknown): string | undefined {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object') {
    const value = source as { uri?: unknown; default?: unknown };
    if (typeof value.uri === 'string') return value.uri;
    if (value.default !== undefined) return assetUri(value.default);
  }
  return undefined;
}

/** The base map's icons, loaded once per page and shared by every map. */
const iconImages = new Map<string, Promise<HTMLImageElement>>();
function loadIcon(name: string): Promise<HTMLImageElement> | undefined {
  const uri = assetUri(WEB_MAP_ICONS[name]);
  if (!uri) return undefined;
  let image = iconImages.get(name);
  if (!image) {
    image = new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = reject;
      element.src = uri;
    });
    iconImages.set(name, image);
  }
  return image;
}

/** Removes a layer and its source, if the map (and its current style) still has them. */
function removeOverlay(map: maplibregl.Map, layerId: string, sourceId: string) {
  try {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  } catch {
    // The map itself was removed first.
  }
}

export const MapCanvas = forwardRef<MapCanvasRef, MapCanvasProps>(function MapCanvas(
  { children, initialCamera, interactive = true, maxBounds, minZoom, onCameraIdle, onLongPress, onPress, onReady, onStopPress, onUserGesture, padding, pitchEnabled = true, rotateEnabled = true, testID },
  ref,
) {
  const { isDark, mapTheme, transitIcons } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [styleKey, setStyleKey] = useState(0);
  const [tapTargets] = useState(() => new Map<string, TapTarget>());
  // The latest props, for the map's own event handlers (bound once).
  const latest = useRef({ onCameraIdle, onLongPress, onPress, onStopPress, onUserGesture, maxBounds });
  useLayoutEffect(() => {
    latest.current = { onCameraIdle, onLongPress, onPress, onStopPress, onUserGesture, maxBounds };
  });
  const themeAtCreation = useRef({ isDark, mapTheme, transitIcons });
  // Set while the sheet's padding is applied: that move isn't the camera's own.
  const paddingMove = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const instance = new maplibregl.Map({
      container,
      style: pathlyMapStyle(themeAtCreation.current.isDark, themeAtCreation.current.mapTheme, themeAtCreation.current.transitIcons) as maplibregl.StyleSpecification,
      center: lngLatOf(initialCamera.center),
      zoom: toMapLibreZoom(initialCamera.zoom),
      bearing: initialCamera.bearing ?? 0,
      pitch: initialCamera.pitch ?? 0,
      ...(minZoom !== undefined ? { minZoom: toMapLibreZoom(minZoom) } : {}),
      // No attribution: the base map's sources ask no credit on the map (Settings → About lists them).
      attributionControl: false,
      interactive,
      dragRotate: interactive && rotateEnabled,
      pitchWithRotate: interactive && rotateEnabled && pitchEnabled,
      touchPitch: interactive && pitchEnabled,
    });
    if (!rotateEnabled) instance.touchZoomRotate.disableRotation();
    // Keyboard arrows would also scroll the page around the map.
    instance.keyboard.disable();

    let gesture = false;
    let longPress: ReturnType<typeof setTimeout> | null = null;
    const cancelLongPress = () => {
      if (longPress) clearTimeout(longPress);
      longPress = null;
    };
    instance.on('style.load', () => setStyleKey((key) => key + 1));
    // The style's icons (transit stops), added as the map asks for them (each new style asks again).
    instance.on('styleimagemissing', ({ id }: { id: string }) => {
      void loadIcon(id)?.then((image) => {
        if (!instance.hasImage(id)) instance.addImage(id, image, { pixelRatio: WEB_ICON_PIXEL_RATIO });
      }).catch(() => undefined);
    });
    instance.once('load', () => {
      setMap(instance);
      onReady?.();
    });
    instance.on('movestart', (event) => {
      if (paddingMove.current) return;
      cancelLongPress();
      if (!(event as { originalEvent?: unknown }).originalEvent) return;
      gesture = true;
      latest.current.onUserGesture?.();
    });
    instance.on('moveend', () => {
      if (paddingMove.current) return;
      const center = instance.getCenter();
      // Like the native map: the center stays within the bounds, gliding back after a pan beyond them.
      const bounds = latest.current.maxBounds;
      if (bounds) {
        const lat = Math.min(Math.max(center.lat, bounds.south), bounds.north);
        const lng = Math.min(Math.max(center.lng, bounds.west), bounds.east);
        if (lat !== center.lat || lng !== center.lng) {
          instance.easeTo({ center: [lng, lat], duration: 250 });
          return;
        }
      }
      const userInteraction = gesture;
      gesture = false;
      latest.current.onCameraIdle?.({ center: pointOf(center), zoom: fromMapLibreZoom(instance.getZoom()), bearing: instance.getBearing(), pitch: instance.getPitch(), userInteraction });
    });
    instance.on('click', (event) => {
      // A dot within reach of the tap takes it; otherwise the map does.
      for (const target of tapTargets.values()) {
        if (!instance.getLayer(target.layerId)) continue;
        const { x, y } = event.point;
        const features = instance.queryRenderedFeatures([[x - TAP_SLOP_PX, y - TAP_SLOP_PX], [x + TAP_SLOP_PX, y + TAP_SLOP_PX]], { layers: [target.layerId] });
        const key = features[0]?.properties?.key;
        if (typeof key === 'string') {
          target.onPress(key);
          return;
        }
      }
      // A station's or bus stop's icon on the base map.
      if (latest.current.onStopPress) {
        const { x, y } = event.point;
        const layers = STOP_LAYER_IDS.filter((id) => instance.getLayer(id));
        const features = layers.length ? instance.queryRenderedFeatures([[x - TAP_SLOP_PX, y - TAP_SLOP_PX], [x + TAP_SLOP_PX, y + TAP_SLOP_PX]], { layers }) : [];
        const stops = features.map(mapStopOf).filter((stop): stop is NonNullable<typeof stop> => stop !== null);
        // A station before a bus stop; otherwise the stop nearest the tap.
        const away = (stop: NonNullable<ReturnType<typeof mapStopOf>>) => {
          const at = instance.project(lngLatOf(stop.coordinate));
          return Math.hypot(at.x - x, at.y - y);
        };
        const stop = stops.find((candidate) => candidate.kind !== 'bus') ?? [...stops].sort((a, b) => away(a) - away(b))[0];
        if (stop) {
          latest.current.onStopPress(stop);
          return;
        }
      }
      latest.current.onPress?.(pointOf(event.lngLat));
    });
    // A long press: right-click, or a press held still.
    instance.on('contextmenu', (event) => latest.current.onLongPress?.(pointOf(event.lngLat)));
    const startLongPress = (event: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      cancelLongPress();
      if (!latest.current.onLongPress) return;
      const point = pointOf(event.lngLat);
      longPress = setTimeout(() => latest.current.onLongPress?.(point), LONG_PRESS_MS);
    };
    instance.on('mousedown', startLongPress);
    instance.on('touchstart', startLongPress);
    for (const type of ['mouseup', 'touchend', 'touchcancel', 'touchmove', 'dragstart'] as const) instance.on(type, cancelLongPress);
    return () => {
      cancelLongPress();
      setMap(null);
      instance.remove();
    };
    // The map is built once; later prop changes are applied to it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The theme's style; lines and dots re-add themselves once it has loaded (styleKey).
  useEffect(() => {
    const current = themeAtCreation.current;
    if (!map || (isDark === current.isDark && mapTheme === current.mapTheme && transitIcons === current.transitIcons)) return;
    themeAtCreation.current = { isDark, mapTheme, transitIcons };
    map.setStyle(pathlyMapStyle(isDark, mapTheme, transitIcons) as maplibregl.StyleSpecification, { diff: false });
  }, [isDark, map, mapTheme, transitIcons]);

  const paddingKey = `${padding?.top ?? 0},${padding?.right ?? 0},${padding?.bottom ?? 0},${padding?.left ?? 0}`;
  // A sheet over the map adds what it covers to the bottom padding, so the map never resizes and
  // its center stays in the middle of what's showing (mapSheetInset.ts).
  const sheetInset = useSheetInset();
  useEffect(() => {
    if (!map) return undefined;
    const base = { top: padding?.top ?? 0, right: padding?.right ?? 0, bottom: padding?.bottom ?? 0, left: padding?.left ?? 0 };
    let applied = -1;
    const apply = (covered: number) => {
      const extra = sheetPaddingExtra(covered, map.getContainer().clientHeight, base.top, base.bottom);
      if (extra === applied) return;
      applied = extra;
      // Only the padding changes; the camera's own listeners shouldn't hear it as a move.
      paddingMove.current = true;
      map.setPadding({ ...base, bottom: base.bottom + extra });
      paddingMove.current = false;
    };
    apply(sheetInset?.get() ?? 0);
    return sheetInset?.subscribe(apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by value
  }, [map, paddingKey, sheetInset]);

  useImperativeHandle(ref, () => ({
    easeTo({ center, zoom, bearing, pitch, durationMs = 300 }) {
      if (!map) return;
      const options = {
        ...(center ? { center: lngLatOf(center) } : {}),
        ...(zoom !== undefined ? { zoom: toMapLibreZoom(zoom) } : {}),
        ...(bearing !== undefined ? { bearing } : {}),
        ...(pitch !== undefined ? { pitch } : {}),
      };
      if (durationMs === 0) map.jumpTo(options);
      else map.easeTo({ ...options, duration: durationMs });
    },
    fitPoints(points, { padding: fitPadding = {}, durationMs = 0, maxZoom } = {}) {
      if (!map || points.length === 0) return;
      const container = map.getContainer();
      let bounds = boundsOfPoints(points);
      if (maxZoom !== undefined) bounds = boundsForMaxZoom(bounds, maxZoom, { width: container.clientWidth, height: container.clientHeight }, fitPadding);
      map.fitBounds(bounds, {
        padding: { top: fitPadding.top ?? 0, right: fitPadding.right ?? 0, bottom: fitPadding.bottom ?? 0, left: fitPadding.left ?? 0 },
        duration: durationMs,
        ...(maxZoom !== undefined ? { maxZoom: toMapLibreZoom(maxZoom) } : {}),
      });
    },
    async getCamera() {
      if (!map) return null;
      return { center: pointOf(map.getCenter()), zoom: fromMapLibreZoom(map.getZoom()), bearing: map.getBearing(), pitch: map.getPitch() };
    },
    async pointForCoordinate(point) {
      if (!map) return null;
      const { x, y } = map.project(lngLatOf(point));
      const box = map.getContainer().getBoundingClientRect();
      return { x: box.left + x, y: box.top + y };
    },
  }), [map]);

  const context = useMemo(() => (map ? { map, styleKey, tapTargets } : null), [map, styleKey, tapTargets]);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: mapLandColor(isDark, mapTheme) }]} testID={testID}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {context ? <MapContext.Provider value={context}>{children}</MapContext.Provider> : null}
    </View>
  );
});

/** A line in Pathly's own colors over the base map; a dotted one (a walk) is drawn as round dots. */
export function MapPolyline(props: MapPolylineProps) {
  return props.dotted ? <WalkDots {...props} /> : <SolidLine {...props} />;
}

function SolidLine({ id, coordinates, color, width, opacity = 1, zIndex = 0 }: MapPolylineProps) {
  const context = useContext(MapContext);
  const sourceId = `${id}-source`;
  const data = useMemo<GeoJSON.Feature>(() => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coordinates.map((point) => [point.longitude, point.latitude]) },
  }), [coordinates]);
  const map = context?.map;
  const styleKey = context?.styleKey;
  const latestData = useRef(data);
  useLayoutEffect(() => {
    latestData.current = data;
  });

  useEffect(() => {
    if (!map) return undefined;
    map.addSource(sourceId, { type: 'geojson', data: latestData.current });
    map.addLayer({ id, type: 'line', source: sourceId, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {} }, overlaySlotId(zIndex + 1));
    return () => removeOverlay(map, id, sourceId);
  }, [id, map, sourceId, styleKey, zIndex]);

  useEffect(() => {
    (map?.getSource(sourceId) as maplibregl.GeoJSONSource | undefined)?.setData(data);
  }, [data, map, sourceId, styleKey]);

  useEffect(() => {
    if (!map?.getLayer(id)) return;
    map.setPaintProperty(id, 'line-color', mapColor(color));
    map.setPaintProperty(id, 'line-width', width);
    map.setPaintProperty(id, 'line-opacity', opacity);
  }, [color, id, map, opacity, styleKey, width, zIndex]);
  return null;
}

/** A walk: round dots a fixed size and distance apart on screen (mapTypes.ts walkingDots), laid out again as the map zooms. */
function WalkDots({ id, coordinates, color, width, opacity = 1, zIndex = 0 }: MapPolylineProps) {
  const context = useContext(MapContext);
  const sourceId = `${id}-source`;
  const map = context?.map;
  const styleKey = context?.styleKey;
  const [zoom, setZoom] = useState(() => (map ? walkDotZoom(fromMapLibreZoom(map.getZoom())) : 14));
  const data = useMemo(() => walkingDots(coordinates, zoom), [coordinates, zoom]);
  const latestData = useRef(data);
  useLayoutEffect(() => {
    latestData.current = data;
  });

  // Every frame of a zoom, like Google's repeated dots.
  useEffect(() => {
    if (!map) return undefined;
    const onZoom = () => setZoom(walkDotZoom(fromMapLibreZoom(map.getZoom())));
    onZoom();
    map.on('zoom', onZoom);
    return () => {
      map.off('zoom', onZoom);
    };
  }, [map]);

  useEffect(() => {
    if (!map) return undefined;
    map.addSource(sourceId, { type: 'geojson', data: latestData.current });
    map.addLayer({ id, type: 'circle', source: sourceId, paint: {} }, overlaySlotId(zIndex + 1));
    return () => removeOverlay(map, id, sourceId);
  }, [id, map, sourceId, styleKey, zIndex]);

  useEffect(() => {
    (map?.getSource(sourceId) as maplibregl.GeoJSONSource | undefined)?.setData(data);
  }, [data, map, sourceId, styleKey]);

  useEffect(() => {
    if (!map?.getLayer(id)) return;
    map.setPaintProperty(id, 'circle-color', mapColor(color));
    map.setPaintProperty(id, 'circle-radius', walkDotRadius(width));
    map.setPaintProperty(id, 'circle-opacity', opacity);
  }, [color, id, map, opacity, styleKey, width, zIndex]);
  return null;
}

/** Round dots (stops), drawn on the map itself; tappable by key. */
export function MapCircles({ id, circles, zIndex = 0, onPress }: MapCirclesProps) {
  const context = useContext(MapContext);
  const sourceId = `${id}-source`;
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
  const map = context?.map;
  const styleKey = context?.styleKey;
  const latestData = useRef(data);
  useLayoutEffect(() => {
    latestData.current = data;
  });

  useEffect(() => {
    if (!map) return undefined;
    map.addSource(sourceId, { type: 'geojson', data: latestData.current });
    map.addLayer({
      id,
      type: 'circle',
      source: sourceId,
      layout: { 'circle-sort-key': ['get', 'sortKey'] },
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': ['get', 'strokeColor'],
        'circle-stroke-width': ['get', 'strokeWidth'],
        'circle-opacity': ['get', 'opacity'],
        'circle-stroke-opacity': ['get', 'opacity'],
        'circle-pitch-alignment': 'map',
      },
    }, overlaySlotId(zIndex + 1));
    return () => removeOverlay(map, id, sourceId);
  }, [id, map, sourceId, styleKey, zIndex]);

  useEffect(() => {
    (map?.getSource(sourceId) as maplibregl.GeoJSONSource | undefined)?.setData(data);
  }, [data, map, sourceId, styleKey]);

  const tapTargets = context?.tapTargets;
  useEffect(() => {
    if (!tapTargets || !onPress) return undefined;
    tapTargets.set(id, { layerId: id, onPress });
    return () => {
      tapTargets.delete(id);
    };
  }, [id, onPress, tapTargets]);
  return null;
}

/** A marker element's order, test id, label, and pointer, kept in step with its props. */
function describeMarker(element: HTMLDivElement, { accessibilityLabel, pressable, testID, zIndex }: { accessibilityLabel?: string; pressable: boolean; testID?: string; zIndex: number }) {
  element.style.zIndex = String(zIndex);
  if (testID) element.dataset.testid = testID;
  if (accessibilityLabel) element.setAttribute('aria-label', accessibilityLabel);
  element.style.cursor = pressable ? 'pointer' : '';
  if (pressable) element.setAttribute('role', 'button');
  else element.removeAttribute('role');
}

/** A view standing on the map at a point, drawn over the map's lines and dots. */
export function MapMarker({ accessibilityLabel, anchor = 'center', children, coordinate, offset, onPress, rotation, testID, zIndex = 0 }: MapMarkerProps) {
  const context = useContext(MapContext);
  const [element] = useState(() => document.createElement('div'));
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const map = context?.map;
  const latestPress = useRef(onPress);
  useLayoutEffect(() => {
    latestPress.current = onPress;
  });

  useEffect(() => {
    if (!map) return undefined;
    const marker = new maplibregl.Marker({
      element,
      anchor,
      ...(offset ? { offset } : {}),
      rotation: rotation ?? 0,
      rotationAlignment: rotation === undefined ? 'viewport' : 'map',
      pitchAlignment: 'viewport',
    }).setLngLat(lngLatOf(coordinate)).addTo(map);
    markerRef.current = marker;
    return () => {
      marker.remove();
      markerRef.current = null;
    };
    // Position, turn and offset are updated below without rebuilding the marker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, element, map]);

  useEffect(() => {
    markerRef.current?.setLngLat(lngLatOf(coordinate));
  }, [coordinate.latitude, coordinate.longitude]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by value
  useEffect(() => {
    markerRef.current?.setRotation(rotation ?? 0);
  }, [rotation]);
  useEffect(() => {
    markerRef.current?.setOffset(offset ?? [0, 0]);
  }, [offset?.[0], offset?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by value

  useEffect(() => {
    describeMarker(element, { accessibilityLabel, pressable: onPress !== undefined, testID, zIndex });
  }, [accessibilityLabel, element, onPress, testID, zIndex]);

  useEffect(() => {
    // A tap on the marker is the marker's, not the map's underneath it.
    const press = (event: Event) => {
      if (!latestPress.current) return;
      event.stopPropagation();
      if (event.type === 'click') latestPress.current();
    };
    for (const type of ['click', 'mousedown', 'touchstart', 'dblclick']) element.addEventListener(type, press);
    return () => {
      for (const type of ['click', 'mousedown', 'touchstart', 'dblclick']) element.removeEventListener(type, press);
    };
  }, [element]);

  return createPortal(children, element);
}
