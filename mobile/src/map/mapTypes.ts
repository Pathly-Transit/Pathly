import type { ReactElement, ReactNode } from 'react';

/**
 * The map kit every Pathly map is drawn with (MapCanvas.native.tsx on iOS and Android with
 * MapLibre Native, MapCanvas.web.tsx in the browser with MapLibre GL JS): a base map
 * (mapStyle.ts) with Pathly's own lines, dots, and view markers on it. Both renderers take the same
 * props, so each Pathly map (home, route, trip) is one component on every platform.
 */

export type MapPoint = { latitude: number; longitude: number };
export type MapPadding = { top?: number; right?: number; bottom?: number; left?: number };
export type MapBounds = { north: number; south: number; east: number; west: number };

/**
 * Zoom levels throughout the app are on the classic web-map scale (the world 256 × 2^zoom px wide),
 * which the declutter and pin-stacking thresholds (stopDeclutter.ts, savedPlacePin.ts,
 * routeDirection.ts) are written for. MapLibre counts the world 512 × 2^zoom px wide, one level
 * less for the same view; the canvas converts at its edge, so no caller deals in MapLibre's levels.
 */
export const MAPLIBRE_ZOOM_OFFSET = 1;
export const toMapLibreZoom = (zoom: number) => zoom - MAPLIBRE_ZOOM_OFFSET;
export const fromMapLibreZoom = (zoom: number) => zoom + MAPLIBRE_ZOOM_OFFSET;

export type MapCamera = { center: MapPoint; zoom: number; bearing: number; pitch: number };
/** `userInteraction`: the rider moved the map there (rather than code). */
export type MapCameraChange = MapCamera & { userInteraction: boolean };

export type EaseOptions = { center?: MapPoint; zoom?: number; bearing?: number; pitch?: number; durationMs?: number };
/** `maxZoom`: never closer than this, however close together the points are. */
export type FitOptions = { padding?: MapPadding; durationMs?: number; maxZoom?: number };

export interface MapCanvasRef {
  /** Moves the camera, animated over `durationMs` (0 jumps); what's left out stays as it is. */
  easeTo(options: EaseOptions): void;
  /** Frames the points, clear of `padding` on each side. */
  fitPoints(points: readonly MapPoint[], options?: FitOptions): void;
  /** Where the camera is now, or null before the map is ready. */
  getCamera(): Promise<MapCamera | null>;
  /** Where `point` is on the screen (window coordinates), or null before the map is ready. */
  pointForCoordinate(point: MapPoint): Promise<{ x: number; y: number } | null>;
}

/** A station or bus stop on the base map (mapStyle.ts's transit icons), as tapped. */
export type MapStop = {
  name: string;
  kind: 'bus' | 'subway' | 'rail' | 'ferry';
  coordinate: MapPoint;
};

/** A tapped feature from the base map's transit icons, or null when it isn't one. */
export function mapStopOf(feature: { properties?: Record<string, unknown> | null; geometry?: { type: string; coordinates?: unknown } | null } | undefined): MapStop | null {
  const name = feature?.properties?.name;
  const kind = feature?.properties?.kind;
  const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
  if (typeof name !== 'string' || !Array.isArray(coordinates)) return null;
  if (kind !== 'bus' && kind !== 'subway' && kind !== 'rail' && kind !== 'ferry') return null;
  return { name, kind, coordinate: { longitude: Number(coordinates[0]), latitude: Number(coordinates[1]) } };
}

export type MapCanvasProps = {
  /** Where the map opens. */
  initialCamera: { center: MapPoint; zoom: number; bearing?: number; pitch?: number };
  /**
   * The edges the map runs under the app's own controls (a header, a sheet): the camera centers and
   * frames within what's left, as if the map ended at them.
   */
  padding?: MapPadding;
  /** Pans and zooms by gesture (default true); a still map just shows its trip. */
  interactive?: boolean;
  /** Turns and tilts by gesture (default true, where the map is interactive at all). */
  rotateEnabled?: boolean;
  pitchEnabled?: boolean;
  minZoom?: number;
  /** The camera's center stays within these bounds. */
  maxBounds?: MapBounds;
  onPress?: (point: MapPoint) => void;
  onLongPress?: (point: MapPoint) => void;
  /** A tap on a station's or bus stop's icon (instead of onPress). */
  onStopPress?: (stop: MapStop) => void;
  /** The rider started moving the map (a pan, pinch, or turn). */
  onUserGesture?: () => void;
  /** The map came to rest, wherever it is. */
  onCameraIdle?: (camera: MapCameraChange) => void;
  /** The base map has loaded and the camera can be moved. */
  onReady?: () => void;
  testID?: string;
  children?: ReactNode;
};

export type MapPolylineProps = {
  /** Unique among the map's lines and dots. */
  id: string;
  coordinates: readonly MapPoint[];
  color: string;
  width: number;
  opacity?: number;
  /** Round dots along the line (walking) instead of a solid line. */
  dotted?: boolean;
  /** Higher draws over lower (0 to 7). */
  zIndex?: number;
  testID?: string;
};

export type MapCircle = {
  key: string;
  coordinate: MapPoint;
  /** Outer radius in px, ring included. */
  radius: number;
  color: string;
  strokeColor?: string;
  strokeWidth?: number;
  opacity?: number;
  /** Within one set of circles, higher draws over lower. */
  sortKey?: number;
  /** Names the circle in tests (the map draws a set of circles as one layer). */
  testID?: string;
};

