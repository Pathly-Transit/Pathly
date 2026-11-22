import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
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

/**
 * A page's sheet inset from its scroll position: the sheet covers as many px of the map as the
 * page is scrolled, up to `maxCovered`. Listeners hear whole-pixel changes only.
 */
export function useScrollSheetInset(scrollY: Animated.Value, maxCovered: number, initialScroll = 0): SheetInset {
  const covered = (scroll: number) => Math.min(maxCovered, Math.max(0, scroll));
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const [state] = useState(() => ({ scroll: initialScroll, value: Math.round(covered(initialScroll)), listeners: new Set<(covered: number) => void>() }));
  const inset = useMemo<SheetInset>(() => ({
    get: () => state.value,
    subscribe: (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  }), [state]);
  const notify = () => {
    const next = Math.max(0, Math.round(coveredRef.current(state.scroll)));
    if (next === state.value) return;
    state.value = next;
    for (const listener of state.listeners) listener(next);
  };
  useEffect(() => {
    const id = scrollY.addListener(({ value }) => {
      state.scroll = value;
      notify();
    });
    return () => scrollY.removeListener(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify reads refs only
  }, [scrollY, state]);
  // The page's sizes changed (a new map height): what's covered changes with them.
  useEffect(notify);
  return inset;
}
