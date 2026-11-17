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