export type MapCirclesProps = {
  id: string;
  circles: readonly MapCircle[];
  zIndex?: number;
  /** A circle tapped, by its key. */
  onPress?: (key: string) => void;
  testID?: string;
};

/** Which point of the marker's view sits on its coordinate (MapLibre's anchor names). */
export type MarkerAnchor = 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export type MapMarkerProps = {
  coordinate: MapPoint;
  anchor?: MarkerAnchor;
  /** Pixels to move the view from its anchor (right, down). */
  offset?: [number, number];
  /** Degrees clockwise from north: the view turns with the map, staying true to the ground. */
  rotation?: number;
  onPress?: () => void;
  /** Within the map's markers, higher draws over lower. */
  zIndex?: number;
  testID?: string;
  accessibilityLabel?: string;
  children: ReactElement;
};

/**
 * A color the map renderers all read: "#RRGGBBAA" (the app's colors with transparency, e.g.
 * routeDirection.ts's withAlpha) as rgba(), everything else as it is.
 */
export function mapColor(color: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return color;
  const [r, g, b, a] = match.slice(1).map((hex) => Number.parseInt(hex, 16)) as [number, number, number, number];
  return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
}

/** [west, south, east, north] around the points. */
export function boundsOfPoints(points: readonly MapPoint[]): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const { latitude, longitude } of points) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  return [west, south, east, north];
}

/**
 * The bounds grown, around their middle, to what a view `size` px across (less `padding`) shows at
 * `maxZoom`, so framing them never zooms in closer than that.
 */
export function boundsForMaxZoom(
  bounds: [number, number, number, number],
  maxZoom: number,
  size: { width: number; height: number },
  padding: MapPadding = {},
): [number, number, number, number] {
  const [west, south, east, north] = bounds;
  const width = Math.max(1, size.width - (padding.left ?? 0) - (padding.right ?? 0));
  const height = Math.max(1, size.height - (padding.top ?? 0) - (padding.bottom ?? 0));
  const degreesPerPx = 360 / (256 * 2 ** maxZoom);
  const middleLat = (south + north) / 2;
  const middleLon = (west + east) / 2;
  const lonSpan = Math.max(east - west, width * degreesPerPx);
  const latSpan = Math.max(north - south, height * degreesPerPx * Math.cos((middleLat * Math.PI) / 180));
  return [middleLon - lonSpan / 2, middleLat - latSpan / 2, middleLon + lonSpan / 2, middleLat + latSpan / 2];
}

/**
 * Walking dots, as on the Google map Pathly used before: round dots a fixed size, a fixed 13 px
 * apart on screen, starting at the walk's start (Google's circle symbol repeated every 13px). The
 * canvases lay them out again as the zoom changes, so they keep that look at every zoom. (A dashed
 * line's dots would stretch into ovals between zoom levels in MapLibre.)
 */
export const WALK_DOT_SPACING_PX = 13;
/** Zoom changes smaller than this keep the dots where they are. */
const WALK_DOT_ZOOM_STEP = 0.01;
const WALK_DOT_LIMIT = 20_000;

/** A walk drawn `width` wide gets dots this wide in radius (Google's: 3.5 for the 6-wide walk). */
export const walkDotRadius = (width: number) => width / 2 + 0.5;

/** Ground meters a screen pixel covers at an app zoom. */
const metersPerPx = (zoom: number, latitude: number) => (156_543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;

function distanceMeters(a: MapPoint, b: MapPoint): number {
  const dy = (b.latitude - a.latitude) * 111_320;
  const dx = (b.longitude - a.longitude) * 111_320 * Math.cos((((a.latitude + b.latitude) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** A zoom rounded to WALK_DOT_ZOOM_STEP, so the dots are laid out again only when it shows. */
export const walkDotZoom = (zoom: number) => Math.round(zoom / WALK_DOT_ZOOM_STEP) * WALK_DOT_ZOOM_STEP;

/** The dots along a walk on a map at `zoom` (the app's scale), WALK_DOT_SPACING_PX apart from its start. */
export function walkingDots(coordinates: readonly MapPoint[], zoom: number): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (coordinates.length === 0) return { type: 'FeatureCollection', features };
  const add = (point: MapPoint) => features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] } });
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) total += distanceMeters(coordinates[i - 1]!, coordinates[i]!);
  const spacing = Math.max(WALK_DOT_SPACING_PX * metersPerPx(zoom, coordinates[0]!.latitude), total / WALK_DOT_LIMIT, 0.01);
  let nextAt = 0;
  let walked = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const a = coordinates[i - 1]!;
    const b = coordinates[i]!;
    const length = distanceMeters(a, b);
    while (length > 0 && nextAt <= walked + length) {
      const t = (nextAt - walked) / length;
      add({ latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t });
      nextAt += spacing;
    }
    walked += length;
  }
  if (coordinates.length === 1) add(coordinates[0]!);
  return { type: 'FeatureCollection', features };
}

function parseHex(color: string): [number, number, number] | null {
  let hex = color.trim().replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null;
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * `color` at `alpha` over `background`, as one solid color. A faded ring on a faded line would
 * stack the two (darker where they overlap); a solid blend looks like the faded line throughout.
 */
export function fadedOver(color: string, background: string, alpha: number): string {
  const top = parseHex(color);
  const bottom = parseHex(background);
  if (!top || !bottom) return color;
  const mixed = top.map((value, i) => Math.round(value * alpha + bottom[i]! * (1 - alpha)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}
