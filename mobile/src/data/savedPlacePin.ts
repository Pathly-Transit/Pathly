import type { Location, SavedPlaceColor } from './userData';

/**
 * The home map's saved-place marker: a round badge right on the place, in the place's color, with
 * its icon centered (drawn from views by HomeMap.tsx), and how markers stack when zoomed out.
 */

/** Badge size in px; the marker's anchor is its center. */
export const SAVED_PIN = { size: 30 } as const;

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

export type PinPoint = { latitude: number; longitude: number };
export type StackedPin = { position: PinPoint; leader: boolean };

const METERS_PER_DEGREE = 111_320;

/** Ground meters one screen pixel covers on a Web Mercator map at `zoom` (the app's 256-px scale, map/mapTypes.ts). */
export function metersPerPixelAtZoom(zoom: number, latitude: number): number {
  return (156_543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
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
    const leader = leaders.find((candidate) => {
      const dy = (point.latitude - candidate.latitude) * METERS_PER_DEGREE;
      const dx = (point.longitude - candidate.longitude) * METERS_PER_DEGREE * Math.cos((candidate.latitude * Math.PI) / 180);
      return Math.hypot(dx, dy) < reachMeters;
    });
    if (leader) return { position: leader, leader: false };
    leaders.push(point);
    return { position: point, leader: true };
  });
}
