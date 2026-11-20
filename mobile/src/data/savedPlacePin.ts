import type { Location, SavedPlaceColor } from './userData';

/**
 * The home map's saved-place marker, as in Google Maps: a round badge right on the place, in the
 * place's color, with its icon centered. The web map draws the badge and icon from this SVG; the
 * native map draws the same badge from views (GoogleMapView.native.tsx).
 */

/**
 * Badge size in px, and the larger square around it that takes taps (a comfortable finger target),
 * so a pin is easy to hit even with the rider's dot drawn over it. The marker's anchor is its center.
 */
export const SAVED_PIN = { size: 30, hitSize: 44 } as const;

/** The icon's size in px inside the badge (the native badge draws it the same size). */
const ICON_SIZE = 16;

const RING_WIDTH = 2.5;

/** Marker fills for the colors a rider can pick, bright enough to stand out on the map in light and dark. */
export const SAVED_PLACE_COLOR_HEX: Record<SavedPlaceColor, string> = {
  blue: '#1A73E8',
  red: '#E53935',
  orange: '#F57C00',
  yellow: '#F2B705',
  green: '#2E9E48',
  teal: '#00897B',
  purple: '#8E44AD',
  pink: '#E0457B',
  gray: '#6B7280',
};

/** A saved place's marker fill: its picked color, else `fallback` (the brand color). */
export function savedPlaceColor(location: Location, fallback: string): string {
  return location.color ? SAVED_PLACE_COLOR_HEX[location.color] ?? fallback : fallback;
}

/**
 * The badge as an SVG data URL: a filled circle outlined in `ring`, with `icon` (path data on a
 * 256-unit square) centered in it in `iconColor`. Without an icon, the badge is empty. The image
 * is `hitSize` square with the badge in its middle, so the clear margin takes clicks too.
 */
export function savedPinSvgUrl(fill: string, ring: string, icon?: readonly string[] | null, iconColor = ring): string {
  const { size, hitSize } = SAVED_PIN;
  const c = hitSize / 2;
  const r = size / 2;
  const inset = (hitSize - ICON_SIZE) / 2;
  const glyph = icon?.length
    ? `<g transform="translate(${inset} ${inset}) scale(${ICON_SIZE / 256})" fill="${iconColor}">${icon.map((d) => `<path d="${d}"/>`).join('')}</g>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${hitSize}" height="${hitSize}" viewBox="0 0 ${hitSize} ${hitSize}">`
    + `<circle cx="${c}" cy="${c}" r="${r - RING_WIDTH / 2}" fill="${fill}" stroke="${ring}" stroke-width="${RING_WIDTH}"/>`
    + glyph
    + '</svg>';
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export type PinPoint = { latitude: number; longitude: number };
export type StackedPin = { position: PinPoint; leader: boolean };

const METERS_PER_DEGREE = 111_320;

function metersBetween(a: PinPoint, b: PinPoint): number {
  const dy = (a.latitude - b.latitude) * METERS_PER_DEGREE;
  const dx = (a.longitude - b.longitude) * METERS_PER_DEGREE * Math.cos((b.latitude * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/**
 * The pin a tap on the rider's dot should open: the nearest one whose tap area overlaps the dot
 * (`dotSize` px across) at the map's scale, or null. The dot is drawn over the pins and does
 * nothing itself, so a tap on it near a favorite means the favorite.
 */
export function savedPinUnderDot<T extends { position: PinPoint }>(pins: readonly T[], dot: PinPoint, dotSize: number, metersPerPixel: number): T | null {
  const reachMeters = ((dotSize + SAVED_PIN.hitSize) / 2) * metersPerPixel;
  let nearest: T | null = null;
  let nearestMeters = reachMeters;
  for (const pin of pins) {
    const meters = metersBetween(pin.position, dot);
    if (meters < nearestMeters) {
      nearest = pin;
      nearestMeters = meters;
    }
  }
  return nearest;
}

/** Ground meters one screen pixel covers on a Google (Web Mercator) map at `zoom`. */
export function metersPerPixelAtZoom(zoom: number, latitude: number): number {
  return (156_543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}

/** Ground meters one screen pixel covers when `longitudeDelta` degrees span `widthPixels`. */
export function metersPerPixelForSpan(longitudeDelta: number, widthPixels: number, latitude: number): number {
  return (longitudeDelta * METERS_PER_DEGREE * Math.cos((latitude * Math.PI) / 180)) / Math.max(1, widthPixels);
}

/**
 * Where to draw each pin at the map's scale: pins that would partly cover one another (closer on
 * screen than a badge is wide) are drawn at one spot, fully overlapping, so a zoomed-out cluster
 * reads as one pin rather than a tangle of rings. The first pin of each stack (in `points` order)
 * leads it: it's drawn on top, and the others' icons are left off. Zoomed in far enough to part
 * them, every pin stands at its own place again.
 */
export function stackSavedPins(points: readonly PinPoint[], metersPerPixel: number): StackedPin[] {
  const reachMeters = SAVED_PIN.size * metersPerPixel;
  const leaders: PinPoint[] = [];
  return points.map((point) => {
    const leader = leaders.find((candidate) => metersBetween(point, candidate) < reachMeters);
    if (leader) return { position: leader, leader: false };
    leaders.push(point);
    return { position: point, leader: true };
  });
}
