import { createContext, useContext, useEffect, useState } from 'react';
import type { Animated } from 'react-native';

/**
 * How much of a map's bottom a sheet scrolled over it covers, in px, followed as the sheet moves.
 * Maps stay their full size (as tall as they show with the sheet at its lowest) and take this as
 * extra bottom padding instead of resizing: the camera keeps its center, so whatever the map is
 * centered on (the rider's dot, a trip's) stays centered in the part still showing.
 */
export type SheetInset = {
  get: () => number;
  subscribe: (listener: (covered: number) => void) => () => void;
};

/** Always leaves this much map above the sheet for the camera to center in. */
export const MIN_VISIBLE_MAP = 160;

export const MapSheetInsetContext = createContext<SheetInset | null>(null);

/** The covering sheet's inset, for a map inside a page that has one (null otherwise). */
export function useSheetInset(): SheetInset | null {
  return useContext(MapSheetInsetContext);
}

/** The extra bottom padding a map `height` px tall can take, already padded by `top` and `bottom`. */
export function sheetPaddingExtra(covered: number, height: number, top: number, bottom: number): number {
  if (height <= 0) return 0;
  return Math.max(0, Math.min(Math.round(covered), height - top - bottom - MIN_VISIBLE_MAP));
}

/** Mutable animation state belongs to the external store, outside React's render state. */
function createScrollInset(initialScroll: number, initialMaxCovered: number) {
  let scroll = initialScroll;
  let maxCovered = initialMaxCovered;
  const covered = () => Math.max(0, Math.round(Math.min(maxCovered, Math.max(0, scroll))));
  let value = covered();
  const listeners = new Set<(covered: number) => void>();
  const notify = () => {
    const next = covered();
    if (next === value) return;
    value = next;
    for (const listener of listeners) listener(next);
  };
  return {
    get: () => value,
    subscribe: (listener: (covered: number) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setScroll: (next: number) => { scroll = next; notify(); },
    setMaxCovered: (next: number) => { maxCovered = next; notify(); },
  };
}

/**
 * A page's sheet inset from its scroll position: the sheet covers as many px of the map as the
 * page is scrolled, up to `maxCovered`. Listeners hear whole-pixel changes only.
 */
export function useScrollSheetInset(scrollY: Animated.Value, maxCovered: number, initialScroll = 0): SheetInset {
  const [inset] = useState(() => createScrollInset(initialScroll, maxCovered));
  // A page resize changes the cap, preserving the animation's current scroll position.
  useEffect(() => { inset.setMaxCovered(maxCovered); }, [inset, maxCovered]);
  useEffect(() => {
    const id = scrollY.addListener(({ value }) => inset.setScroll(value));
    return () => scrollY.removeListener(id);
  }, [inset, scrollY]);
  return inset;
}
